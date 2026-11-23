// Sending: a post as records, in one frame or split into Fragments, and
// all its frames chained into one seamless transmission. Frames use only
// modes that decode at the SNR the user asks for, within the seconds per
// frame. The modem's leading noise only opens VOX and squelches before
// the sync symbols arrive, so a chain keeps it only on its first frame.

import * as R from './records.js';
import { smallestText } from './encodings.js';
import { PAYLOAD_MAX, SECONDS_MAX } from './robusto.js';

export const SECONDS_DEFAULT = 5;
export const SNR_DEFAULT = 10;
export const REDUNDANCY_DEFAULT = 0.25;

// The SNR in dB at which half of the frames of each efficiency index (the
// mode & 31) decode, from QPSK 3/16 to QAM256 15/16: the thresholds of the
// modem's README, an awgn level of -1.0 being 1.0 dB. The BPSK modes,
// 26 to 31, are only for bad channels and never picked here.
export const THRESHOLDS = Object.freeze([
	1.0, 1.9, 2.8, 3.6, 4.8, 5.5, 6.2, 7.6, 8.3,
	9.1, 9.8, 10.8, 11.7, 12.6, 13.4, 14.6, 15.8,
	17.7, 18.8, 20.1, 21.5,
	22.2, 23.7, 25.2, 26.8, 28.9,
]);
export const needs = (mode) => THRESHOLDS[mode & 31];

// The payload of a post, its texts in their smallest encoding:
//   kind 'topic'    subject and text
//   kind 'reply'    parent (32-byte post ID) and text
//   kind 'message'  text alone, a bare message
// parts, records made by attachment(), follow the text; with them the text
// may be left out.
// Each carries From-Call and From-Name when given; a Reply goes where its
// parent is, so it never carries To prefixes (SPEC.md). sign(...records), as keys.js gives it,
// wraps the records in one Signed record; without it the post is unsigned,
// as sensors and experiments send them.
//
// A Topic goes where to sends it (SPEC.md, Where a post goes), or to
// everyone without it: { call } a call sign, { name } a name, { key } a
// 32-byte key, { group } a group name, a board.
//
// avatar, WebP bytes, goes beside the post as a bare Avatar record, inside
// the same Signed record, so the post and its ID stay as they are.
export function compose({ kind, subject = '', text = '', parent = null, callSign = null, name = null, to = null, timestamp = Math.floor(Date.now() / 1000), sign = null, avatar = null, parts = [] }) {
	const records = post({ kind, subject, text, parent, callSign, name, to, timestamp, parts });
	if (avatar)
		records.push(R.avatar(avatar));
	return R.payload(sign ? [sign(...records)] : records);
}

// An Avatar for the signing key, with From-Call and From-Name when given,
// as a bare record inside one Signed record (SPEC.md: sent now and then,
// not with every post)
export function composeAvatar({ avatar, callSign = null, name = null, sign }) {
	if (!sign)
		throw new RangeError('an avatar needs a key to belong to');
	const from = [];
	if (callSign)
		from.push(R.fromCall(callSign));
	if (name)
		from.push(R.fromName(smallestText(name)));
	return R.payload([sign(...from, R.avatar(avatar))]);
}

// Several posts of one key, collected before sending, in one Signed
// record: From-Call and From-Name once in front of a Bundle of them
// (SPEC.md, Prefixes and handles) and the Avatar once among them. Each post
// keeps its own timestamp and its record is the same as alone, so its ID
// is the one it would have in a frame of its own. posts are what compose()
// takes, without the key's call sign, name and avatar. Returns the Signed
// record; several of them, one per key, share a payload.
export function bundled({ posts, callSign = null, name = null, avatar = null, sign }) {
	if (!sign)
		throw new RangeError('a bundle is signed');
	if (!posts.length)
		throw new RangeError('a bundle needs posts');
	const from = [];
	if (callSign)
		from.push(R.fromCall(callSign));
	if (name)
		from.push(R.fromName(smallestText(name)));
	const inner = [];
	for (const p of posts)
		inner.push(...post({ ...p, callSign: null, name: null }));
	if (avatar)
		inner.push(R.avatar(avatar));
	// prefixes apply to the next record only, so more than one post under
	// them goes in a Bundle
	const children = posts.length + (avatar ? 1 : 0);
	return sign(...from, ...(from.length && children > 1 ? [R.bundle(...inner)] : inner));
}

// Files attached to a post (SPEC.md, Client policy: up to four, at most
// 1 MiB in all)
export const FILES_MAX = 4;
export const FILES_MAX_BYTES = 1 << 20;

// A file as a post part, by its content: a WebP file as WebP, a .c2 file
// as Codec2 (its 7-byte header gone, the mode byte kept), anything else as
// a MIME escape with its type and file name, both made valid
export function attachment(bytes, { type = '', name = '' } = {}) {
	if (R.webpSize(bytes))
		return R.webp(bytes);
	if (isCodec2File(bytes))
		return R.codec2(bytes[5], bytes.subarray(7));
	return R.mime(mimeType(type), fileName(name), bytes);
}

// magic C0 DE C2, version, mode, flags
export const isCodec2File = (b) => b.length >= 7 && b[0] === 0xC0 && b[1] === 0xDE && b[2] === 0xC2;

// a content type as a MIME escape takes it: type/subtype only, lowercase,
// otherwise application/octet-stream
export function mimeType(type) {
	const t = type.split(';')[0].trim().toLowerCase();
	return /^[a-z0-9!#$&\-^_.+]{1,127}\/[a-z0-9!#$&\-^_.+]{1,127}$/.test(t) ? t : 'application/octet-stream';
}

// a file name as a MIME escape takes it: lowercase a-z, digits, ".", "-"
// and "_", at most 64 characters, not starting with "." and without "..";
// accents dropped, spaces and anything else made "-", the extension kept
// when it has to be shortened; empty if nothing is left
export function fileName(name) {
	let n = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-').replace(/-*\.[-.]*/g, '.').replace(/^[.-]+/, '').replace(/[.-]+$/, '');
	if (n.length > 64) {
		const dot = n.lastIndexOf('.');
		const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : '';
		n = n.slice(0, 64 - ext.length).replace(/[.-]+$/, '') + ext;
	}
	return n;
}

function address(to) {
	if (!to)
		return [];
	if (to.call)
		return [R.toCall(to.call)];
	if (to.name)
		return [R.toName(smallestText(to.name))];
	if (to.key)
		return [R.toKey(to.key)];
	if (to.group)
		return [R.toGroupName(smallestText(to.group))];
	throw new RangeError('an address is a call sign, a name, a key or a group name');
}

function post({ kind, subject, text, parent, callSign, name, to, timestamp, parts = [] }) {
	if (!text && !parts.length)
		throw new RangeError('a post needs text or a file');
	// the text first, then the files
	const body = [...(text ? [smallestText(text)] : []), ...parts];
	const from = [];
	if (callSign)
		from.push(R.fromCall(callSign));
	if (name)
		from.push(R.fromName(smallestText(name)));
	switch (kind) {
	case 'topic':
		if (!subject)
			throw new RangeError('a Topic needs a subject');
		return [...from, ...address(to), R.topic(timestamp, smallestText(subject), ...body)];
	case 'reply':
		if (to)
			throw new RangeError('a Reply goes where its parent is, never to an address');
		if (!(parent instanceof Uint8Array) || parent.length !== 32)
			throw new RangeError('a Reply needs the 32-byte ID of its parent');
		return [...from, R.reply(timestamp, parent, ...body)];
	case 'message':
		return [...from, ...address(to), ...body];
	}
	throw new RangeError(`unknown kind of post: ${kind}`);
}

// The mode for a frame of length bytes: the most robust one that carries it
// in at most seconds, if it decodes at snr dB, otherwise null
export function pick(encoder, length, { seconds = SECONDS_DEFAULT, snr = SNR_DEFAULT } = {}) {
	const mode = encoder.pickMode(length, seconds);
	return mode !== null && needs(mode) <= snr ? mode : null;
}

// the largest payload one frame carries in at most seconds at snr dB
export function frameCapacity(encoder, opts = {}) {
	let lo = 0, hi = PAYLOAD_MAX;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (pick(encoder, mid, opts) === null)
			hi = mid - 1;
		else
			lo = mid;
	}
	return lo;
}

// Fill the room left in frames with extra records (Uint8Arrays), in their
// order, without making any frame longer on the air: a frame keeps the mode
// it needs anyway, whose payload is padded with zeros to its size, so the
// extras only take the place of padding. Returns { frames, used }, used[i]
// being the indices of the extras frame i carries.
export function fill(encoder, frames, extras, opts = {}) {
	let next = 0;
	const used = [];
	const out = frames.map((f) => {
		const mode = pick(encoder, f.length, opts);
		let room = mode === null ? 0 : encoder.modeInfo(mode).payload - f.length;
		const take = [];
		while (next < extras.length && extras[next].length <= room) {
			room -= extras[next].length;
			take.push(next++);
		}
		used.push(take);
		return take.length ? R.payload([f, ...take.map((i) => extras[i])]) : f;
	});
	return { frames: out, used };
}

// Records packed into as few frames as hold them, in order, each frame as
// full as fits within the seconds and SNR; a record too big for a frame of
// its own is left out. Returns { frames, used } as fill() does.
export function pack(encoder, records, opts = {}) {
	const cap = frameCapacity(encoder, opts);
	const frames = [], used = [];
	let take = [], size = 0;
	const flush = () => {
		if (take.length) {
			frames.push(R.payload(take.map((i) => records[i])));
			used.push(take);
		}
		take = [];
		size = 0;
	};
	records.forEach((r, i) => {
		if (r.length > cap)
			return;
		if (size + r.length > cap)
			flush();
		take.push(i);
		size += r.length;
	});
	flush();
	return { frames, used };
}

// the fewest seconds for one frame of length bytes at snr dB, or null if
// not even the longest frame carries it
export function secondsFor(encoder, length, snr = SNR_DEFAULT) {
	for (let seconds = 1; seconds <= SECONDS_MAX; ++seconds)
		if (pick(encoder, length, { seconds, snr }) !== null)
			return seconds;
	return null;
}

// The frames that carry a payload: itself if it fits in one frame,
// otherwise one Fragment each, K of them needed and redundancy more (at
// least one more, at most N). Returns { frames, K }.
export function split(payload, { encoder, hydra, seconds = SECONDS_DEFAULT, snr = SNR_DEFAULT, redundancy = REDUNDANCY_DEFAULT }) {
	const capacity = frameCapacity(encoder, { seconds, snr });
	if (!capacity)
		throw new RangeError(`no mode decodes at ${snr} dB`);
	if (payload.length <= capacity)
		return { frames: [payload], K: 1 };
	if (!hydra)
		throw new RangeError(`${payload.length} bytes need Fragments, and HYDRA isn't loaded`);
	// a Fragment record adds its type and a length of up to 4 bytes
	const budget = Math.min(R.FRAGMENT_MAX, capacity - 5);
	if (!hydra.plan(payload.length, budget))
		throw new RangeError(`${payload.length} bytes don't split into blocks of ${budget} bytes`);
	const enc = hydra.encode(payload, { budget });
	const count = Math.min(enc.N, Math.max(enc.K + 1, Math.ceil(enc.K * (1 + redundancy))));
	const frames = [];
	for (let i = 0; i < count; ++i)
		frames.push(R.payload([enc.fragment(i)]));
	return { frames, K: enc.K };
}

// What split() would make of a payload of length bytes, without making it:
// { lengths, K }, the length of each frame. Planning is quick, encoding a
// large payload takes seconds, so estimates use this.
export function sizes(length, { encoder, hydra, seconds = SECONDS_DEFAULT, snr = SNR_DEFAULT, redundancy = REDUNDANCY_DEFAULT }) {
	const capacity = frameCapacity(encoder, { seconds, snr });
	if (!capacity)
		throw new RangeError(`no mode decodes at ${snr} dB`);
	if (length <= capacity)
		return { lengths: [length], K: 1 };
	if (!hydra)
		throw new RangeError(`${length} bytes need Fragments, and HYDRA isn't loaded`);
	const budget = Math.min(R.FRAGMENT_MAX, capacity - 5);
	const p = hydra.plan(length, budget);
	if (!p)
		throw new RangeError(`${length} bytes don't split into blocks of ${budget} bytes`);
	const count = Math.min(p.N, Math.max(p.K + 1, Math.ceil(p.K * (1 + redundancy))));
	// a Fragment record: its type, its length, the block
	const frame = 1 + R.encodeLength(p.blen).length + p.blen;
	return { lengths: new Array(count).fill(frame), K: p.K };
}

// The audio of frames chained back to back, each in the most robust mode
// that fits seconds and decodes at snr dB, every one but the first without
// its leading noise symbol; the first has lead symbols of it, for a VOX
// that needs longer to key. Returns { audio, modes, seconds }.
export function chain(encoder, frames, opts = {}) {
	const parts = [...chainParts(encoder, frames, opts)];
	const audio = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (const p of parts) {
		audio.set(p, pos);
		pos += p.length;
	}
	return { audio, modes: chainModes(encoder, frames, opts), seconds: audio.length / encoder.rate };
}

// The modes chain() uses for frames, checking that each fits
export function chainModes(encoder, frames, { seconds = SECONDS_DEFAULT, snr = SNR_DEFAULT } = {}) {
	return frames.map((frame) => {
		const mode = pick(encoder, frame.length, { seconds, snr });
		if (mode === null)
			throw new RangeError(`a frame of ${frame.length} bytes doesn't fit in ${seconds} seconds at ${snr} dB`);
		return mode;
	});
}

// The same audio as chain(), one frame at a time, each made only when it
// is asked for: a long transmission is played as it is made, never held
// whole (1 MiB in fragments is about an hour, 650 MB of samples)
export function* chainParts(encoder, frames, { seconds = SECONDS_DEFAULT, snr = SNR_DEFAULT, callSign = 'ANONYMOUS', lead = 1 } = {}) {
	// a symbol and its guard interval: 41 / 300 seconds
	const noise = encoder.rate / 300 * 41;
	const modes = chainModes(encoder, frames, { seconds, snr });
	for (const [i, frame] of frames.entries()) {
		const audio = encoder.encode(frame, { mode: modes[i], callSign, lead: i ? 1 : lead });
		yield i ? audio.subarray(noise) : audio;
	}
}

// How long frames of these lengths take on the air when chained
export function airtime(encoder, lengths, opts = {}) {
	// fragments mostly share one length, so each length is looked up once
	const seconds = new Map();
	const of = (n) => {
		if (!seconds.has(n))
			seconds.set(n, encoder.modeInfo(pick(encoder, n, opts)).seconds);
		return seconds.get(n);
	};
	const each = lengths.map(of);
	return each.reduce((a, b) => a + b, 0) + ((opts.lead ?? 1) - lengths.length) * 41 / 300;
}
