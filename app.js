// The page: tabs, the log of everything received, and the station's
// receiver and storage. The work is done in station.js and receiver.js.

import { opfsBackend, memoryBackend, openStore, TIERS } from './storage.js';
import { exportArchive, importArchive } from './archive.js';
import { loadCrypto } from './crypto.js';
import { loadHydra } from './hydra.js';
import { openStation } from './station.js';
import { listen, inputs, decodeRecording } from './receiver.js';
import * as view from './render.js';

const $ = (id) => document.getElementById(id);
const MiB = 1024 * 1024;
// the log shows this many entries; the store keeps more
const SHOWN = 300;

// per-viewer conveniences, which may be unavailable
const remember = (key, value) => {
	try {
		localStorage.setItem(`rattlechan.${key}`, value);
	} catch {}
};
const recall = (key) => {
	try {
		return localStorage.getItem(`rattlechan.${key}`);
	} catch {
		return null;
	}
};

const status = (text, cls = 'dim') => {
	$('status').textContent = text;
	$('status').className = cls;
};

// ---------------------------------------------------------------- tabs

function showTab(name) {
	for (const b of document.querySelectorAll('nav [role=tab]')) {
		const on = b.dataset.tab === name;
		b.setAttribute('aria-selected', on);
		$(b.dataset.tab).hidden = !on;
	}
	remember('tab', name);
	if (name === 'station')
		refreshStorage();
}

for (const b of document.querySelectorAll('nav [role=tab]'))
	b.onclick = () => showTab(b.dataset.tab);

// ------------------------------------------------------------- startup

if ('serviceWorker' in navigator)
	navigator.serviceWorker.register('sw.js').catch(() => {});

let store, station, persistent = false;
try {
	store = await openStore(await opfsBackend());
} catch {
	store = await openStore(memoryBackend());
	status('this browser offers no file storage: nothing is kept', 'warn');
}
try {
	persistent = await navigator.storage.persisted();
} catch {}

const [crypto, hydra] = await Promise.all([
	loadCrypto().catch(() => null),
	loadHydra().catch(() => null),
]);
station = openStation({ store, crypto, hydra });

// ----------------------------------------------------------------- log

let shown = 0;

function add(element) {
	$('log-empty').hidden = true;
	$('entries').prepend(element);
	if (++shown > SHOWN) {
		$('entries').lastElementChild.remove();
		--shown;
		$('log-more').hidden = false;
		$('log-more').textContent = `Only the newest ${SHOWN} are shown.`;
	}
}

for (const e of await station.replay())
	add(view.entry(e));

if (!crypto || !hydra)
	status(`${!crypto ? 'CRYPTO' : 'HYDRA'} failed to load: ${!crypto ? 'signatures stay unchecked' : 'fragments stay apart'}`, 'warn');
else if ($('status').textContent === 'starting …')
	status(`${shown} frames`);

// ------------------------------------------------------------- receiving

let lastStorageRefresh = 0;
let receiving = false;

async function handle(events) {
	const arrival = Date.now();
	for (const ev of events) {
		if (ev.type === 'sync') {
			receiving = true;
			status('receiving …', 'ok');
		} else if (ev.type === 'meta') {
			status(`receiving from ${ev.callSign || '—'}, mode ${ev.mode} …`, 'ok');
		} else if (ev.type === 'frame') {
			receiving = false;
			try {
				const e = await station.receive(ev.payload, {
					arrival, callSign: ev.callSign || null, mode: ev.mode, snr: ev.snr, bitFlips: ev.bitFlips,
				});
				add(view.entry(e));
				status(`frame from ${ev.callSign || '—'}`);
			} catch (err) {
				add(view.el('article.entry', view.head(arrival, ev.callSign), view.el('div.bad', `not kept: ${err.message}`)));
			}
		} else {
			receiving = false;
			add(view.event(ev, arrival));
			if (ev.type === 'error')
				status(`${ev.what} error`, 'warn');
		}
	}
	if (events.some((e) => e.type === 'frame') && Date.now() - lastStorageRefresh > 2000)
		refreshStorage();
}

// one report after the other, so frames are stored in the order they came
let queue = Promise.resolve();
const enqueue = (events) => {
	queue = queue.then(() => handle(events)).catch((err) => status(err.message, 'bad'));
	return queue;
};

let receiver = null;
let wakeLock = null;

// the clipping warning stays on for 2 seconds instead of blinking
let hotUntil = 0;
const level = (peak) => {
	// -60..0 dBFS over the width of the meter
	const db = peak > 0 ? 20 * Math.log10(peak) : -60;
	$('level').style.width = `${Math.max(0, Math.min(100, (db + 60) / 60 * 100))}%`;
	if (peak > 0.9)
		hotUntil = Date.now() + 2000;
	$('level').classList.toggle('hot', Date.now() < hotUntil);
};

// a phone stops the microphone once its screen goes dark
async function keepAwake() {
	try {
		if (receiver && document.visibilityState === 'visible' && 'wakeLock' in navigator)
			wakeLock = await navigator.wakeLock.request('screen');
	} catch {}
}
document.addEventListener('visibilitychange', keepAwake);

async function fillInputs(current) {
	const sel = $('input');
	const list = await inputs().catch(() => []);
	sel.replaceChildren(view.el('option', 'default input'));
	sel.firstChild.value = '';
	for (const d of list) {
		if (!d.deviceId || d.deviceId === 'default')
			continue;
		const o = view.el('option', d.label || `input ${sel.length}`);
		o.value = d.deviceId;
		sel.append(o);
	}
	sel.value = [...sel.options].some((o) => o.value === current) ? current : '';
}

async function startListening() {
	$('listen').disabled = true;
	try {
		receiver = await listen({
			deviceId: $('input').value || recall('input') || null,
			onReport: (r) => {
				level(r.peak);
				if (r.events.length) {
					enqueue(r.events);
				} else if (!r.busy && receiving) {
					receiving = false;
					status('listening');
				}
			},
		});
		$('listen').textContent = 'Stop';
		$('receiver').textContent = `Listening at ${receiver.rate} Hz${receiver.label ? ` on ${receiver.label}` : ''}.`;
		status('listening');
		await fillInputs(receiver.deviceId);
		keepAwake();
	} catch (err) {
		receiver = null;
		$('receiver').textContent = `Can't listen: ${err.message}`;
		status('not listening', 'warn');
	}
	$('listen').disabled = false;
}

async function stopListening() {
	const r = receiver;
	receiver = null;
	await r?.stop();
	wakeLock?.release().catch(() => {});
	wakeLock = null;
	level(0);
	$('listen').textContent = 'Listen';
	$('receiver').textContent = 'Not listening.';
	status('not listening');
}

$('listen').onclick = () => receiver ? stopListening() : startListening();

$('input').onchange = async () => {
	remember('input', $('input').value);
	if (receiver) {
		await stopListening();
		await startListening();
	}
};

$('recording').onchange = async () => {
	const file = $('recording').files[0];
	$('recording').value = '';
	if (!file)
		return;
	$('receiver').textContent = `Decoding ${file.name} …`;
	try {
		const events = await decodeRecording(new Uint8Array(await file.arrayBuffer()));
		await enqueue(events);
		const n = events.filter((e) => e.type === 'frame').length;
		$('receiver').textContent = `${file.name}: ${n} frame${n === 1 ? '' : 's'}.`;
		showTab('log');
	} catch (err) {
		$('receiver').textContent = `Can't decode ${file.name}: ${err.message}`;
	}
};

// ------------------------------------------------------------- storage

async function refreshStorage() {
	lastStorageRefresh = Date.now();
	const settings = await store.settings();
	for (const tier of TIERS) {
		$(`used-${tier}`).textContent = view.bytes(await store.usage(tier));
		if (document.activeElement !== $(`budget-${tier}`))
			$(`budget-${tier}`).value = Math.round(settings.budgets[tier] / MiB);
	}
	let est = null;
	try {
		est = await navigator.storage.estimate();
	} catch {}
	try {
		persistent = await navigator.storage.persisted();
	} catch {}
	const p = $('persist');
	p.replaceChildren(
		persistent ? view.el('span.ok', 'Persistent: the browser keeps this data.') : view.el('span.warn', 'Not persistent.'),
		est ? ` ${view.bytes(est.usage)} of ${view.bytes(est.quota)} used.` : '');
	$('install-hint').hidden = persistent;
	$('last-export').textContent = settings.lastExport ? `Last export ${view.when(settings.lastExport)}.` : 'Never exported.';
}

for (const tier of TIERS)
	$(`budget-${tier}`).onchange = async (e) => {
		const mib = Number(e.target.value);
		if (!Number.isFinite(mib) || mib < 0)
			return refreshStorage();
		const gone = await store.setSettings({ budgets: { [tier]: Math.round(mib * MiB) } });
		$('import-result').textContent = gone.length ? `${gone.length} frames evicted.` : '';
		refreshStorage();
	};

function download(bytes, name) {
	const a = view.el('a');
	a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }));
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

$('export').onclick = async () => {
	download(await exportArchive(store.backend), `rattlechan-${stamp()}.tar.gz`);
	await store.setSettings({ lastExport: Date.now() });
	refreshStorage();
};

$('export-secrets').onclick = async () => {
	download(await exportArchive(store.backend, { secrets: true }), `rattlechan-secrets-${stamp()}.tar.gz`);
};

$('import').onchange = async () => {
	const file = $('import').files[0];
	$('import').value = '';
	if (!file)
		return;
	try {
		const r = await importArchive(store.backend, new Uint8Array(await file.arrayBuffer()));
		const gone = await store.reload();
		$('import-result').textContent = `${file.name}: ${r.added.length} added, ${r.kept.length} already there, ${r.skipped.length} skipped${gone.length ? `, ${gone.length} evicted` : ''}.`;
		// rebuild the log from the store
		station = openStation({ store, crypto, hydra });
		$('entries').replaceChildren();
		shown = 0;
		for (const e of await station.replay())
			add(view.entry(e));
		$('log-empty').hidden = shown > 0;
	} catch (err) {
		$('import-result').textContent = `Can't import ${file.name}: ${err.message}`;
	}
	refreshStorage();
};

// ---------------------------------------------------------- appearance

// System follows the browser; Light or Dark is kept on this device only
const THEME_COLOR = { light: '#f7f6f3', dark: '#1c1b1a' };

function applyTheme(theme) {
	if (theme === 'light' || theme === 'dark')
		document.documentElement.dataset.theme = theme;
	else
		delete document.documentElement.dataset.theme;
	// the browser's bar: both tags follow the pick, or each its own scheme
	for (const meta of document.querySelectorAll('meta[name=theme-color]')) {
		const own = meta.media.includes('dark') ? 'dark' : 'light';
		meta.content = THEME_COLOR[THEME_COLOR[theme] ? theme : own];
	}
}

$('theme').value = document.documentElement.dataset.theme ?? '';
applyTheme($('theme').value);
$('theme').onchange = () => {
	remember('theme', $('theme').value);
	applyTheme($('theme').value);
};

// ---------------------------------------------------------- danger zone

$('delete-confirm').oninput = () => {
	$('delete-all').disabled = $('delete-confirm').value !== 'DELETE';
};

// everything the station keeps, the offline copy of the app and what the
// page remembers, except the appearance, which belongs to the device
$('delete-all').onclick = async () => {
	$('delete-all').disabled = true;
	$('delete-confirm').value = '';
	try {
		if (receiver)
			await stopListening();
		await queue;
		const n = await store.clear();
		try {
			await caches.delete('rattlechan');
		} catch {}
		try {
			for (const key of Object.keys(localStorage))
				if (key.startsWith('rattlechan.') && key !== 'rattlechan.theme')
					localStorage.removeItem(key);
		} catch {}
		station = openStation({ store, crypto, hydra });
		$('entries').replaceChildren();
		shown = 0;
		$('log-empty').hidden = false;
		$('log-more').hidden = true;
		$('import-result').textContent = '';
		$('delete-result').textContent = `Deleted ${n} file${n === 1 ? '' : 's'}.`;
		status('all data deleted');
	} catch (err) {
		$('delete-result').textContent = `Can't delete: ${err.message}`;
	}
	refreshStorage();
};

// Chrome offers installing through its own prompt
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => {
	e.preventDefault();
	installPrompt = e;
	$('install').hidden = false;
});
$('install').onclick = async () => {
	installPrompt?.prompt();
	installPrompt = null;
	$('install').hidden = true;
};

showTab(recall('tab') === 'station' ? 'station' : 'log');
