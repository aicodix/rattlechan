// Tests for sender.js. Run with: node sender_test.mjs
// Posts are composed, split and chained, then decoded again with the real
// ROBUSTO decoder and reassembled with HYDRA.

import { readFile } from 'node:fs/promises';
import { compose, composeAvatar, fill, pack, frameCapacity, split, chain, pick, secondsFor, airtime, needs, THRESHOLDS, SECONDS_DEFAULT, SNR_DEFAULT } from './sender.js';
import { loadEncoder, loadDecoder } from './robusto.js';
import { loadHydra, Reassembler } from './hydra.js';
import { loadCrypto } from './crypto.js';
import * as R from './records.js';

const hex = (a) => a && Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
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

const file = (name) => readFile(new URL(`./${name}`, import.meta.url));
const H = await loadHydra(await file('hydra.wasm'));

// ------------------------------------------------------------- composing

const ts = 1763700000;
let p = R.parse(compose({ kind: 'topic', subject: 'Hello', text: 'First post', callSign: 'DL1ABC', name: 'Anna', timestamp: ts }));
check('topic: one record', p.length, 1);
check('topic: From-Call', p[0].prefixes[0].handle, 'DL1ABC');
check('topic: From-Name', R.decodeText(p[0].prefixes[1].handle), 'Anna');
check('topic: subject', R.decodeText(p[0].subject), 'Hello');
check('topic: text', R.decodeText(p[0].text), 'First post');
check('topic: timestamp', p[0].timestamp, ts);

p = R.parse(compose({ kind: 'topic', subject: 'Привет', text: 'Привет всем!' }));
check('topic without call sign: no prefixes', p[0].prefixes.length, 0);
check('topic: smallest encoding, not UTF-8', p[0].text.type !== R.T.TEXT_UTF8, true);

const parent = Uint8Array.from({ length: 32 }, (_, i) => i);
p = R.parse(compose({ kind: 'reply', parent, text: 'Thanks', callSign: 'DL1ABC', name: 'Anna' }));
check('reply: a Reply', p[0].type, R.T.REPLY);
check('reply: From-Call', p[0].prefixes[0].handle, 'DL1ABC');
check('reply: From-Name', R.decodeText(p[0].prefixes[1].handle), 'Anna');
check('reply: parent', hex(p[0].parent), hex(parent));

p = R.parse(compose({ kind: 'message', text: 'Hungry', callSign: 'DL1ABC' }));
check('message: bare text', R.decodeText(p[0]), 'Hungry');
check('message: From-Call', p[0].prefixes[0].handle, 'DL1ABC');

// signed: the same records inside one Signed record
{
	const C = await loadCrypto(await file('crypto.wasm'));
	const priv = new Uint8Array(32).fill(7);
	const sign = (...records) => C.signRecords(priv, ...records);
	for (const [kind, extra] of [['topic', { subject: 'Signed' }], ['reply', { parent }], ['message', {}]]) {
		const q = R.parse(compose({ kind, text: 'signed text', callSign: 'DL1ABC', name: 'Anna', sign, ...extra }), { verify: C.verify });
		check(`signed ${kind}: one Signed record`, q.length === 1 && q[0].type, R.T.SIGNED);
		check(`signed ${kind}: verifies`, q[0].verified, true);
		const inner = q[0].children[0];
		check(`signed ${kind}: From inside`, inner.prefixes.length, 2);
		check(`signed ${kind}: ID`, kind === 'message' || inner.id !== null, true);
	}
	// a post with the avatar beside it: same post, same ID
	{
		const pic = new Uint8Array(await file('examples/avatar.webp'));
		const args = { kind: 'topic', subject: 'Hi', text: 'with avatar', callSign: 'DL1ABC', timestamp: 1763700000, sign };
		const w = R.parse(compose({ ...args, avatar: pic }), { verify: C.verify });
		const wo = R.parse(compose(args), { verify: C.verify });
		check('post with avatar: verifies', w[0].verified, true);
		check('post with avatar: Topic, then Avatar', w[0].children.map((n) => n.name).join(), 'TOPIC,AVATAR');
		check('post with avatar: From stays on the Topic', w[0].children[0].prefixes.length, 1);
		check('post with avatar: same post ID', hex(w[0].children[0].id), hex(wo[0].children[0].id));
	}
	// an Avatar, with and without From
	const webp = new Uint8Array(await file('examples/avatar.webp'));
	const a = R.parse(composeAvatar({ avatar: webp, callSign: 'DL1ABC', name: 'Anna', sign }), { verify: C.verify });
	check('avatar: one Signed record', a.length === 1 && a[0].type, R.T.SIGNED);
	check('avatar: verifies', a[0].verified, true);
	check('avatar: From-Call, From-Name, Avatar', a[0].children.map((n) => n.prefixes?.length ? `${n.prefixes.map((p) => p.name).join('+')}+${n.name}` : n.name).join(), 'FROM_CALL+FROM_NAME+AVATAR');
	check('avatar: the file', a[0].children.at(-1).body.length, webp.length);
	const bare = R.parse(composeAvatar({ avatar: webp, sign }), { verify: C.verify });
	check('avatar: without From', bare[0].children.length === 1 && bare[0].children[0].type, R.T.AVATAR);
	let threw = false;
	try {
		composeAvatar({ avatar: webp });
	} catch {
		threw = true;
	}
	check('avatar: needs a key', threw, true);
}

// addressed Topics: From before To, as the ordering rule asks
{
	const key = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
	const cases = [
		[{ call: 'PA3XYZ' }, R.T.TO_CALL, (h) => h === 'PA3XYZ'],
		[{ name: 'Jan' }, R.T.TO_NAME, (h) => R.decodeText(h) === 'Jan'],
		[{ key }, R.T.TO_KEY, (h) => hex(h) === hex(key)],
		[{ group: 'weather' }, R.T.TO_GROUP_NAME, (h) => R.decodeText(h) === 'weather'],
	];
	for (const [to, type, ok] of cases) {
		const q = R.parse(compose({ kind: 'topic', subject: 'Hi', text: 'Direct', callSign: 'DL1ABC', name: 'Anna', to }));
		const last = q[0].prefixes[q[0].prefixes.length - 1];
		check(`to ${Object.keys(to)[0]}: From, From, To`, q[0].prefixes.map((x) => x.type).join(), [R.T.FROM_CALL, R.T.FROM_NAME, type].join());
		check(`to ${Object.keys(to)[0]}: handle`, ok(last.handle), true);
	}
	check('to nobody: no To prefix', R.parse(compose({ kind: 'topic', subject: 'Hi', text: 'All', to: null }))[0].prefixes.length, 0);
	throws('a Reply to an address', () => compose({ kind: 'reply', parent, text: 'x', to: { call: 'PA3XYZ' } }));
	throws('an unknown address', () => compose({ kind: 'topic', subject: 'x', text: 'x', to: { fax: '123' } }));
}

throws('no text', () => compose({ kind: 'message', text: '' }));
throws('topic without subject', () => compose({ kind: 'topic', text: 'x' }));
throws('reply without parent', () => compose({ kind: 'reply', text: 'x' }));
throws('unknown kind', () => compose({ kind: 'poll', text: 'x' }));

// ------------------------------------------- splitting, chaining, decoding

for (const rate of [48000, 44100]) {
	const E = await loadEncoder(rate, await file(`robusto_encoder_${rate}.wasm`));
	const D = await loadDecoder(rate, await file(`robusto_decoder_${rate}.wasm`));
	// spare room filled with revocations, never a longer frame
	{
		const C2 = await loadCrypto(await file('crypto.wasm'));
		const revs = Array.from({ length: 40 }, (_, i) => C2.revocations(new Uint8Array(32).fill(i + 1))[i % 2 ? 'retired' : 'compromised']);
		const post = compose({ kind: 'topic', subject: 'Hi', text: 'y'.repeat(200), timestamp: 1 });
		const big = compose({ kind: 'topic', subject: 'Hi', text: 'x'.repeat(frameCapacity(E) - 20), timestamp: 1 });
		const f = fill(E, [post, big], revs);
		check(`${rate}: fill keeps the modes`, f.frames.map((x) => pick(E, x.length)).join(), [post, big].map((x) => pick(E, x.length)).join());
		check(`${rate}: fill uses the room of the first`, f.used[0].length > 0 && f.frames[0].length <= E.modeInfo(pick(E, post.length)).payload, true);
		check(`${rate}: none in a full frame`, f.used[1].length, 0);
		check(`${rate}: fill in order`, f.used[0].every((v, i) => v === i), true);
		const parsed = R.parse(f.frames[0], { verify: C2.verify });
		check(`${rate}: the post and the revocations parse`, parsed.length, 1 + f.used[0].length);
		const p = pack(E, revs);
		check(`${rate}: pack: every revocation once`, p.used.flat().join(), revs.map((_, i) => i).join());
		check(`${rate}: pack: frames within capacity`, p.frames.every((x) => pick(E, x.length) !== null), true);
		check(`${rate}: pack: as few frames as fit`, p.frames.length, Math.ceil(40 / Math.floor(frameCapacity(E) / 99)));
	}
	const cap = frameCapacity(E);
	check(`${rate}: capacity fits`, pick(E, cap) !== null, true);
	check(`${rate}: one byte more doesn't`, pick(E, cap + 1), null);
	check(`${rate}: capacity at 10 dB in 5 s: QAM16 8/16`, `${E.modeInfo(pick(E, cap)).modulation} ${E.modeInfo(pick(E, cap)).codeRate}`, 'QAM16 8/16');
	check(`${rate}: 1 second carries less`, frameCapacity(E, { seconds: 1 }) < cap, true);
	check(`${rate}: 3 dB carries less`, frameCapacity(E, { snr: 3 }) < cap, true);
	check(`${rate}: 30 dB carries the most`, frameCapacity(E, { snr: 30 }) > cap, true);
	check(`${rate}: below the most robust threshold nothing`, frameCapacity(E, { snr: 0.5 }), 0);
	check(`${rate}: every picked mode decodes at the SNR`, [100, 500, 1000, 2000].every((n) => { const m = pick(E, n, { snr: 6 }); return m === null || needs(m) <= 6; }), true);
	const more = secondsFor(E, cap + 1);
	check(`${rate}: one byte more needs a longer frame`, more > SECONDS_DEFAULT && pick(E, cap + 1, { seconds: more }) !== null && pick(E, cap + 1, { seconds: more - 1 }) === null, true);
	check(`${rate}: too much for 60 seconds at 3 dB`, secondsFor(E, 30000, 3), null);

	const receive = (audio) => {
		const x = new Float32Array(audio.length + rate);
		x.set(audio, rate / 2);
		const ev = [];
		for (let i = 0; i < x.length; i += 4096)
			ev.push(...D.feed(x.subarray(i, i + 4096)));
		ev.push(...D.flush());
		return ev.filter((e) => e.type === 'frame');
	};

	// a short post: one frame
	const short = compose({ kind: 'topic', subject: 'CQ', text: 'Short one', callSign: 'DL1ABC' });
	let s = split(short, { encoder: E, hydra: H });
	check(`${rate}: short post in one frame`, s.frames.length, 1);
	let c = chain(E, s.frames, { callSign: 'DL1ABC' });
	check(`${rate}: one frame as long as the encoder makes it`, c.audio.length, E.encode(short, { mode: c.modes[0], callSign: 'DL1ABC' }).length);
	let got = receive(c.audio);
	check(`${rate}: short post decodes`, got.length === 1 && hex(got[0].payload.subarray(0, short.length)), hex(short));
	check(`${rate}: preamble call sign`, got[0].callSign, 'DL1ABC');

	// a long post: Fragments with 25% more, chained seamlessly
	const long = compose({ kind: 'topic', subject: 'Long', text: 'All work and no play. '.repeat(400), callSign: 'DL1ABC', timestamp: ts });
	s = split(long, { encoder: E, hydra: H });
	check(`${rate}: long post needs Fragments`, s.K > 1, true);
	check(`${rate}: 25% more blocks`, s.frames.length, Math.ceil(s.K * 1.25));
	check(`${rate}: every frame fits`, s.frames.every((f) => f.length <= cap), true);
	c = chain(E, s.frames, { callSign: 'DL1ABC' });
	const noise = rate / 300 * 41;
	const whole = s.frames.reduce((n, f, i) => n + E.encode(f, { mode: c.modes[i], callSign: 'DL1ABC' }).length, 0);
	check(`${rate}: leading noise only once`, c.audio.length, whole - (s.frames.length - 1) * noise);
	check(`${rate}: every frame at most ${SECONDS_DEFAULT} s`, c.modes.every((m) => E.modeInfo(m).seconds <= SECONDS_DEFAULT), true);
	check(`${rate}: every frame decodes at ${SNR_DEFAULT} dB`, c.modes.every((m) => needs(m) <= SNR_DEFAULT), true);
	check(`${rate}: airtime as chained`, Math.abs(airtime(E, s.frames.map((f) => f.length)) - c.seconds) < 1e-6, true);
	{
		// a longer lead-in only before the first frame
		const lead = chain(E, s.frames, { callSign: 'DL1ABC', lead: 5 });
		check(`${rate}: lead of 5 adds four symbols`, lead.audio.length - c.audio.length, 4 * rate * 41 / 300);
		check(`${rate}: airtime with the lead`, Math.abs(airtime(E, s.frames.map((f) => f.length), { lead: 5 }) - lead.seconds) < 1e-6, true);
		const ev = [...D.feed(lead.audio), ...D.flush()];
		check(`${rate}: every frame after the lead`, ev.filter((e) => e.type === 'frame').length, s.frames.length);
	}
	got = receive(c.audio);
	check(`${rate}: every frame of the chain decodes`, got.length, s.frames.length);
	const re = new Reassembler(H);
	let out = null;
	for (const g of got)
		for (const n of R.parse(g.payload, { verifyBlock: H.verifyBlock }))
			if (n.type === R.T.FRAGMENT) {
				const r = re.add(n.block);
				if (r?.payload)
					out = r.payload;
			}
	check(`${rate}: reassembles to the post`, out && hex(out.subarray(0, long.length)), hex(long));
	const post = R.parse(out, { reassembled: true })[0];
	check(`${rate}: and parses`, R.decodeText(post.subject), 'Long');

	// losing any 20% of the frames still leaves enough
	const kept = got.filter((_, i) => i % 5 !== 1);
	const re2 = new Reassembler(H);
	let out2 = null;
	for (const g of kept)
		for (const n of R.parse(g.payload, { verifyBlock: H.verifyBlock }))
			if (n.type === R.T.FRAGMENT)
				out2 = re2.add(n.block)?.payload ?? out2;
	check(`${rate}: ${kept.length} of ${got.length} frames are enough`, out2 && hex(out2.subarray(0, long.length)), hex(long));

	throws(`${rate}: too big for HYDRA's absence`, () => split(long, { encoder: E, hydra: null }));
	throws(`${rate}: a frame that doesn't fit`, () => chain(E, [new Uint8Array(cap + 1)]));
	throws(`${rate}: no mode at 0 dB`, () => split(short, { encoder: E, hydra: H, snr: 0 }));

	// the same long post as one longer frame instead
	const one = split(long, { encoder: E, hydra: H, seconds: secondsFor(E, long.length) });
	check(`${rate}: one longer frame`, one.frames.length, 1);
	const c1 = chain(E, one.frames, { seconds: secondsFor(E, long.length), callSign: 'DL1ABC' });
	got = receive(c1.audio);
	check(`${rate}: the longer frame decodes`, got.length === 1 && hex(got[0].payload.subarray(0, long.length)), hex(long));
}

// at least one extra block, even for small K
{
	const E = await loadEncoder(48000, await file('robusto_encoder_48000.wasm'));
	const cap = frameCapacity(E, { seconds: 1 });
	const s = split(new Uint8Array(cap + 10).fill(0x40), { encoder: E, hydra: H, seconds: 1, redundancy: 0 });
	check('no redundancy asked: still one more than K', s.frames.length, s.K + 1);
}

check('26 thresholds, rising', THRESHOLDS.length === 26 && THRESHOLDS.every((t, i) => !i || THRESHOLDS[i - 1] < t), true);

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
