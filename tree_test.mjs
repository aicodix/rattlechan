// Tests for tree.js. Run with: node tree_test.mjs
// Signed posts go through a station in memory, as received; the tree
// gathers them into conversations on boards, direct ones and the inbox.

import { readFile } from 'node:fs/promises';
import { posts, conversations, boards } from './tree.js';
import { openStation } from './station.js';
import { memoryBackend, openStore } from './storage.js';
import { loadCrypto } from './crypto.js';
import { compose, bundled } from './sender.js';
import { smallestText } from './encodings.js';
import * as R from './records.js';

let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
const C = await loadCrypto(await readFile(new URL('./crypto.wasm', import.meta.url)));
const S = await openStation({ store: await openStore(memoryBackend()), crypto: C });

const anna = C.newPrivateKey(), jan = C.newPrivateKey(), eve = C.newPrivateKey(), me = C.newPrivateKey();
const keyOf = (k) => hex(C.fingerprint(k));
const sign = (k) => (...records) => C.signRecords(k, ...records);
let clock = 1763380000000, ts = 1763380000;
const idOf = (e) => hex(e.nodes[0].children.find((n) => n.id).id);
const send = async (k, args, bytes = null) => S.receive(bytes ?? compose({ timestamp: ++ts, sign: sign(k), ...args }), { arrival: clock += 1000 });

// a board post with replies, nested
const cq = await send(anna, { kind: 'topic', subject: 'CQ', text: 'anyone?' });
const a1 = await send(jan, { kind: 'reply', parent: Uint8Array.from(Buffer.from(idOf(cq), 'hex')), text: 'here' });
const a2 = await send(anna, { kind: 'reply', parent: Uint8Array.from(Buffer.from(idOf(a1), 'hex')), text: 'hi Jan' });
const a3 = await send(eve, { kind: 'reply', parent: Uint8Array.from(Buffer.from(idOf(cq), 'hex')), text: 'me too' });

// the same post again counts once
await send(anna, null, compose({ kind: 'topic', subject: 'CQ', text: 'anyone?', timestamp: ts - 3, sign: sign(anna) }));

// a group board
const club = await send(jan, { kind: 'topic', subject: 'Meeting', text: 'Friday', to: { group: 'club' } });

// unsigned posts stay out
await send(null, null, compose({ kind: 'topic', subject: 'unsigned', text: 'x', timestamp: ++ts }));

// direct: to my key, with a stranger butting in
const toMe = await send(anna, { kind: 'topic', subject: 'For you', text: 'only you', to: { key: C.fingerprint(me) } });
const pid = (e) => Uint8Array.from(Buffer.from(idOf(e), 'hex'));
const myAnswer = await send(me, { kind: 'reply', parent: pid(toMe), text: 'thanks' });
const butt = await send(eve, { kind: 'reply', parent: pid(toMe), text: 'hello?' });
await send(anna, { kind: 'reply', parent: pid(butt), text: 'go away' });

// direct by call sign: the first key that replies is the recipient
const toCall = await send(jan, { kind: 'topic', subject: 'Sked', text: '20m?', to: { call: 'DL1ABC' } });
await send(eve, { kind: 'reply', parent: pid(toCall), text: 'I am DL1ABC' });
await send(anna, { kind: 'reply', parent: pid(toCall), text: 'no, I am' });

// by name, maybe for me
await send(jan, { kind: 'topic', subject: 'Hi Mia', text: '?', to: { name: 'Mia' } });

// an orphan: a Reply to a post never received
const orphan = await send(jan, { kind: 'reply', parent: new Uint8Array(32).fill(7), text: 'lost' });

const all = posts(S.entries());
check('posts: signed ones once each', all.size, 14);
check('posts: unsigned left out', [...all.values()].some((p) => p.node.type === R.T.TOPIC && R.decodeText(p.node.subject) === 'unsigned'), false);
check('posts: first arrival', all.get(idOf(cq)).arrival, cq.arrival);

const mine = { keys: new Set([keyOf(me)]), calls: new Set(['DL1ABC']), names: [smallestText('Mia').slice(0)] };
const list = conversations(S.entries(), mine);
const conv = (e) => list.find((c) => c.root.id === idOf(e));
const cqc = conv(cq);
check('board: everyone', cqc.place.board, 'everyone');
check('thread: all four posts', cqc.posts.length, 4);
check('thread: nested', cqc.root.children.map((p) => p.id).join(), [idOf(a1), idOf(a3)].join());
check('thread: grandchild', cqc.root.children[0].children[0].id, idOf(a2));
check('board thread: nothing hidden', cqc.hidden.size, 0);
check('board thread: not mine', cqc.inbox, null);
check('group board', conv(club).place.board, hex(R.textUTF8('club')));

const d = conv(toMe);
check('direct', d.place.kind, 'direct');
check('direct: in my inbox by key', d.inbox, 'key');
check('direct: author and recipient', [...d.participants].sort().join(), [keyOf(anna), keyOf(me)].sort().join());
check('direct: the stranger and the answer under it hidden', d.hidden.size, 2);
check('direct: my answer shown', d.hidden.has(all.get(idOf(myAnswer))), false);

const dc = conv(toCall);
check('to a call sign: in the inbox', dc.inbox, 'call');
check('to a call sign: the first to reply counts', dc.participants.has(keyOf(eve)), true);
check('to a call sign: the second hidden', dc.hidden.size, 1);

check('to a name: maybe for me', list.find((c) => c.root.node.type === R.T.TOPIC && R.decodeText(c.root.node.subject) === 'Hi Mia').inbox, 'name');
check('orphan: elsewhere', conv(orphan).place.kind, 'elsewhere');
check('newest activity first', list[0].last >= list.at(-1).last, true);

const b = boards(list);
check('boards: everyone, the club, elsewhere', b.map((x) => x.board === 'everyone' || x.board === 'elsewhere' ? x.board : R.decodeText(x.name)).join(), 'everyone,club,elsewhere');
check('boards: direct ones not on a board', b.some((x) => x.conversations.includes(d)), false);

// the orphan joins its thread once the parent arrives
{
	const S2 = await openStation({ store: await openStore(memoryBackend()), crypto: C });
	const topic = compose({ kind: 'topic', subject: 'late', text: 'parent', timestamp: 1, sign: sign(anna) });
	const tid = R.parse(topic, { verify: C.verify })[0].children[0].id;
	await S2.receive(compose({ kind: 'reply', parent: tid, text: 'early', timestamp: 2, sign: sign(jan) }), { arrival: 1 });
	check('orphan first', conversations(S2.entries())[0].place.kind, 'elsewhere');
	await S2.receive(topic, { arrival: 2 });
	const l2 = conversations(S2.entries());
	check('then one conversation of two', l2.length === 1 && l2[0].posts.length, 2);
}

// collected posts of one key, bundled in one Signed record: each where it
// would be alone, the call sign learned from the From in front of them
{
	const S3 = await openStation({ store: await openStore(memoryBackend()), crypto: C });
	const posts = [
		{ kind: 'topic', subject: 'Board', text: 'to everyone', timestamp: 10 },
		{ kind: 'topic', subject: 'Club', text: 'to the club', to: { group: 'club' }, timestamp: 11 },
		{ kind: 'topic', subject: 'Direct', text: 'to me', to: { key: C.fingerprint(me) }, timestamp: 12 },
	];
	await S3.receive(R.payload([bundled({ posts, callSign: 'OK1XYZ', sign: sign(anna) }), bundled({ posts: [{ kind: 'topic', subject: 'Other', text: 'jan too', timestamp: 13 }], sign: sign(jan) })]), { arrival: 5 });
	const l3 = conversations(S3.entries(), mine);
	const by = (subj) => l3.find((c) => R.decodeText(c.root.node.subject) === subj);
	check('bundle: all four posts', l3.length, 4);
	check('bundle: on everyone', by('Board').place.board, 'everyone');
	check('bundle: on the club board', by('Club').place.board, hex(R.textUTF8('club')));
	check('bundle: direct, in my inbox', by('Direct').inbox, 'key');
	check('bundle: the other key\'s post', by('Other').root.key, keyOf(jan));
	check('bundle: the call sign learned', S3.keyInfo(keyOf(anna)).callSign, 'OK1XYZ');
	const alone = R.parse(compose({ ...posts[0], sign: sign(anna) }), { verify: C.verify })[0].children[0];
	check('bundle: the same ID as alone', by('Board').root.id, hex(alone.id));
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
