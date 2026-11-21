// Tests for station.js. Run with: node station_test.mjs
// Frames go through the station into a store in memory: parsing, signature
// checks, dropping malformed frames, reassembling Fragments and replaying.

import { readFile } from 'node:fs/promises';
import { openStation } from './station.js';
import { memoryBackend, openStore } from './storage.js';
import { loadCrypto } from './crypto.js';
import { loadHydra } from './hydra.js';
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

const file = (name) => readFile(new URL(`./${name}`, import.meta.url));
const C = await loadCrypto(await file('crypto.wasm'));
const H = await loadHydra(await file('hydra.wasm'));

let clock = 1763380000000;
const store = await openStore(memoryBackend(), { now: () => clock });
const S = await openStation({ store, crypto: C, hydra: H });

// ------------------------------------------------------------ receiving

const key = C.newPrivateKey();
const post = R.topic(1763380000, 'On the air', R.textUTF8('Hello from Rattlechan'));
const frame = R.payload([C.signRecords(key, R.fromCall('DL1ABC'), post)], 200);

let e = await S.receive(frame, { arrival: clock, callSign: 'DL1ABC', mode: 42, snr: 20 });
check('parsed', e.error, undefined);
check('stored', e.name !== null && e.tier, 'logged');
check('extra fields stay', e.snr, 20);
check('size is the whole frame', e.size, 200);
check('used ends before the padding', e.used, 96 + 2 + 7 + post.length);
check('signature verified', e.nodes[0].verified, true);
check('the post inside', R.decodeText(e.nodes[0].children[0].text), 'Hello from Rattlechan');
check('no fragments', e.fragments.length, 0);
check('stored as received', hex(await store.readFrame(e.name)), hex(frame));

// a bad signature usually means corruption: the frame is dropped
const forged = frame.slice();
forged[60] ^= 1;
e = await S.receive(forged, { callSign: 'DL1ABC' });
check('forged: dropped', e.error, 'bad signature at offset 0');
check('forged: not stored', e.name, null);

// malformed frames are dropped and never stored
const before = (await store.frames()).length;
e = await S.receive(Uint8Array.of(0xFF, 1, 2, 3, 4, 5, 6, 7));
check('malformed: error', typeof e.error, 'string');
check('malformed: not stored', e.name, null);
check('malformed: store unchanged', (await store.frames()).length, before);

// a station without CRYPTO leaves signatures unverified
{
	const plain = await openStation({ store: await openStore(memoryBackend()) });
	const p = await plain.receive(frame);
	check('without crypto: unverified', p.nodes[0].verified, null);
}

// ----------------------------------------------------------- fragments

const long = R.payload([C.signRecords(key, R.topic(1763380100, 'A long one', R.textUTF8('x'.repeat(2000))))]);
const enc = H.encode(long, { budget: 300 });
check('needs several blocks', enc.K > 2, true);
const blocks = Array.from({ length: enc.K + 1 }, (_, i) => enc.fragment(i));
let last;
for (let i = 0; i < enc.K; ++i) {
	clock += 1000;
	last = await S.receive(R.payload([blocks[i]]), { callSign: 'DL1ABC' });
	if (i === 0)
		check('first block: waiting', last.fragments[0].have, 1);
	if (i === 0)
		check('waiting sets', S.waiting().length, 1);
}
const done = last.fragments[0];
check('last block: reassembled', done.used, long.length);
check('reassembled: padded to whole blocks', done.size >= long.length, true);
check('reassembled: verified', done.nodes[0].verified, true);
check('reassembled: the post', R.decodeText(done.nodes[0].children[0].subject), 'A long one');
check('nothing waiting', S.waiting().length, 0);

// a corrupted block fails verify_block and drops its frame
const bad = R.payload([blocks[enc.K]]);
bad[bad.length - 1] ^= 1;
check('bad block dropped', typeof (await S.receive(bad)).error, 'string');

// ------------------------------------------------------------ replaying

{
	const again = await openStation({ store, crypto: C, hydra: H });
	const all = await again.replay();
	check('replay: every stored frame', all.length, (await store.frames()).length);
	check('replay: oldest first', all.every((x, i) => !i || all[i - 1].arrival <= x.arrival), true);
	check('replay: preamble kept', all[0].callSign, 'DL1ABC');
	check('replay: mode kept', all[0].mode, 42);
	const rebuilt = all.flatMap((x) => x.fragments).filter((f) => f.nodes);
	check('replay: reassembles again', rebuilt.length === 1 && rebuilt[0].used, long.length);
}

// --------------------------------------------------------------- trust

{
	clock += 60000;
	const st = await openStore(memoryBackend(), { now: () => clock });
	const T1 = await openStation({ store: st, crypto: C, hydra: H });
	const anna = C.newPrivateKey(), annaKey = hex(C.fingerprint(anna));
	const other = C.newPrivateKey();
	const pic = Uint8Array.of(1, 2, 3);

	let e = await T1.receive(R.payload([C.signRecords(anna, R.fromCall('DL1ABC'), R.fromName(R.textUTF8('Anna')), post)]));
	check('untrusted: logged', e.tier, 'logged');
	check('learned call sign', T1.keyInfo(annaKey).callSign, 'DL1ABC');
	check('learned name', R.decodeText(T1.keyInfo(annaKey).name), 'Anna');
	check('not trusted yet', T1.keyInfo(annaKey).trusted, false);
	const avatarFrame = await T1.receive(R.payload([C.signRecords(anna, R.avatar(pic))]));
	check('learned avatar', hex(T1.keyInfo(annaKey).avatar), '010203');
	await T1.receive(R.payload([C.signRecords(other, post)]));
	const unsigned = await T1.receive(R.payload([R.fromCall('DL1ABC'), R.textUTF8('bare')]));
	// a forged signature teaches nothing
	const lie = R.payload([C.signRecords(anna, R.fromCall('EVIL'), post)]);
	lie[60] ^= 1;
	await T1.receive(lie);
	check('forged: nothing learned', T1.keyInfo(annaKey).callSign, 'DL1ABC');

	check('trusting moves two frames', await T1.setTrust(annaKey, true), 2);
	check('trusted', T1.keyInfo(annaKey).trusted, true);
	check('post frame precious', e.tier, 'precious');
	check('avatar frame precious', avatarFrame.tier, 'precious');
	check('unsigned stays logged', unsigned.tier, 'logged');
	check('precious tier holds them', (await st.frames('precious')).length, 2);
	check('trust list stored', (await st.getData('trust')).trusted[0], annaKey);

	// a new post of a trusted key goes straight to precious and renews its avatar
	const before = avatarFrame.name;
	clock += 1000;
	e = await T1.receive(R.payload([C.signRecords(anna, R.reply(1763380200, new Uint8Array(32), R.textUTF8('again')))]));
	check('new post precious', e.tier, 'precious');
	check('avatar renewed', avatarFrame.name !== before && (await st.frames()).some((f) => f.name === avatarFrame.name), true);
	check('renewed avatar still known', T1.keyInfo(annaKey).avatarFrame, avatarFrame.name);

	// another station on the same store sees the trust and the tiers
	const T2 = await openStation({ store: st, crypto: C, hydra: H });
	await T2.replay();
	check('replay: trust kept', T2.isTrusted(annaKey), true);
	check('replay: learned again', T2.keyInfo(annaKey).callSign, 'DL1ABC');
	check('replay: nothing to move', await T2.setTrust(annaKey, true), 0);

	check('distrusting moves three frames down', await T2.setTrust(annaKey, false), 3);
	check('nothing precious left', (await st.frames('precious')).length, 0);
	check('trust list empty', (await st.getData('trust')).trusted.length, 0);

	// fragments move up together once their payload turns out precious
	await T2.setTrust(annaKey, true);
	const big = R.payload([C.signRecords(anna, R.topic(1763380300, 'Long', R.textUTF8('y'.repeat(1500))))]);
	const enc2 = H.encode(big, { budget: 300 });
	const frags = Array.from({ length: enc2.K }, (_, i) => enc2.fragment(i));
	const got = [];
	for (const f of frags)
		got.push(await T2.receive(R.payload([f])));
	check('fragments: first ones waited in logged', got.length > 1 && (await st.frames('precious')).length >= 3 + got.length, true);
	check('fragments: all precious now', got.every((g) => g.tier === 'precious'), true);

	// an import that brings a trust list: replay puts frames where it says
	const st2 = await openStore(memoryBackend());
	for (const f of await st.frames())
		await st2.backend.write(`logged/${f.name}`, await st.readFrame(f.name));
	await st2.putData('trust', { trusted: [annaKey] });
	await st2.reload();
	const T3 = await openStation({ store: st2, crypto: C, hydra: H });
	await T3.replay();
	check('import: precious after replay', (await st2.frames('precious')).length, (await st.frames('precious')).length);
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
