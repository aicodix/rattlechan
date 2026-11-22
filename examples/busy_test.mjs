// Tests for busy.mjs. Run with: node examples/busy_test.mjs
// The busy evening goes through the ROBUSTO decoder and a station in
// memory: every frame arrives, and the tree has the boards, threads and
// inbox the example promises, seen as Petr, and everyone's avatar.

import { readFile } from 'node:fs/promises';
import { busy, PEOPLE } from './busy.mjs';
import { wav } from './session.mjs';
import { loadDecoder } from '../robusto.js';
import { loadCrypto } from '../crypto.js';
import { loadHydra } from '../hydra.js';
import { openStation, hex } from '../station.js';
import { memoryBackend, openStore } from '../storage.js';
import { conversations, boards } from '../tree.js';
import { smallestText } from '../encodings.js';
import * as R from '../records.js';

let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

const file = (name) => readFile(new URL(`../${name}`, import.meta.url));
const now = 1763730000, rate = 48000;
const s = await busy({ file, rate, now });
check('the same every time', hex(wav((await busy({ file, rate, now })).audio, rate)) === hex(wav(s.audio, rate)), true);
check('some posts in Fragments', s.items.some((it) => /Fragment/.test(it.what)), true);

const D = await loadDecoder(rate, await file(`robusto_decoder_${rate}.wasm`));
const events = [];
for (let i = 0; i < s.audio.length; i += 4096)
	events.push(...D.feed(s.audio.subarray(i, i + 4096)));
events.push(...D.flush());
const frames = events.filter((e) => e.type === 'frame');
check('every frame arrives', frames.length, s.items.length);

const C = await loadCrypto(await file('crypto.wasm'));
const S = await openStation({ store: await openStore(memoryBackend()), crypto: C, hydra: await loadHydra(await file('hydra.wasm')) });
let arrival = now * 1000;
for (const e of frames)
	await S.receive(e.payload, { callSign: e.callSign, mode: e.mode, arrival: arrival += 1000 });

const petr = hex(C.fingerprint(new Uint8Array(32).fill(PEOPLE.petr.key)));
const me = { keys: new Set([petr]), calls: new Set(['OK1ABC']), names: [smallestText('Petr'), R.textUTF8('Petr')] };
const list = conversations(S.entries(), me);
const conv = (label) => list.find((c) => c.root.id === hex(s.ids[label]));
const b = boards(list);
check('boards', b.map((x) => x.name ? R.decodeText(x.name) : x.board).join(), 'everyone,club,weather,contest,elsewhere');
check('everyone: five conversations', b[0].conversations.length, 5);
check('the bands thread: seven posts', conv('bands').posts.length, 7);
const depth = (p) => p.children.length ? 1 + Math.max(...p.children.map(depth)) : 0;
check('the SWR thread: six levels deep', depth(conv('swr').root), 6);
check('the long post reassembled', !!conv('long'), true);
const why = (label) => conv(label)?.inbox ?? null;
check('inbox: to his fingerprint', why('qsl'), 'key');
check('inbox: to his call sign', why('sked'), 'call');
check('inbox: maybe by name', why('name'), 'name');
check('inbox: his own Topic', why('qrp'), 'mine');
check('inbox: a thread he answered in', why('swr'), 'mine');
check('inbox: the club', why('club'), 'mine');
check('not his: the bands thread', why('bands'), null);
check('not his: Yuki and Tama', why('tama'), null);
check('the stranger hidden', conv('qsl').hidden.size, 1);
check('the orphan elsewhere', conv('orphan').place.kind, 'elsewhere');
check('inbox: six conversations', list.filter((c) => c.inbox).length, 6);

// everyone but the stranger has an avatar, learned beside a post or from an Avatar post of its own
for (const [who, p] of Object.entries(PEOPLE)) {
	const got = S.keyInfo(hex(C.fingerprint(new Uint8Array(32).fill(p.key)))).avatar;
	check(`avatar of ${who}`, got ? hex(got) : null, p.avatar ? hex(await file(`examples/avatars/${who}.webp`)) : null);
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
