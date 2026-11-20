// Tests for tar.js. Run with: node tar_test.mjs
// Cross-checks with the system's tar where there is one.

import { writeTar, readTar } from './tar.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
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

function throws(name, fn) {
	++checks;
	try {
		fn();
		++failed;
		console.log('FAIL', name, 'did not throw');
	} catch {}
}

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
const bytes = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
const long = 'rattlechan/data/' + 'n'.repeat(95) + '.json'; // over 100, split into prefix and name
const files = [
	{ name: 'rattlechan/frames/0001763380000000_0001763380000000_DL1ABC_65.bin', bytes: bytes(1000, 1), mtime: 1763380000 },
	{ name: 'rattlechan/data/settings.json', bytes: new TextEncoder().encode('{"budget": 1}\n'), mtime: 1 },
	{ name: 'rattlechan/data/empty.json', bytes: new Uint8Array(0) },
	{ name: 'rattlechan/frames/exactly512.bin', bytes: bytes(512, 2) },
	{ name: long, bytes: bytes(3, 3) },
];

const tar = writeTar(files);
check('tar is whole blocks', tar.length % 512, 0);
const back = readTar(tar);
check('file count', back.length, files.length);
for (let i = 0; i < files.length; ++i) {
	check(`name ${i}`, back[i].name, files[i].name);
	check(`bytes ${i}`, hex(back[i].bytes), hex(files[i].bytes));
	check(`mtime ${i}`, back[i].mtime, files[i].mtime ?? 0);
}
check('empty archive', readTar(writeTar([])).length, 0);

const bad = tar.slice();
bad[10] ^= 1;
throws('bad checksum', () => readTar(bad));
throws('truncated', () => readTar(tar.subarray(0, 700)));
throws('no end', () => readTar(tar.subarray(0, tar.length - 1024)));
throws('name too long', () => writeTar([{ name: 'a/' + 'b'.repeat(101), bytes: new Uint8Array(1) }]));

// the system's tar reads ours and we read its
const sys = spawnSync('tar', ['--version'], { encoding: 'utf8' });
if (sys.status === 0) {
	const dir = mkdtempSync(join(tmpdir(), 'tar_test-'));
	try {
		writeFileSync(join(dir, 'ours.tar'), tar);
		const listed = spawnSync('tar', ['-tf', join(dir, 'ours.tar')], { encoding: 'utf8' });
		check('system tar lists ours', listed.stdout.trim().split('\n').join(), files.map((f) => f.name).join());
		mkdirSync(join(dir, 'out'));
		spawnSync('tar', ['-xf', join(dir, 'ours.tar'), '-C', join(dir, 'out')]);
		check('system tar extracts ours', hex(readFileSync(join(dir, 'out', files[0].name))), hex(files[0].bytes));
		check('system tar extracts long names', hex(readFileSync(join(dir, 'out', long))), hex(files[4].bytes));
		spawnSync('tar', ['--format=ustar', '-cf', join(dir, 'theirs.tar'), '-C', join(dir, 'out'), 'rattlechan']);
		const theirs = readTar(new Uint8Array(readFileSync(join(dir, 'theirs.tar'))));
		const first = theirs.find((f) => f.name === files[0].name);
		check('we read the system tar', first && hex(first.bytes), hex(files[0].bytes));
		check('we read all its files', theirs.length, files.length);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
} else {
	console.log('no system tar, cross-check skipped');
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
