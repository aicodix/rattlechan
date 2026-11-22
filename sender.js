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
export function compose({ kind, subject = '', text = '', parent = null, callSign = null, name = null, to = null, timestamp = Math.floor(Date.now() / 1000), sign = null, avatar = null }) {
	const records = post({ kind, subject, text, parent, callSign, name, to, timestamp });
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

function post({ kind, subject, text, parent, callSign, name, to, timestamp }) {
	if (!text)
		throw new RangeError('a post needs text');
	const from = [];
	if (callSign)
		from.push(R.fromCall(callSign));
	if (name)
		from.push(R.fromName(smallestText(name)));
	switch (kind) {
	case 'topic':
		if (!subject)
			throw new RangeError('a Topic needs a subject');
		return [...from, ...address(to), R.topic(timestamp, smallestText(subject), smallestText(text))];
	case 'reply':
		if (to)
			throw new RangeError('a Reply goes where its parent is, never to an address');
		if (!(parent instanceof Uint8Array) || parent.length !== 32)
			throw new RangeError('a Reply needs the 32-byte ID of its parent');
		return [...from, R.reply(timestamp, parent, smallestText(text))];
	case 'message':
		return [...from, ...address(to), smallestText(text)];
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

// The audio of frames chained back to back, each in the most robust mode
// that fits seconds and decodes at snr dB, every one but the first without
// its leading noise symbol; the first has lead symbols of it, for a VOX
// that needs longer to key. Returns { audio, modes, seconds }.
export function chain(encoder, frames, { seconds = SECONDS_DEFAULT, snr = SNR_DEFAULT, callSign = 'ANONYMOUS', lead = 1 } = {}) {
	// a symbol and its guard interval: 41 / 300 seconds
	const noise = encoder.rate / 300 * 41;
	const parts = [];
	const modes = [];
	for (const [i, frame] of frames.entries()) {
		const mode = pick(encoder, frame.length, { seconds, snr });
		if (mode === null)
			throw new RangeError(`a frame of ${frame.length} bytes doesn't fit in ${seconds} seconds at ${snr} dB`);
		const audio = encoder.encode(frame, { mode, callSign, lead: i ? 1 : lead });
		parts.push(i ? audio.subarray(noise) : audio);
		modes.push(mode);
	}
	const audio = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (const p of parts) {
		audio.set(p, pos);
		pos += p.length;
	}
	return { audio, modes, seconds: audio.length / encoder.rate };
}

// About seconds of the modem's leading noise, at the level of its signal,
// for setting a radio's input: no call sign, nothing to decode. The modem
// continues the noise sequence, so its symbols differ, and fades it in
// and out like a frame.
export const testNoise = (encoder, seconds = 2) => encoder.noise(Math.max(1, Math.round(seconds / encoder.NOISE_SYMBOL)));

// How long frames of these lengths take on the air when chained
export function airtime(encoder, lengths, opts = {}) {
	const each = lengths.map((n) => encoder.modeInfo(pick(encoder, n, opts)).seconds);
	return each.reduce((a, b) => a + b, 0) + ((opts.lead ?? 1) - lengths.length) * 41 / 300;
}
