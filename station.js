// What a station does with a received frame, without the audio and the
// page: parse it, reassemble Fragments, keep it in the store, and replay
// the stored frames at startup. The GUI shows the entries this returns.
//
// Malformed frames are dropped, as SPEC.md asks: they get an entry with
// the error, for the log, but are never stored. Everything else goes to
// the logged tier for now; which frames are precious needs trust lists,
// which come with keys.

import { parse, walk, MalformedError, T } from './records.js';
import { Reassembler } from './hydra.js';

// crypto and hydra are optional: without them Signed records and
// Fragments are parsed but stay unverified, and nothing is reassembled
export function openStation({ store, crypto = null, hydra = null }) {
	const reassembler = hydra && new Reassembler(hydra);
	const opts = {
		verify: crypto ? crypto.verify : null,
		verifyBlock: hydra ? hydra.verifyBlock : null,
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
			if (r.payload)
				out.push({ key: r.key, size: r.payload.length, ...analyze(r.payload, true) });
			else
				out.push(r);
		}
		return out;
	};

	const entry = (bytes, meta) => {
		const a = analyze(bytes);
		return {
			...meta,
			size: bytes.length,
			...a,
			fragments: a.nodes ? reassemble(a.nodes) : [],
		};
	};

	// A frame just received: { arrival, callSign, mode } as the preamble
	// said, plus whatever else the caller wants in the entry (snr,
	// bitFlips). Returns the entry; name is null if it wasn't stored.
	const receive = async (bytes, { arrival = Date.now(), callSign = null, mode = null, ...extra } = {}) => {
		const e = entry(bytes, { ...extra, arrival, callSign, mode, name: null, tier: null });
		if (!e.error) {
			e.name = await store.addFrame(bytes, { tier: 'logged', arrival, callSign, mode });
			e.tier = e.name && 'logged';
		}
		return e;
	};

	// The entries of all stored frames, oldest arrival first, reassembling
	// as they come
	const replay = async () => {
		const out = [];
		for (const f of await store.frames()) {
			const bytes = await store.readFrame(f.name);
			if (bytes)
				out.push(entry(bytes, { name: f.name, tier: f.tier, arrival: f.arrival, callSign: f.callSign, mode: f.mode }));
		}
		return out;
	};

	// sets of Fragments still waiting for blocks
	const waiting = () => reassembler ? reassembler.missing() : [];

	return { analyze, receive, replay, waiting };
}
