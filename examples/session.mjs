// An evening on the air as one seamless WAV, to try the GUI without a
// radio: play it into the microphone, or use "Decode a recording".
//   node examples/session.mjs [out.wav] [44100|48000]
// Stations post, reply, address each other, send weather, a picture, an
// avatar and a long post in Fragments, plus a forged and a malformed frame.
// All frames are sent as the GUI sends them, chained back to back: only the
// first keeps the leading noise symbol, which opens VOX and squelches, so
// there is no gap anywhere, only a quarter second of silence at both ends.
// dusk.webp and avatar.webp (128x128, the fewest pixels an avatar may have) next
// to this file were drawn with Pillow.

import * as R from '../records.js';
import { loadEncoder } from '../robusto.js';
import { loadCrypto } from '../crypto.js';
import { loadHydra } from '../hydra.js';
import { compose, split, pick, SECONDS_DEFAULT, SNR_DEFAULT } from '../sender.js';
import { smallestText } from '../encodings.js';

// as the GUI sends by default: frames of at most 5 seconds in modes that
// decode from 10 dB, and posts that don't fit in Fragments with 25% more
const opts = { seconds: SECONDS_DEFAULT, snr: SNR_DEFAULT };

// The session: { rate, audio, items }, items being what was sent, in
// order: { callSign, what, payload?, ping?, mode, start } with start in
// samples. file(name) gives the bytes of a file of the repository, such as
// 'crypto.wasm' or 'examples/dusk.webp'; now is the time in seconds the
// last post was written.
// Distinct block indices for split(), drawn by xorshift32 from a fixed seed
// instead of at random, so the recordings come out the same every time
export function seededIndices(seed = 1) {
	let x = seed >>> 0 || 1;
	return (N, count) => {
		const out = new Set();
		while (out.size < Math.min(count, N)) {
			x ^= x << 13;
			x ^= x >>> 17;
			x ^= x << 5;
			x >>>= 0;
			out.add(x % N);
		}
		return [...out];
	};
}

export async function session({ file, rate = 48000, now = Math.floor(Date.now() / 1000) }) {
	const E = await loadEncoder(rate, await file(`robusto_encoder_${rate}.wasm`));
	const C = await loadCrypto(await file('crypto.wasm'));
	const H = await loadHydra(await file('hydra.wasm'));
	const dusk = new Uint8Array(await file('examples/dusk.webp'));
	const avatar = new Uint8Array(await file('examples/avatar.webp'));

	// fixed keys, so the same stations come out every time
	const keyOf = (n) => new Uint8Array(32).fill(n);
	const signer = (n) => (...records) => C.signRecords(keyOf(n), ...records);
	const fingerprint = (n) => C.fingerprint(keyOf(n));
	const ANNA = 1, JAN = 2, YUKI = 3, ARJUN = 4, THROWAWAY = 5, SENSOR = 9;
	const t0 = now - 900;

	const items = [];
	const indices = seededIndices();
	const post = (callSign, what, payload) => {
		const s = split(payload, { encoder: E, hydra: H, indices, ...opts });
		if (s.frames.length === 1)
			items.push({ callSign, what, payload });
		else
			s.frames.forEach((f, i) => items.push({ callSign, what: `${what}: Fragment ${i + 1} of ${s.frames.length}, any ${s.K} enough`, payload: f }));
	};

	// Anna calls CQ with her call sign, name and position
	const cq = compose({
		kind: 'topic', subject: 'CQ from Cologne', text: 'Good evening! Testing Rattlechan on 2 m. Anyone copy?\n73 de DL1ABC',
		callSign: 'DL1ABC', name: 'Anna', timestamp: t0, sign: signer(ANNA),
	});
	post('DL1ABC', 'signed Topic for everyone', cq);
	const cqPost = R.parse(cq)[0].children.find((n) => n.type === R.T.TOPIC);
	const cqId = R.postId(cqPost.raw, fingerprint(ANNA));

	// her avatar, with her call sign and name
	post('DL1ABC', 'signed Avatar', R.payload([C.signRecords(keyOf(ANNA), R.fromCall('DL1ABC'), R.fromName(smallestText('Anna')), R.avatar(avatar))]));

	// Jan answers in Dutch, saying who he is
	const answer = compose({
		kind: 'reply', parent: cqId, text: 'Goedenavond Anna! 5/9 hier in Venlo, mooi signaal. 73 de PA3XYZ',
		callSign: 'PA3XYZ', name: 'Jan', timestamp: t0 + 95, sign: signer(JAN),
	});
	post('PA3XYZ', 'signed Reply with call sign and name', answer);
	const answerPost = R.parse(answer)[0].children.find((n) => n.type === R.T.REPLY);
	const answerId = R.postId(answerPost.raw, fingerprint(JAN));

	items.push({ callSign: 'DL1ABC', what: 'ping 3', ping: 3 });

	post('DL1ABC', 'signed Reply', compose({
		kind: 'reply', parent: answerId, text: 'Dank je, Jan! Signal here 5/7. Good night.', timestamp: t0 + 160, sign: signer(ANNA),
	}));

	// an unsigned weather station, outside the GUI
	post('DL2XYZ-7', 'bare weather readings', R.payload([R.fromCall('DL2XYZ-7'), R.bundle(
		R.position({ lat: 507332000, lon: 71011000, time: t0 + 170 }), R.altitude(61000),
		R.temperature(735), R.humidity(8120), R.pressure(101180),
		R.wind({ direction: 24000, speed: 420 }), R.voltage(3920))]));

	// a board, in Russian, in whatever encoding is smallest
	post('R1ABC', 'unsigned Topic to the board "weather"', compose({
		kind: 'topic', subject: 'Погода', text: 'Привет всем! У нас идёт снег, −3 °C. Как у вас?', to: { group: 'weather' }, timestamp: t0 + 240,
	}));

	// Yuki sends a picture
	post('JA1ABC', 'signed Topic with a picture', R.payload([C.signRecords(keyOf(YUKI), R.fromCall('JA1ABC'),
		R.topic(t0 + 300, smallestText('夕暮れのアンテナ'), smallestText('今日の夕方、新しいアンテナを立てました。'), R.picture(dusk)))]));

	// a sensor's Keyed reading for its owner, which only the owner can check
	post('DL1ABC-9', 'Keyed sensor Reply', R.payload([R.keyed(keyOf(SENSOR), R.reply(t0 + 330, cqId, R.temperature(1890), R.voltage(3310)))]));

	// Jan writes to Anna's key, and to a call sign he never heard
	post('PA3XYZ', 'signed Topic to Anna\'s key', compose({
		kind: 'topic', subject: 'Sked tomorrow?', text: 'Same time on 144.300? I will bring the new yagi.',
		to: { key: fingerprint(ANNA) }, timestamp: t0 + 400, sign: signer(JAN),
	}));
	post('PA3XYZ', 'signed Topic to a call sign', compose({
		kind: 'topic', subject: 'QSL?', text: 'Heard you on the repeater last week. Do you send QSL cards?',
		to: { call: 'OK1ABC' }, timestamp: t0 + 420, sign: signer(JAN),
	}));

	// Arjun's long post in Hindi
	post('VU2ABC', 'signed Topic', compose({
		kind: 'topic', subject: 'नमस्ते दोस्तों',
		text: 'आज शाम बैंगलोर से पहली बार रैटलचैन पर संदेश भेज रहा हूँ। '.repeat(40) + 'शुभ रात्रि, 73!',
		callSign: 'VU2ABC', name: 'Arjun', timestamp: t0 + 450, sign: signer(ARJUN),
	}));

	post('OK1ABC', 'Request-Post for the CQ', R.payload([R.requestPost(cqId)]));

	post('DL1ABC', 'signed Topic with a file', R.payload([C.signRecords(keyOf(ANNA), R.topic(t0 + 520, smallestText('Log'),
		R.mime('text/csv', 'log.csv', new TextEncoder().encode('time,call,rst\n15:02,PA3XYZ,59\n15:06,JA1ABC,57\n'))))]));
	post('PA3XYZ', 'signed Topic with Codec2', R.payload([C.signRecords(keyOf(JAN), R.topic(t0 + 530, smallestText('Voice'),
		R.audio(Uint8Array.from([0xC0, 0xDE, 0xC2, 0, 8, 8, 0, ...Array.from({ length: 96 }, (_, i) => i * 37 & 255)]))))]));

	// a throwaway key revokes itself: logged and ignored
	post('NOCALL', 'revocation of an untrusted key', C.revocations(keyOf(THROWAWAY)).retired);

	// a forged signature and garbage: both dropped
	const forged = compose({ kind: 'topic', subject: 'Free beer', text: 'Totally Anna, trust me.', timestamp: t0 + 600, sign: signer(ANNA) });
	forged[60] ^= 1;
	post('M0FAKE', 'forged signature', forged);
	post('M0FAKE', 'malformed', Uint8Array.of(0xFF, 0xFF, 0xFF, 0xFF, 0, 1, 2, 3));

	return { rate, ...onAir(E, items) };
}

// Items as one seamless chain, each frame in the most robust mode that
// carries it, every one but the first without its leading noise symbol,
// with a quarter second of silence at both ends. Sets each item's mode
// and start (in samples). Returns { audio, items }.
export function onAir(E, items) {
	const rate = E.rate;
	const noise = rate / 300 * 41;
	const pieces = [];
	let length = rate / 4;
	for (const [i, item] of items.entries()) {
		let audio;
		if (item.ping !== undefined) {
			audio = E.ping(item.ping, item.callSign);
			item.mode = item.ping;
		} else {
			item.mode = pick(E, item.payload.length, opts);
			audio = E.encode(item.payload, { mode: item.mode, callSign: item.callSign });
		}
		if (i)
			audio = audio.subarray(noise);
		item.start = length;
		pieces.push(audio);
		length += audio.length;
	}
	const audio = new Float32Array(length + rate / 4);
	let pos = rate / 4;
	for (const p of pieces) {
		audio.set(p, pos);
		pos += p.length;
	}
	return { audio, items };
}

// 16-bit mono WAV, at half scale to leave headroom
export function wav(audio, rate) {
	const out = new Uint8Array(44 + 2 * audio.length);
	const v = new DataView(out.buffer);
	const ascii = (pos, s) => [...s].forEach((c, i) => v.setUint8(pos + i, c.charCodeAt(0)));
	ascii(0, 'RIFF');
	v.setUint32(4, 36 + 2 * audio.length, true);
	ascii(8, 'WAVEfmt ');
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, rate, true);
	v.setUint32(28, 2 * rate, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	ascii(36, 'data');
	v.setUint32(40, 2 * audio.length, true);
	for (let i = 0; i < audio.length; ++i)
		v.setInt16(44 + 2 * i, Math.max(-32768, Math.min(32767, Math.round(audio[i] * 0.5 * 32767))), true);
	return out;
}

// run from the command line
if (import.meta.url === `file://${process.argv[1]}`) {
	const { readFile, writeFile } = await import('node:fs/promises');
	const file = (name) => readFile(new URL(`../${name}`, import.meta.url));
	const out = process.argv[2] ?? 'rattlechan-evening.wav';
	const rate = Number(process.argv[3] ?? 48000);
	const s = await session({ file, rate });
	await writeFile(out, wav(s.audio, s.rate));
	for (const item of s.items)
		console.log(`${(item.start / rate).toFixed(1).padStart(6)} s  ${item.callSign.padEnd(9)} ${item.payload ? `${String(item.payload.length).padStart(5)} B` : '        '}  ${item.what}`);
	console.log(`${out}: ${(s.audio.length / rate).toFixed(1)} s at ${rate} Hz, ${s.items.length} frames without a gap`);
}
