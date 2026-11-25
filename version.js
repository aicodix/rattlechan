// Which version of the app is running: a fingerprint of its files, BLAKE2s
// over each file's name, length and bytes, in the order sw.js lists them,
// sw.js last. GitHub Pages serves the files as they are, without a build
// step, so the page can't know its commit; the fingerprint names exactly
// the files it runs from, an offline copy included. `node version.mjs`
// gives the same for a checkout and finds the commits that have one.

import { BLAKE2s } from './blake2s.js';

// The files sw.js lists, without the page's own URL ('./', which is
// index.html again), then sw.js itself
export function appFiles(sw) {
	const start = sw.indexOf('const FILES = [');
	if (start < 0)
		throw new Error('sw.js lists no files');
	const list = [...sw.slice(start, sw.indexOf('];', start)).matchAll(/'([^']+)'/g)].map((m) => m[1]);
	return [...list.filter((f) => f !== './'), 'sw.js'];
}

// The fingerprint of files, [name, bytes] pairs in order: the first 4 bytes
// of the BLAKE2s-256 over each name, a zero byte, its length (u32, little
// endian) and its bytes, as 8 hex digits
export function fingerprint(files) {
	const h = new BLAKE2s(32);
	const text = new TextEncoder();
	for (const [name, bytes] of files) {
		const n = bytes.length;
		h.update(text.encode(name));
		h.update(Uint8Array.of(0, n & 255, n >> 8 & 255, n >> 16 & 255, n >>> 24));
		h.update(bytes);
	}
	return Array.from(h.digest().subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
}

// The running app's fingerprint: get(name) gives a file's bytes, by default
// fetched next to this module as the page gets it (through the service
// worker: from the network when online, the offline copy otherwise), never
// from the browser's HTTP cache unchecked: after a hard reload the page
// isn't under the service worker, and a cached copy up to ten minutes old
// (GitHub Pages' max-age) could differ from what the reload just fetched
export async function running(get = fetched(new URL('./', import.meta.url))) {
	const sw = await get('sw.js');
	const files = [];
	for (const f of appFiles(new TextDecoder().decode(sw)))
		files.push([f, f === 'sw.js' ? sw : await get(f)]);
	return fingerprint(files);
}

const fetched = (base) => async (name) => {
	const res = await fetch(new URL(name, base), { cache: 'no-cache' });
	if (!res.ok)
		throw new Error(`${name}: ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
};
