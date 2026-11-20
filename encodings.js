// Encoders for every text encoding of SPEC.md, and picking the smallest.
// TextDecoder decodes them all but nothing encodes them, so each encoder is
// built from its decoder the first time it is needed, by decoding every
// byte sequence. An encoding this client's TextDecoder lacks is never used.
// U+FEFF is text here, not a byte order mark: UTF-16LE, the one table
// encoding with a byte order mark, decodes with ignoreBOM.

import { TEXT_TABLE, SCSU_MAX, textUTF8, textGB18030, textTable, textSCSU } from './records.js';
import { encode as scsuEncode } from './scsu.js';

const encoders = new Map();

function decoder(label) {
	try {
		return new TextDecoder(label, { fatal: true, ignoreBOM: label === 'UTF-16LE' });
	} catch {
		return null;
	}
}

// code point -> bytes, from single bytes and then pairs, the first found
// wins; the fatal decoder leaves out what isn't a whole character
function buildMultiByte(label, pairs) {
	const dec = decoder(label);
	if (!dec)
		return null;
	const map = new Map();
	const add = (bytes) => {
		let s;
		try {
			s = dec.decode(bytes);
		} catch {
			return;
		}
		const cp = s.codePointAt(0);
		if (s.length === (cp > 0xFFFF ? 2 : 1) && !map.has(cp))
			map.set(cp, bytes);
	};
	for (let a = 0; a < 0x100; ++a)
		add(Uint8Array.of(a));
	for (const [leads, trails] of pairs)
		for (const a of leads)
			for (const b of trails)
				add(Uint8Array.of(a, b));
	return map;
}

const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

// GB 18030: ASCII, the two-byte table, then the four-byte sequences, which
// cover all the rest of Unicode; decoded in one go and kept in an array
function buildGB18030() {
	const map = buildMultiByte('gb18030', [[range(0x81, 0xFE), [...range(0x40, 0x7E), ...range(0x80, 0xFE)]]]);
	if (!map)
		return null;
	const four = new Uint32Array(0x110000);
	const n = 126 * 10 * 126 * 10;
	const buf = new Uint8Array(4 * n);
	let k = 0;
	for (let a = 0x81; a <= 0xFE; ++a)
		for (let b = 0x30; b <= 0x39; ++b)
			for (let c = 0x81; c <= 0xFE; ++c)
				for (let d = 0x30; d <= 0x39; ++d) {
					buf[k++] = a;
					buf[k++] = b;
					buf[k++] = c;
					buf[k++] = d;
				}
	// unassigned sequences decode to U+FFFD, so the real U+FFFD is found
	// by asking the fatal decoder about those
	const fatal = new TextDecoder('gb18030', { fatal: true });
	const text = new TextDecoder('gb18030').decode(buf);
	let i = 0;
	for (const ch of text) {
		let cp = ch.codePointAt(0);
		if (cp === 0xFFFD && !four[cp]) {
			try {
				fatal.decode(buf.subarray(i, i + 4));
			} catch {
				cp = 0;
			}
		}
		if (cp && !map.has(cp) && !four[cp])
			four[cp] = (buf[i] << 24 | buf[i + 1] << 16 | buf[i + 2] << 8 | buf[i + 3]) >>> 0;
		i += 4;
	}
	return (cp) => {
		const short = map.get(cp);
		if (short)
			return short;
		const v = four[cp];
		return v ? Uint8Array.of(v >>> 24, v >>> 16 & 255, v >>> 8 & 255, v & 255) : null;
	};
}

const PAIRS = {
	'Big5': [[range(0x81, 0xFE), [...range(0x40, 0x7E), ...range(0xA1, 0xFE)]]],
	'EUC-JP': [[range(0xA1, 0xFE), range(0xA1, 0xFE)], [[0x8E], range(0xA1, 0xDF)]],
	'Shift_JIS': [[[...range(0x81, 0x9F), ...range(0xE0, 0xFC)], [...range(0x40, 0x7E), ...range(0x80, 0xFC)]]],
	'EUC-KR': [[range(0x81, 0xFE), range(0x41, 0xFE)]],
};

function build(label) {
	if (label === 'gb18030')
		return buildGB18030();
	if (label === 'UTF-16LE')
		return decoder(label) ? 'utf16' : null;
	const map = buildMultiByte(label, PAIRS[label] ?? []);
	return map && ((cp) => map.get(cp) ?? null);
}

function encoderOf(label) {
	if (!encoders.has(label))
		encoders.set(label, build(label));
	return encoders.get(label);
}

// The bytes of str in the encoding of a TextDecoder label from the table or
// 'gb18030', or null if the encoding can't carry it or this client lacks it.
// Every result decodes back to str.
export function encode(str, label) {
	const enc = encoderOf(label);
	if (!enc)
		return null;
	let out;
	if (enc === 'utf16') {
		out = new Uint8Array(2 * str.length);
		for (let i = 0; i < str.length; ++i) {
			const u = str.charCodeAt(i);
			out[2 * i] = u & 255;
			out[2 * i + 1] = u >> 8;
		}
	} else {
		const parts = [];
		let n = 0;
		for (const ch of str) {
			const bytes = enc(ch.codePointAt(0));
			if (!bytes)
				return null;
			parts.push(bytes);
			n += bytes.length;
		}
		out = new Uint8Array(n);
		let pos = 0;
		for (const p of parts) {
			out.set(p, pos);
			pos += p.length;
		}
	}
	let back;
	try {
		back = new TextDecoder(label, { fatal: true, ignoreBOM: label === 'UTF-16LE' }).decode(out);
	} catch {
		return null;
	}
	return back === str ? out : null;
}

// Every text record that carries str, smallest first. Ties keep the order
// UTF-8, SCSU, GB 18030, then the table in index order, so UTF-8 wins a tie.
export function textRecords(str) {
	const found = [textUTF8(str)];
	const packed = scsuEncode(str);
	if (packed && packed.length <= SCSU_MAX)
		found.push(textSCSU(packed));
	const gb = encode(str, 'gb18030');
	if (gb)
		found.push(textGB18030(gb));
	TEXT_TABLE.forEach((label, index) => {
		const bytes = encode(str, label);
		if (bytes)
			found.push(textTable(index, bytes));
	});
	// a stable sort keeps the order of ties
	return found.sort((a, b) => a.length - b.length);
}

// The smallest text record for str, as SPEC.md asks senders to pick
export function smallestText(str) {
	return textRecords(str)[0];
}

