// Glue for the ROBUSTO WebAssembly modules (robusto_*.wasm, copied as they
// are from the robusto branch of https://github.com/aicodix/modem): an OFDM
// modem in 2400 Hz of audio around 1500 Hz. A frame carries a call sign and
// a payload of 8 to 61440 bytes; a ping carries a call sign and a value.

import { encodeCall } from './records.js';
import { instantiate } from './wasm.js';

export const RATES = Object.freeze([44100, 48000]);
export const PAYLOAD_MAX = 61440;
export const SECONDS_MAX = 60;
// symbols of leading noise before a frame, and of noise alone, at most
export const LEAD_MAX = 30;
export const NOISE_MAX = 300;

// decoder event bits
export const EVENT = Object.freeze({
	SYNC: 1 << 0,
	DAMAGED_SEED: 1 << 1,
	PREAMBLE_ERROR: 1 << 2,
	UNSUPPORTED_CALL: 1 << 3,
	META: 1 << 4,
	KNOWN_MODE: 1 << 5,
	ERASED_SYMBOL: 1 << 6,
	FRAME_END: 1 << 7,
	PAYLOAD_ERROR: 1 << 8,
	REENCODED: 1 << 9,
	REAL_SNR: 1 << 10,
	DECODED: 1 << 11,
	PING: 1 << 13,
});

const MODULATION = { 1: 'BPSK', 2: 'QPSK', 4: 'QAM16', 6: 'QAM64', 8: 'QAM256' };

function checkRate(rate) {
	if (!RATES.includes(rate))
		throw new RangeError(`rate must be one of ${RATES.join(', ')}`);
}

// the base-40 call sign as the 48-bit number ROBUSTO's preamble carries
function callNumber(call) {
	const b = encodeCall(call);
	let v = 0n;
	for (let i = 5; i >= 0; --i)
		v = v << 8n | BigInt(b[i]);
	return v;
}

// symbols, modulation and code rate as the modules report them
function describe(wasm, mode) {
	const symbols = wasm.symbol_count();
	return {
		mode,
		symbols,
		modulation: MODULATION[wasm.mod_bits()],
		codeRate: `${wasm.code_rate()}/16`,
		payload: wasm.payload_length(),
		// leading noise, two sync symbols, the preamble and the payload symbols
		seconds: (4 + symbols) * 41 / 300,
	};
}

// rate: 44100 or 48000, the AudioContext's. source as for instantiate() in
// wasm.js; without one, the module is fetched from next to this file.
export async function loadEncoder(rate, source) {
	checkRate(rate);
	const wasm = await instantiate(source ?? new URL(`./robusto_encoder_${rate}.wasm`, import.meta.url));
	// filters and sequences are built by static constructors
	wasm.__wasm_call_ctors();
	const payloadBuf = new Uint8Array(wasm.memory.buffer, wasm.payload.value, 65536);
	const audio = (len) => new Float32Array(wasm.memory.buffer, wasm.audio.value, len).slice();

	// the most robust mode carrying length bytes in a frame of at most
	// seconds, the shortest of those, or null; BPSK modes only on request
	const pickMode = (length, seconds = 5, bpsk = false) => {
		const mode = wasm.pick_mode(seconds, length, bpsk ? 1 : 0);
		return mode < 0 ? null : mode;
	};

	// what a mode is, or null for a mode the modules don't know
	const modeInfo = (mode) => {
		if (!Number.isInteger(mode) || wasm.start(mode) < 0)
			return null;
		wasm.stop();
		return describe(wasm, mode);
	};

	// one symbol of leading noise and its guard interval, in seconds
	const NOISE_SYMBOL = 41 / 300;

	// lead: symbols of leading noise before the frame, at least the one
	// every frame starts with, more for a VOX that needs longer to key
	const frame = (mode, payload, call, lead = 1) => {
		if (!Number.isInteger(lead) || lead < 1 || lead > LEAD_MAX)
			throw new RangeError(`lead must be 1..${LEAD_MAX} symbols`);
		const number = callNumber(call);
		const chunks = [];
		let total = 0;
		const take = (len) => {
			if (len < 0)
				throw new Error('ROBUSTO encoder failed');
			chunks.push(audio(len));
			total += len;
		};
		take(wasm.start(mode));
		for (let i = 1; i < lead; ++i)
			take(wasm.noise());
		payloadBuf.set(payload);
		if (wasm.begin(payload.length, number) < 0)
			throw new Error('ROBUSTO encoder refused the frame');
		for (let len; (len = wasm.next()) > 0;)
			take(len);
		take(wasm.stop());
		const out = new Float32Array(total);
		let pos = 0;
		for (const c of chunks) {
			out.set(c, pos);
			pos += c.length;
		}
		return out;
	};

	// The audio of one frame carrying payload, at most seconds long. Shorter
	// payloads arrive padded with zeros to the payload of the mode.
	const encode = (payload, { seconds = 5, bpsk = false, callSign = 'ANONYMOUS', mode, lead = 1 } = {}) => {
		if (!(payload instanceof Uint8Array) || payload.length > PAYLOAD_MAX)
			throw new RangeError(`payload must be a Uint8Array of at most ${PAYLOAD_MAX} bytes`);
		if (mode === undefined) {
			if (!Number.isInteger(seconds) || seconds < 1 || seconds > SECONDS_MAX)
				throw new RangeError(`seconds must be 1..${SECONDS_MAX}`);
			mode = pickMode(payload.length, seconds, bpsk);
			if (mode === null)
				throw new RangeError(`no ${bpsk ? 'BPSK ' : ''}mode carries ${payload.length} bytes in ${seconds} seconds`);
		} else {
			const info = modeInfo(mode);
			if (!info || !info.symbols || payload.length > info.payload)
				throw new RangeError(`mode ${mode} doesn't carry ${payload.length} bytes`);
		}
		return frame(mode, payload, callSign, lead);
	};

	// The audio of a ping: a call sign and a value 0..31, about half a second
	const ping = (value, callSign = 'ANONYMOUS', lead = 1) => {
		if (!Number.isInteger(value) || value < 0 || value > 31)
			throw new RangeError('ping value must be 0..31');
		return frame(value, new Uint8Array(0), callSign, lead);
	};

	// symbols of leading noise alone, fading in and out like a frame,
	// carrying nothing: for setting a radio's input
	const noise = (symbols) => {
		if (!Number.isInteger(symbols) || symbols < 1 || symbols > NOISE_MAX)
			throw new RangeError(`noise must be 1..${NOISE_MAX} symbols`);
		const parts = [audio(wasm.start(0))];
		for (let i = 1; i < symbols; ++i)
			parts.push(audio(wasm.noise()));
		parts.push(audio(wasm.stop()));
		const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
		parts.reduce((pos, p) => (out.set(p, pos), pos + p.length), 0);
		return out;
	};

	return { rate, pickMode, modeInfo, encode, ping, noise, NOISE_SYMBOL };
}

// A streaming decoder: feed() it samples as they arrive, it returns what
// happened. Events are objects with a type:
//   sync     { cfo (Hz), sfo (ppm) }        a frame starts
//   meta     { callSign, mode }             its preamble
//   ping     { callSign, value }
//   frame    { callSign, mode, payload, bitFlips, snr: { min, median, max } }
//   error    { what: 'preamble' | 'call sign' | 'mode' | 'payload', callSign?, mode? }
export async function loadDecoder(rate, source) {
	checkRate(rate);
	const wasm = await instantiate(source ?? new URL(`./robusto_decoder_${rate}.wasm`, import.meta.url));
	wasm.__wasm_call_ctors();
	const chunk = rate / 300 * 41;
	const samplesBuf = new Float32Array(wasm.memory.buffer, wasm.samples.value, chunk);
	const payloadBuf = new Uint8Array(wasm.memory.buffer, wasm.payload.value, 65536);
	const callBuf = new Uint8Array(wasm.memory.buffer, wasm.call_sign.value, 9);
	const stats = new Float32Array(wasm.memory.buffer, wasm.stats.value, 9);
	let callSign = null;

	const report = (bits, out) => {
		const mode = wasm.oper_mode();
		if (bits & EVENT.SYNC) {
			callSign = null;
			out.push({ type: 'sync', cfo: stats[0], sfo: stats[1] });
		}
		if (bits & EVENT.PREAMBLE_ERROR)
			out.push({ type: 'error', what: 'preamble' });
		if (bits & EVENT.UNSUPPORTED_CALL)
			out.push({ type: 'error', what: 'call sign' });
		if (bits & EVENT.META) {
			callSign = new TextDecoder().decode(callBuf).trim();
			out.push({ type: 'meta', callSign, mode: wasm.meta_mode() });
			if (!(bits & EVENT.KNOWN_MODE))
				out.push({ type: 'error', what: 'mode', callSign, mode: wasm.meta_mode() });
		}
		if (bits & EVENT.PING)
			out.push({ type: 'ping', callSign, value: mode & 31 });
		if (bits & EVENT.PAYLOAD_ERROR)
			out.push({ type: 'error', what: 'payload', callSign, mode });
		if (bits & EVENT.DECODED) {
			out.push({
				type: 'frame',
				callSign,
				mode,
				payload: payloadBuf.slice(0, wasm.payload_length()),
				bitFlips: wasm.bit_flips(),
				snr: { min: stats[3], median: stats[4], max: stats[5] },
			});
		}
	};

	// samples: a Float32Array of any length, mono, at the decoder's rate
	const feed = (samples) => {
		const out = [];
		for (let pos = 0; pos < samples.length; pos += chunk) {
			const part = samples.subarray(pos, pos + chunk);
			samplesBuf.set(part);
			for (let offset = 0; offset < part.length;) {
				const used = wasm.feed(offset, part.length - offset);
				if (used < 0)
					throw new Error('ROBUSTO decoder failed');
				offset += used;
				const bits = wasm.events();
				if (bits)
					report(bits, out);
			}
		}
		return out;
	};

	// true while a frame is being received
	const busy = () => wasm.busy() !== 0;

	// at the end of a recording: feed silence until the decoder is done
	const flush = () => {
		const out = [];
		const silence = new Float32Array(chunk);
		for (let i = 0; busy() && i < 400; ++i)
			out.push(...feed(silence));
		return out;
	};

	return { rate, feed, busy, flush };
}
