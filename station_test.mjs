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
const S = openStation({ store, crypto: C, hydra: H });

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

// a bad signature drops the Signed record, not the frame
const forged = frame.slice();
forged[60] ^= 1;
e = await S.receive(forged, { callSign: 'DL1ABC' });
check('forged: kept', e.name !== null, true);
check('forged: Signed dropped', e.nodes[0].dropped, 'signature');

// malformed frames are dropped and never stored
const before = (await store.frames()).length;
e = await S.receive(Uint8Array.of(0xFF, 1, 2, 3, 4, 5, 6, 7));
check('malformed: error', typeof e.error, 'string');
check('malformed: not stored', e.name, null);
check('malformed: store unchanged', (await store.frames()).length, before);

// a station without CRYPTO leaves signatures unverified
{
	const plain = openStation({ store: await openStore(memoryBackend()) });
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
	const again = openStation({ store, crypto: C, hydra: H });
	const all = await again.replay();
	check('replay: every stored frame', all.length, (await store.frames()).length);
	check('replay: oldest first', all.every((x, i) => !i || all[i - 1].arrival <= x.arrival), true);
	check('replay: preamble kept', all[0].callSign, 'DL1ABC');
	check('replay: mode kept', all[0].mode, 42);
	const rebuilt = all.flatMap((x) => x.fragments).filter((f) => f.nodes);
	check('replay: reassembles again', rebuilt.length === 1 && rebuilt[0].used, long.length);
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
