// What a station does with a received frame, without the audio and the
// page: parse it, reassemble Fragments, learn about keys, keep it in the
// store in the right tier, and replay the stored frames at startup. The
// GUI shows the entries this returns.
//
// Malformed frames are dropped, as SPEC.md asks: they get an entry with
// the error, for the log, but are never stored.
//
// Trust (SPEC.md, Client policy): the user trusts keys by hand; the list
// is data/trust.json. A frame is precious when it holds a post or an
// Avatar under a verified signature of a trusted key, directly or in the
// payload its Fragments reassemble to, and the station's own frames (by
// their BLAKE2s hash in data/own.json); everything else is logged. A key's
// call sign, name and avatar are learned from its verified signed Topics
// and Avatars, newest arrival first, and only shown once it is trusted.

import { parse, walk, MalformedError, T } from './records.js';
import { Reassembler } from './hydra.js';
import { blake2s } from './blake2s.js';

export const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');

// What a parsed payload says about keys, counting only what is under
// verified signatures:
//   postKeys    every key whose verified signature covers a post
//   avatarKeys  every key an Avatar is for (the innermost signer)
//   avatars     [{ key, bytes }], learned  [{ key, callSign, name }]
export function facts(nodes) {
	const out = { postKeys: new Set(), avatarKeys: new Set(), avatars: [], learned: [] };
	const keysOf = (path) => {
		if (path.some((p) => p.dropped || (p.type === T.SIGNED && p.verified !== true)))
			return null;
		return path.filter((p) => p.type === T.SIGNED).map((p) => p.key);
	};
	const avatar = (node, keys) => {
		if (!keys.length)
			return;
		const key = hex(keys[keys.length - 1]);
		out.avatarKeys.add(key);
		out.avatars.push({ key, bytes: node.body });
	};
	for (const [node, path] of walk(nodes)) {
		const keys = keysOf(path);
		if (!keys || node.dropped)
			continue;
		if (node.type === T.AVATAR) {
			avatar(node, keys);
		} else if (node.type === T.TOPIC || node.type === T.REPLY) {
			for (const k of keys)
				out.postKeys.add(hex(k));
			for (const part of node.parts)
				if (part.type === T.AVATAR)
					avatar(part, keys);
			if (node.type === T.TOPIC && keys.length) {
				const learned = { key: hex(keys[keys.length - 1]), callSign: null, name: null };
				for (const p of node.chain) {
					if (p.type === T.FROM_CALL)
						learned.callSign = p.handle;
					if (p.type === T.FROM_NAME)
						learned.name = p.handle;
				}
				if (learned.callSign || learned.name)
					out.learned.push(learned);
			}
		}
	}
	return out;
}

// crypto and hydra are optional: without them Signed records and
// Fragments are parsed but stay unverified, nothing is reassembled and
// nothing is precious
export async function openStation({ store, crypto = null, hydra = null }) {
	const reassembler = hydra && new Reassembler(hydra);
	const opts = {
		verify: crypto ? crypto.verify : null,
		verifyBlock: hydra ? hydra.verifyBlock : null,
	};
	const trustData = await store.getData('trust') ?? {};
	const trusted = new Set(trustData.trusted ?? []);
	const own = new Set((await store.getData('own'))?.frames ?? []);
	const saveOwn = () => store.putData('own', { frames: [...own].sort() });

	// key hex -> { key, callSign, name, avatar, avatarFrame, arrival }
	const keys = new Map();
	// frame name -> entry; fragment set -> { names, facts of its payload }
	const frames = new Map();
	const sets = new Map();
	const all = [];

	const keyOf = (k) => {
		if (!keys.has(k))
			keys.set(k, { key: k, callSign: null, name: null, avatar: null, avatarFrame: null, avatarArrival: -1 });
		return keys.get(k);
	};

	// { nodes, used } for a payload, or { error, offset }; used is where the
	// records end and the zero padding starts
	const analyze = (bytes, reassembled = false) => {
		try {
			const nodes = parse(bytes, { ...opts, reassembled });
			return { nodes, used: nodes.length ? nodes[nodes.length - 1].end : 0 };
		} catch (e) {
			if (!(e instanceof MalformedError))
				throw e;
			return { error: e.message, offset: e.offset ?? null };
		}
	};

	// hand the frame's verified Fragments to the reassembler; returns what
	// became of each set and the payloads decoded from them, parsed
	const reassemble = (nodes) => {
		const out = [];
		if (!reassembler)
			return out;
		for (const [node] of walk(nodes)) {
			if (node.type !== T.FRAGMENT || node.verified !== true)
				continue;
			const r = reassembler.add(node.block);
			if (!r)
				continue;
			if (r.payload) {
				const a = analyze(r.payload, true);
				out.push({ key: r.key, size: r.payload.length, ...a, facts: a.nodes ? facts(a.nodes) : null });
			} else {
				out.push(r);
			}
		}
		return out;
	};

	const learn = (e) => {
		for (const f of [e.facts, ...e.fragments.map((f) => f.facts)].filter(Boolean)) {
			for (const l of f.learned) {
				const k = keyOf(l.key);
				if (l.callSign)
					k.callSign = l.callSign;
				if (l.name)
					k.name = l.name;
			}
			for (const a of f.avatars) {
				const k = keyOf(a.key);
				if (e.arrival >= k.avatarArrival) {
					k.avatar = a.bytes;
					k.avatarArrival = e.arrival;
					// a reassembled avatar lives in several frames; the
					// last one is renewed
					k.avatarFrame = e.name;
				}
			}
		}
	};

	// remember a stored frame and the fragment sets it belongs to
	const register = (e) => {
		if (!e.name)
			return;
		frames.set(e.name, e);
		for (const f of e.fragments) {
			if (!sets.has(f.key))
				sets.set(f.key, { names: new Set(), facts: null });
			const s = sets.get(f.key);
			s.names.add(e.name);
			if (f.facts)
				s.facts = f.facts;
		}
	};

	// the keys that make a frame precious, its sets' payloads included
	const keysIn = (e) => {
		const out = new Set();
		const add = (f) => {
			if (f) {
				f.postKeys.forEach((k) => out.add(k));
				f.avatarKeys.forEach((k) => out.add(k));
			}
		};
		add(e.facts);
		for (const s of sets.values())
			if (s.names.has(e.name))
				add(s.facts);
		return out;
	};
	const precious = (e) => own.has(e.hash) || [...keysIn(e)].some((k) => trusted.has(k));

	const rename = (e, name) => {
		frames.delete(e.name);
		for (const s of sets.values())
			if (s.names.delete(e.name))
				s.names.add(name);
		for (const k of keys.values())
			if (k.avatarFrame === e.name)
				k.avatarFrame = name;
		e.name = name;
		frames.set(name, e);
	};

	// move every frame to the tier it belongs in; returns how many moved
	const retier = async () => {
		let moved = 0;
		for (const e of [...frames.values()]) {
			const want = precious(e) ? 'precious' : 'logged';
			if (e.tier === want)
				continue;
			const ok = await (want === 'precious' ? store.promote(e.name) : store.demote(e.name));
			++moved;
			e.tier = ok ? want : null;
			if (!ok)
				frames.delete(e.name);
		}
		// the target tier may have evicted others
		const left = new Set((await store.frames()).map((f) => f.name));
		for (const [name, e] of frames)
			if (!left.has(name)) {
				e.tier = null;
				frames.delete(name);
			}
		return moved;
	};

	const entry = (bytes, meta) => {
		const a = analyze(bytes);
		const hash = hex(blake2s(bytes));
		return {
			...meta,
			hash,
			sent: own.has(hash),
			size: bytes.length,
			...a,
			facts: a.nodes ? facts(a.nodes) : null,
			fragments: a.nodes ? reassemble(a.nodes) : [],
		};
	};

	// A frame just received: { arrival, callSign, mode } as the preamble
	// said, plus whatever else the caller wants in the entry (snr,
	// bitFlips). Returns the entry; name is null if it wasn't stored.
	const receive = async (bytes, { arrival = Date.now(), callSign = null, mode = null, ...extra } = {}) => {
		const e = entry(bytes, { ...extra, arrival, callSign, mode, name: null, tier: null });
		all.push(e);
		if (e.error)
			return e;
		// each new post renews the frame of its key's current avatar
		for (const k of e.facts.postKeys) {
			const info = keys.get(k);
			if (info?.avatarFrame && frames.has(info.avatarFrame)) {
				const fresh = await store.touch(info.avatarFrame);
				if (fresh)
					rename(frames.get(info.avatarFrame), fresh);
			}
		}
		const tier = precious({ ...e, name: null }) ? 'precious' : 'logged';
		e.name = await store.addFrame(bytes, { tier, arrival, callSign, mode });
		e.tier = e.name && tier;
		register(e);
		learn(e);
		// a reassembled payload may lift the frames of its set
		if (e.fragments.some((f) => f.facts))
			await retier();
		return e;
	};

	// A frame this station sent: stored as sent, in the precious tier, and
	// marked as its own so it stays there. Returns the entry.
	const sent = async (bytes, { arrival = Date.now(), callSign = null, mode = null } = {}) => {
		const e = entry(bytes, { arrival, callSign, mode, name: null, tier: null });
		all.push(e);
		if (e.error)
			return e;
		own.add(e.hash);
		e.sent = true;
		await saveOwn();
		e.name = await store.addFrame(bytes, { tier: 'precious', arrival, callSign, mode });
		e.tier = e.name && 'precious';
		register(e);
		learn(e);
		return e;
	};

	// The entries of all stored frames, oldest arrival first, reassembling
	// and learning as they come; frames are then moved to the tier the
	// current trust list puts them in (it may come from an import)
	const replay = async () => {
		for (const f of await store.frames()) {
			const bytes = await store.readFrame(f.name);
			if (!bytes)
				continue;
			const e = entry(bytes, { name: f.name, tier: f.tier, arrival: f.arrival, callSign: f.callSign, mode: f.mode });
			all.push(e);
			register(e);
			learn(e);
		}
		await retier();
		// forget own frames that were evicted
		const kept = new Set(all.map((e) => e.hash));
		if ([...own].some((h) => !kept.has(h))) {
			for (const h of [...own])
				if (!kept.has(h))
					own.delete(h);
			await saveOwn();
		}
		return all;
	};

	// Trust or stop trusting a key (hex); moves its frames. Returns how
	// many frames moved.
	const setTrust = async (key, on) => {
		if (on)
			trusted.add(key);
		else
			trusted.delete(key);
		const now = await store.getData('trust') ?? {};
		await store.putData('trust', { ...now, trusted: [...trusted].sort() });
		return retier();
	};

	// what the station knows about a key (hex)
	const keyInfo = (key) => ({ ...(keys.get(key) ?? { key, callSign: null, name: null, avatar: null }), trusted: trusted.has(key) });

	// sets of Fragments still waiting for blocks
	const waiting = () => reassembler ? reassembler.missing() : [];

	return { analyze, receive, sent, replay, waiting, entries: () => all, keyInfo, setTrust, isTrusted: (k) => trusted.has(k) };
}
