// Tests for sw.js. Run with: node sw_test.mjs
// The files the service worker fetches on installing must be everything
// the page loads: what index.html names, every module imported from
// app.js on, the worker and the worklet, and the WebAssembly modules,
// ROBUSTO's at every rate. Nothing else, and every one must exist.

import { readFile, access } from 'node:fs/promises';
import { RATES } from './robusto.js';

let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

const text = (name) => readFile(new URL(name, import.meta.url), 'utf8');
const sw = await text('sw.js');
const listed = [...sw.slice(sw.indexOf('const FILES = ['), sw.indexOf('];', sw.indexOf('const FILES = ['))).matchAll(/'([^']+)'/g)].map((m) => m[1]);

// what the page loads, following the modules
const needed = new Set(['./', 'index.html']);
const html = await text('index.html');
for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g))
	needed.add(m[1]);
const manifest = JSON.parse(await text('manifest.webmanifest'));
for (const icon of manifest.icons)
	needed.add(icon.src);
const todo = [...needed].filter((f) => f.endsWith('.js'));
while (todo.length) {
	const js = await text(todo.pop());
	const found = [
		...[...js.matchAll(/from '\.\/([^']+)'/g)].map((m) => m[1]),
		...[...js.matchAll(/import\('\.\/([^']+)'\)/g)].map((m) => m[1]),
		...[...js.matchAll(/new URL\([`']\.\/([^`']+)[`'], import\.meta\.url\)/g)].map((m) => m[1]),
	];
	for (let f of found) {
		const names = f.includes('${rate}') ? RATES.map((r) => f.replace('${rate}', r)) : [f];
		for (const n of names) {
			if (needed.has(n))
				continue;
			needed.add(n);
			if (n.endsWith('.js'))
				todo.push(n);
		}
	}
}

for (const f of needed)
	check(`listed: ${f}`, listed.includes(f), true);
for (const f of listed)
	check(`needed: ${f}`, needed.has(f), true);
check('listed once each', new Set(listed).size, listed.length);
for (const f of listed.filter((f) => f !== './')) {
	let exists = true;
	try {
		await access(new URL(f, import.meta.url));
	} catch {
		exists = false;
	}
	check(`exists: ${f}`, exists, true);
}
check('no tests', listed.some((f) => f.includes('_test')), false);
check('both rates of modem modules', listed.filter((f) => /^robusto_(en|de)coder_\d+\.wasm$/.test(f)).length, 2 * RATES.length);

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
