// Tests for version.js. Run with: node version_test.mjs

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { appFiles, fingerprint, running } from './version.js';

let checks = 0, failed = 0;
function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log(`FAIL ${name}`);
		console.log(`  got  ${got}`);
		console.log(`  want ${want}`);
	}
}

const here = new URL('./', import.meta.url);
const disk = async (f) => new Uint8Array(await readFile(new URL(f, here)));

// the files sw.js lists, the page's own URL left out, sw.js last
const list = appFiles(new TextDecoder().decode(await disk('sw.js')));
check('files: without ./', list.includes('./'), false);
check('files: the page', list.includes('index.html'), true);
check('files: this module', list.includes('version.js'), true);
check('files: sw.js last', list.at(-1), 'sw.js');
check('files: each once', new Set(list).size, list.length);

// 8 hex digits, the same for the same files, changed by any byte, name or order
const a = [['a.js', Uint8Array.of(1, 2, 3)], ['b.css', Uint8Array.of(4)]];
const fp = fingerprint(a);
check('fingerprint: 8 hex digits', /^[0-9a-f]{8}$/.test(fp), true);
check('fingerprint: the same again', fingerprint(a.map(([n, b]) => [n, b.slice()])), fp);
check('fingerprint: a byte changed', fingerprint([['a.js', Uint8Array.of(1, 2, 4)], a[1]]) !== fp, true);
check('fingerprint: a name changed', fingerprint([['c.js', a[0][1]], a[1]]) !== fp, true);
check('fingerprint: the order changed', fingerprint([a[1], a[0]]) !== fp, true);
// a byte moved from one file to the next isn't the same files
check('fingerprint: a byte moved across files', fingerprint([['a.js', Uint8Array.of(1, 2)], ['b.css', Uint8Array.of(3, 4)]]) !== fp, true);

// the app as it runs is the checkout as version.mjs sees it
const app = await running(disk);
check('running: 8 hex digits', /^[0-9a-f]{8}$/.test(app), true);
check('version.mjs prints the same', execFileSync('node', ['version.mjs'], { cwd: here }).toString().trim(), app);
// a file of the app changed changes it
check('running: a changed file shows', await running(async (f) => {
	const b = await disk(f);
	return f === 'app.css' ? Uint8Array.from([...b, 0x20]) : b;
}) !== app, true);

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
