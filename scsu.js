// Glue for the SCSU WebAssembly module (scsu.wasm, copied as it is from
// https://github.com/xdsopl/scsu): the Standard Compression Scheme for
// Unicode (UTS #6), about one byte per character for alphabetic scripts and
// about two for CJK, covering all of Unicode.

import { SCSU_MAX, textUTF8, textSCSU } from './records.js';
import { instantiate } from './wasm.js';

// neither direction expands by more than a factor of four
const BUF_MAX = 1 << 22;

// source as for instantiate() in wasm.js. Without one, scsu.wasm is fetched
// from next to this file, as a browser or PWA does.
export async function loadScsu(source = new URL('./scsu.wasm', import.meta.url)) {
	const wasm = await instantiate(source);
	const textBuf = new Uint8Array(wasm.memory.buffer, wasm.text.value, BUF_MAX);
	const scsuBuf = new Uint8Array(wasm.memory.buffer, wasm.scsu.value, BUF_MAX);
	const utf8 = new TextEncoder();
	const strict = new TextDecoder('utf-8', { fatal: true });

	// a string to SCSU bytes; lone surrogates become U+FFFD as in UTF-8
	const encode = (str) => {
		const bytes = utf8.encode(str);
		if (bytes.length > SCSU_MAX)
			throw new RangeError(`text must be at most ${SCSU_MAX} bytes of UTF-8`);
		textBuf.set(bytes);
		const len = wasm.scsu_encode(bytes.length);
		if (len < 0)
			throw new Error('scsu_encode failed');
		return scsuBuf.slice(0, len);
	};

	// SCSU bytes to a string, or null if they are not valid SCSU. Pass the
	// decoder to records.parse() as scsu.
	const decode = (bytes) => {
		if (!(bytes instanceof Uint8Array) || bytes.length > SCSU_MAX)
			return null;
		scsuBuf.set(bytes);
		const len = wasm.scsu_decode(bytes.length);
		if (len < 0)
			return null;
		return strict.decode(textBuf.subarray(0, len));
	};

	return { encode, decode };
}

// The smaller of a Text-UTF-8 and a Text-SCSU record for str, UTF-8 when
// they are the same size or without an SCSU module
export function smallestText(str, scsu = null) {
	const plain = textUTF8(str);
	if (!scsu)
		return plain;
	const packed = textSCSU(scsu.encode(str));
	return packed.length < plain.length ? packed : plain;
}
