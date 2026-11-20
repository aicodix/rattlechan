// Tests for archive.js. Run with: node archive_test.mjs

import { exportArchive, importArchive, gzip, gunzip } from './archive.js';
import { memoryBackend, openStore } from './storage.js';
import { writeTar, readTar } from './tar.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

const hex = (a) => a && Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
const names = async (archive) => readTar(await gunzip(archive)).map((f) => f.name).sort().join();

// a station with a bit of everything
const backend = memoryBackend();
const S = await openStore(backend);
const f1 = await S.addFrame(Uint8Array.of(0x40, 2, 0x48, 0x69), { callSign: 'DL1ABC', mode: 65 });
const f2 = await S.addFrame(new Uint8Array(3000).fill(7));
const rev = new Uint8Array(99);
rev[0] = 0x20;
rev[1] = 97;
rev.fill(9, 2, 34);
rev[98] = 0x28;
const r1 = await S.addRevocation(rev, 1000);
await S.putData('trust', { trusted: ['09'.repeat(32)] });
await S.putData('settings', { budget: 5000 });
await S.putSecret('keys', { me: 'ab'.repeat(32) });

// ------------------------------------------------------------ export

const data = await exportArchive(backend);
const secrets = await exportArchive(backend, { secrets: true });
check('gzip magic', hex(data.subarray(0, 2)), '1f8b');
check('data archive', await names(data), [
	'rattlechan/data/settings.json', 'rattlechan/data/trust.json',
	`rattlechan/frames/${f1}`, `rattlechan/frames/${f2}`, `rattlechan/revocations/${r1}`].sort().join());
check('secrets archive', await names(secrets), 'rattlechan/secrets/keys.json');
check('no secrets in the data', (await names(data)).includes('secrets'), false);

// ------------------------------------------------------------ import

{
	const fresh = memoryBackend();
	let r = await importArchive(fresh, data);
	check('import adds everything', r.added.length, 5);
	const T = await openStore(fresh);
	check('frames restored', (await T.frames()).map((f) => f.name).join(), [f1, f2].join());
	check('frame bytes restored', hex(await T.readFrame(f1)), '40024869');
	check('preamble data restored', (await T.frames())[0].callSign, 'DL1ABC');
	check('revocation restored', hex(await T.readRevocation(r1)), hex(rev));
	check('settings restored', (await T.settings()).budget, 5000);
	check('no keys without the secrets archive', await T.getSecret('keys'), null);
	r = await importArchive(fresh, secrets);
	check('secrets imported', (await T.getSecret('keys')).me, 'ab'.repeat(32));

	// importing again keeps what is there
	await T.putData('trust', { trusted: [] });
	r = await importArchive(fresh, data);
	check('second import adds nothing', r.added.length, 0);
	check('second import keeps all', r.kept.length, 5);
	check('local changes survive', (await T.getData('trust')).trusted.length, 0);
}

// ------------------------------------------------ hostile archives

{
	const evil = await gzip(writeTar([
		{ name: '../escape.bin', bytes: new Uint8Array(1) },
		{ name: 'rattlechan/../../escape.bin', bytes: new Uint8Array(1) },
		{ name: 'rattlechan/other/x.bin', bytes: new Uint8Array(1) },
		{ name: 'rattlechan/frames/.hidden', bytes: new Uint8Array(1) },
		{ name: 'rattlechan/frames/a/b.bin', bytes: new Uint8Array(1) },
		{ name: 'elsewhere/frames/x.bin', bytes: new Uint8Array(1) },
		{ name: 'rattlechan/data/ok.json', bytes: new TextEncoder().encode('{}') },
	]));
	const target = memoryBackend();
	const r = await importArchive(target, evil);
	check('only the safe file', r.added.join(), 'data/ok.json');
	check('the rest skipped', r.skipped.length, 6);
	let threw = false;
	try {
		await importArchive(target, Uint8Array.of(1, 2, 3));
	} catch {
		threw = true;
	}
	check('not a gzip file', threw, true);
}

// the system's tar opens the export
if (spawnSync('tar', ['--version']).status === 0) {
	const dir = mkdtempSync(join(tmpdir(), 'archive_test-'));
	try {
		writeFileSync(join(dir, 'export.tar.gz'), data);
		const listed = spawnSync('tar', ['-tzf', join(dir, 'export.tar.gz')], { encoding: 'utf8' });
		check('system tar lists the export', listed.stdout.trim().split('\n').sort().join(), await names(data));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
