// Tests for storage.js. Run with: node storage_test.mjs
// Uses the memory backend; storage_test.html runs the same store on OPFS.

import { memoryBackend, openStore, parseFrameName, safeName, BUDGET_DEFAULT } from './storage.js';

let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

async function rejects(name, fn) {
	++checks;
	try {
		await fn();
		++failed;
		console.log('FAIL', name, 'did not throw');
	} catch {}
}

const hex = (a) => a && Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
const frame = (n, v) => new Uint8Array(n).fill(v);
// a Signed(key, Revoke) of 99 bytes
const revocation = (keyByte, reason) => {
	const b = new Uint8Array(99);
	b[0] = 0x20;
	b[1] = 97;
	b.fill(keyByte, 2, 34);
	b[98] = reason === 'compromised' ? 0x29 : 0x28;
	return b;
};

let clock = 1763380000000;
const now = () => clock;

// ------------------------------------------------------------ frames

{
	const S = await openStore(memoryBackend(), { now });
	check('default budget', (await S.settings()).budget, BUDGET_DEFAULT);
	check('100 MiB', BUDGET_DEFAULT, 104857600);
	const a = await S.addFrame(frame(100, 1), { callSign: 'DL1ABC', mode: 65 });
	check('frame name', a, '1763380000000_1763380000000_DL1ABC_65.bin');
	check('frame read back', hex(await S.readFrame(a)), hex(frame(100, 1)));
	const b = await S.addFrame(frame(50, 2), { callSign: 'W1AW/P', arrival: 1763379000000 });
	const f = parseFrameName(b);
	check('call sign with a slash', f.callSign, 'W1AW/P');
	check('same millisecond, next name', f.kept, 1763380000001);
	check('arrival given', f.arrival, 1763379000000);
	check('no mode', f.mode, null);
	const c = await S.addFrame(frame(10, 3));
	check('no call sign', parseFrameName(c).callSign, null);
	check('frames sorted by arrival', (await S.frames()).map((x) => x.name).join(), [b, a, c].join());
	check('usage', await S.usage(), 160);
	await rejects('empty frame', () => S.addFrame(new Uint8Array(0)));
	await rejects('bad call sign', () => S.addFrame(frame(1, 1), { callSign: 'DL1_ABC' }));
	await rejects('bad mode', () => S.addFrame(frame(1, 1), { mode: 256 }));
	await S.removeFrame(c);
	check('removed', (await S.frames()).length, 2);
	check('read removed', await S.readFrame(c), null);
}

// ------------------------------------------------------------ budget

{
	const S = await openStore(memoryBackend(), { now });
	await S.setSettings({ budget: 1000 });
	const names = [];
	for (let i = 0; i < 10; ++i) {
		clock += 1000;
		names.push(await S.addFrame(frame(300, i)));
	}
	check('budget holds three frames', (await S.frames()).length, 3);
	check('the newest stay', (await S.frames()).map((x) => x.name).join(), names.slice(7).join());

	// an avatar frame touched now and then outlives newer frames
	clock += 1000;
	let avatar = await S.addFrame(frame(300, 0xAA), { callSign: 'AVATAR' });
	const arrival = parseFrameName(avatar).arrival;
	for (let i = 0; i < 6; ++i) {
		clock += 1000;
		await S.addFrame(frame(300, i));
		if (i % 2)
			avatar = await S.touch(avatar);
	}
	const kept = await S.frames();
	check('touched frame is still there', kept.some((x) => x.name === avatar), true);
	check('touch keeps the arrival', parseFrameName(avatar).arrival, arrival);
	check('touch keeps the bytes', hex(await S.readFrame(avatar)), hex(frame(300, 0xAA)));
	check('touch of a missing frame', await S.touch('0000000000000_0000000000000_NONE_NONE.bin'), null);
	check('frame bigger than the budget', (await S.setSettings({ budget: 100 })).length, 3);
	check('nothing left', await S.usage(), 0);
}

// ------------------------------------------------------- revocations

{
	const S = await openStore(memoryBackend(), { now });
	await S.setSettings({ budget: 10 });
	const r1 = await S.addRevocation(revocation(1, 'retired'), 1000);
	check('revocation name', r1, '01'.repeat(32) + '_retired_0000000001000.bin');
	check('earliest arrival kept', await S.addRevocation(revocation(1, 'retired'), 500), r1);
	await S.addRevocation(revocation(1, 'compromised'), 2000);
	await S.addRevocation(revocation(2, 'retired'), 3000);
	const all = await S.revocations();
	check('revocations', all.map((r) => `${r.key.slice(0, 2)} ${r.reason}`).join(), '01 retired,01 compromised,02 retired');
	check('outside the budget', hex(await S.readRevocation(r1)), hex(revocation(1, 'retired')));
	await rejects('not a revocation', () => S.addRevocation(new Uint8Array(99)));
	await rejects('wrong length', () => S.addRevocation(revocation(1, 'retired').subarray(0, 98)));
}

// --------------------------------------------------- data and secrets

{
	const backend = memoryBackend();
	const S = await openStore(backend, { now });
	await S.putData('trust', { trusted: ['ab'], denied: [] });
	await S.putSecret('keys', { me: '00'.repeat(32) });
	check('data', (await S.getData('trust')).trusted[0], 'ab');
	check('secret', (await S.getSecret('keys')).me.length, 64);
	check('missing data', await S.getData('nothing'), null);
	check('data is readable JSON', new TextDecoder().decode(await backend.read('data/trust.json')).startsWith('{\n\t"trusted"'), true);
	await rejects('unsafe data name', () => S.putData('../x', 1));
	await rejects('unknown directory', () => backend.write('other/x', new Uint8Array(1)));

	// files written behind the store's back appear after reload()
	check('no frames yet', (await S.frames()).length, 0);
	await backend.write('frames/0000000000005_0000000000005_NONE_NONE.bin', frame(5, 5));
	check('not seen before reload', (await S.frames()).length, 0);
	await S.reload();
	check('seen after reload', (await S.frames()).length, 1);
}

for (const [name, ok] of [['a.bin', true], ['A-b_c.1', true], ['', false], ['.hidden', false], ['a..b', false], ['a/b', false], ['x'.repeat(100), true], ['x'.repeat(101), false]])
	check(`safe name ${JSON.stringify(name.length > 20 ? name.length + ' chars' : name)}`, safeName(name), ok);

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
