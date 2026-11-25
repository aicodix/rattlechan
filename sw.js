// Service worker: makes Rattlechan work offline. Installing it fetches the
// whole app, so it works without the network even for what this device
// hasn't used yet, such as the modem modules of the other sample rate.
// Requests go to the network first, so a new version shows up on the next
// load; the cache answers when the network doesn't. Each time the app is
// opened online, every file is fetched again in the background, so files
// it didn't load this time don't go stale either. sw_test.mjs checks FILES
// against what the page and its modules load.

const CACHE = 'rattlechan';

const FILES = [
	'./',
	'index.html',
	'app.css',
	'manifest.webmanifest',
	'icon.svg',
	'icon-180.png',
	'icon-192.png',
	'icon-512.png',
	'icon-maskable-192.png',
	'icon-maskable-512.png',
	'app.js',
	'archive.js',
	'blake2s.js',
	'capture_worklet.js',
	'crypto.js',
	'decoder_worker.js',
	'encodings.js',
	'hydra.js',
	'keys.js',
	'pictures.js',
	'receiver.js',
	'records.js',
	'render.js',
	'robusto.js',
	'scsu.js',
	'sender.js',
	'station.js',
	'storage.js',
	'tar.js',
	'transmitter.js',
	'tree.js',
	'version.js',
	'wasm.js',
	'crypto.wasm',
	'hydra.wasm',
	'robusto_decoder_44100.wasm',
	'robusto_decoder_48000.wasm',
	'robusto_encoder_44100.wasm',
	'robusto_encoder_48000.wasm',
];

// every file, fetched past the browser's HTTP cache
async function fetchAll() {
	const cache = await caches.open(CACHE);
	await cache.addAll(FILES.map((f) => new Request(f, { cache: 'no-cache' })));
}

self.addEventListener('install', (e) => e.waitUntil(fetchAll().then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
	const req = e.request;
	if (req.method !== 'GET' || new URL(req.url).origin !== location.origin)
		return;
	e.respondWith((async () => {
		const cache = await caches.open(CACHE);
		try {
			const res = await fetch(req, { cache: 'no-cache' });
			if (res.ok)
				await cache.put(req, res.clone());
			// the app opened online: bring the rest up to date too
			if (req.mode === 'navigate')
				e.waitUntil(fetchAll().catch(() => {}));
			return res;
		} catch (err) {
			const hit = await cache.match(req, { ignoreSearch: true });
			if (hit)
				return hit;
			throw err;
		}
	})());
});
