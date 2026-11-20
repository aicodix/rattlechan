// Tests for robusto.js. Run with: node robusto_test.mjs
// Encoder and decoder modules talk to each other in Node.js: every short
// mode, pings, Rattlechan frames, noise, odd chunk sizes and offsets.

import { readFile } from 'node:fs/promises';
import { loadEncoder, loadDecoder, RATES, PAYLOAD_MAX } from './robusto.js';
import * as R from './records.js';

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

function throws(name, fn) {
	++checks;
	try {
		fn();
		++failed;
		console.log('FAIL', name, 'did not throw');
	} catch {}
}

// deterministic xorshift and Box-Muller, so failures can be repeated
let seed = 0x9E3779B9;
const random = () => {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	return ((seed >>> 0) + 0.5) / 2 ** 32;
};
const randomBytes = (n) => Uint8Array.from({ length: n }, () => random() * 256 | 0);
const gauss = () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());

// silence before and after, so the decoder sees a frame start and end
function onAir(audio, rate, before = rate / 4, after = rate / 4) {
	const out = new Float32Array(before + audio.length + after);
	out.set(audio, before);
	return out;
}

function receive(D, samples, step) {
	const events = [];
	if (step)
		for (let pos = 0; pos < samples.length; pos += step)
			events.push(...D.feed(samples.subarray(pos, pos + step)));
	else
		events.push(...D.feed(samples));
	events.push(...D.flush());
	return events;
}

const frames = (events) => events.filter((e) => e.type === 'frame');
const load = (name) => readFile(new URL(`./robusto_${name}.wasm`, import.meta.url));

for (const rate of RATES) {
	const E = await loadEncoder(rate, await load(`encoder_${rate}`));
	const D = await loadDecoder(rate, await load(`decoder_${rate}`));

	// ---------------------------------------------------------- modes

	const modes = [];
	for (let mode = 32; mode < 256; ++mode) {
		const info = E.modeInfo(mode);
		if (info)
			modes.push(info);
	}
	check(`${rate}: smallest payload`, Math.min(...modes.map((m) => m.payload)), 8);
	check(`${rate}: largest payload`, Math.max(...modes.map((m) => m.payload)), PAYLOAD_MAX);
	check(`${rate}: unknown mode`, E.modeInfo(256), null);
	check(`${rate}: ping mode`, E.modeInfo(7).symbols, 0);
	check(`${rate}: BPSK only on request`, E.modeInfo(E.pickMode(100, 5)).modulation === 'BPSK', false);
	check(`${rate}: BPSK on request`, E.modeInfo(E.pickMode(100, 5, true)).modulation, 'BPSK');
	check(`${rate}: too much for 1 second`, E.pickMode(5000, 1), null);
	check(`${rate}: largest payload needs 36 seconds`, E.modeInfo(E.pickMode(PAYLOAD_MAX, 36)).symbols, 256);

	// every mode of up to 8 symbols, with a full random payload
	for (const m of modes.filter((m) => m.symbols <= 8)) {
		const payload = randomBytes(m.payload);
		const audio = E.encode(payload, { mode: m.mode, callSign: 'DL1ABC-7' });
		check(`${rate}: mode ${m.mode} length`, audio.length, Math.round(m.seconds * rate));
		const got = frames(receive(D, onAir(audio, rate)));
		check(`${rate}: mode ${m.mode} (${m.modulation} ${m.codeRate}, ${m.symbols} symbols)`,
			got.length === 1 && [got[0].mode, got[0].callSign, hex(got[0].payload)].join(), [m.mode, 'DL1ABC-7', hex(payload)].join());
	}

	// the longest frames of the most and least robust kind
	for (const length of [1000, 30000]) {
		const payload = randomBytes(length);
		const got = frames(receive(D, onAir(E.encode(payload, { seconds: 60 }), rate)));
		check(`${rate}: ${length} bytes in a long frame`, got.length === 1 && hex(got[0].payload.subarray(0, length)), hex(payload));
	}

	// ---------------------------------------------------- Rattlechan

	const post = R.topic(1763380000, 'On the air', R.textUTF8('Hello from Rattlechan'));
	const frame = R.payload([R.fromCall('DL1ABC'), post]);
	let ev = receive(D, onAir(E.encode(frame, { seconds: 2, callSign: 'DL1ABC' }), rate));
	check(`${rate}: event order`, ev.map((e) => e.type).join(), 'sync,meta,frame');
	check(`${rate}: meta call sign`, ev[1].callSign, 'DL1ABC');
	const parsed = R.parse(ev[2].payload);
	check(`${rate}: padding parses as the end`, parsed.length, 1);
	check(`${rate}: From-Call matches the preamble`, parsed[0].prefixes[0].handle, ev[1].callSign);
	check(`${rate}: post survives the air`, R.decodeText(parsed[0].text), 'Hello from Rattlechan');
	check(`${rate}: SNR of a clean loopback`, ev[2].snr.median > 20, true);
	check(`${rate}: no bit flips on a clean loopback`, ev[2].bitFlips, 0);

	// ---------------------------------------------------------- pings

	for (const value of [0, 7, 31]) {
		ev = receive(D, onAir(E.ping(value, 'doge'), rate));
		const pings = ev.filter((e) => e.type === 'ping');
		check(`${rate}: ping ${value}`, pings.length === 1 && `${pings[0].value} ${pings[0].callSign}`, `${value} DOGE`);
		check(`${rate}: ping ${value} has no frame`, frames(ev).length, 0);
	}
	check(`${rate}: ping is about half a second`, E.ping(1).length, Math.round(4 * 41 / 300 * rate));

	// ------------------------------------------------ streaming input

	const payload = randomBytes(200);
	const audio = E.encode(payload, { seconds: 3 });
	for (const step of [128, 1000, 7777]) {
		const got = frames(receive(D, onAir(audio, rate), step));
		check(`${rate}: fed in chunks of ${step}`, got.length === 1 && hex(got[0].payload.subarray(0, 200)), hex(payload));
	}
	// the frame starting anywhere within a symbol
	for (const shift of [1, 333, 2049, rate / 300 * 41 - 1]) {
		const got = frames(receive(D, onAir(audio, rate, shift)));
		check(`${rate}: frame shifted by ${shift} samples`, got.length === 1 && hex(got[0].payload.subarray(0, 200)), hex(payload));
	}
	// two frames back to back
	const two = new Float32Array(2 * audio.length + rate / 2);
	two.set(audio, rate / 4);
	two.set(audio, rate / 4 + audio.length);
	check(`${rate}: two frames back to back`, frames(receive(D, two)).length, 2);

	// ---------------------------------------------------------- noise

	const noisy = onAir(E.encode(payload, { seconds: 3 }), rate);
	let power = 0;
	for (const s of audio)
		power += s * s;
	const sigma = Math.sqrt(power / audio.length) * 10 ** (-10 / 20); // 10 dB SNR over the whole band
	for (let i = 0; i < noisy.length; ++i)
		noisy[i] += sigma * gauss();
	const got = frames(receive(D, noisy));
	check(`${rate}: decodes at 10 dB SNR`, got.length === 1 && hex(got[0].payload.subarray(0, 200)), hex(payload));
	const noise = Float32Array.from({ length: 5 * rate }, () => 0.1 * gauss());
	check(`${rate}: nothing in 5 seconds of noise`, frames(receive(D, noise)).length, 0);

	// ---------------------------------------------------------- refusals

	throws(`${rate}: payload too big`, () => E.encode(new Uint8Array(PAYLOAD_MAX + 1), { seconds: 60 }));
	throws(`${rate}: payload too big for its seconds`, () => E.encode(new Uint8Array(5000), { seconds: 1 }));
	throws(`${rate}: payload too big for the mode`, () => E.encode(new Uint8Array(100), { mode: modes[0].mode }));
	throws(`${rate}: a ping mode for a payload`, () => E.encode(new Uint8Array(1), { mode: 7 }));
	throws(`${rate}: invalid call sign`, () => E.encode(new Uint8Array(1), { callSign: 'DL1_ABC' }));
	throws(`${rate}: call sign too long`, () => E.ping(0, 'ABCDEFGHIJ'));
	throws(`${rate}: ping value 32`, () => E.ping(32));
	throws(`${rate}: 61 seconds`, () => E.encode(new Uint8Array(1), { seconds: 61 }));
}

let rejected = 0;
for (const rate of [22050, 96000])
	try {
		await loadEncoder(rate, new Uint8Array(0));
	} catch {
		++rejected;
	}
check('other rates are refused', rejected, 2);

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
