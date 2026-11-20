// Service worker: makes Rattlechan work offline once it has been opened.
// Network first, so a new version shows up on the next load; the cache
// answers when the network doesn't.

const CACHE = 'rattlechan';

self.addEventListener('install', () => self.skipWaiting());
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
			return res;
		} catch (err) {
			const hit = await cache.match(req, { ignoreSearch: true });
			if (hit)
				return hit;
			throw err;
		}
	})());
});
