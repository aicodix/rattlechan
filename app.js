// The page: tabs, the log of everything received and sent, sending, and
// the station's settings, receiver and storage. The work is done in
// station.js, sender.js, receiver.js and transmitter.js.

import { opfsBackend, memoryBackend, openStore, TIERS } from './storage.js';
import { exportArchive, importArchive } from './archive.js';
import { loadCrypto } from './crypto.js';
import { loadHydra } from './hydra.js';
import { openStation } from './station.js';
import { listen, inputs, decodeRecording } from './receiver.js';
import { compose, split, chain, pick, secondsFor, airtime, needs, SECONDS_DEFAULT, SNR_DEFAULT, REDUNDANCY_DEFAULT } from './sender.js';
import { output, encoderFor, play } from './transmitter.js';
import { encodeCall } from './records.js';
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
// ----------------------------------------------------------------- log

// what the log shows, newest last: () => element, so it can be drawn
// again when trust changes what an entry looks like
let items = [];

function add(draw) {
	items.push(draw);
	$('log-empty').hidden = true;
	$('entries').prepend(draw());
	if (items.length > SHOWN) {
		items.shift();
		$('entries').lastElementChild.remove();
		$('log-more').hidden = false;
		$('log-more').textContent = `Only the newest ${SHOWN} are shown.`;
	}
}

function redraw() {
	$('entries').replaceChildren(...items.map((draw) => draw()).reverse());
	$('log-empty').hidden = items.length > 0;
}

// a fresh station on the store, its frames in the log
async function restart() {
	station = await openStation({ store, crypto, hydra });
	items = [];
	$('entries').replaceChildren();
	$('log-more').hidden = true;
	for (const e of await station.replay())
		add(() => view.entry(e));
	$('log-empty').hidden = items.length > 0;
}

// asking before trusting, then moving the key's frames
view.configure({
	keyInfo: (key) => station.keyInfo(key),
	trust: async (key, on) => {
		if (on && !await view.confirmTrust(key))
			return;
		await station.setTrust(key, on);
		redraw();
		refreshStorage();
	},
	reply: (id) => {
		replyTo = id;
		setKind('reply');
		showTab('send');
		$('text').focus();
	},
});

await restart();

if (!crypto || !hydra)
	status(`${!crypto ? 'CRYPTO' : 'HYDRA'} failed to load: ${!crypto ? 'signatures stay unchecked' : 'fragments stay apart'}`, 'warn');
else if ($('status').textContent === 'starting …')
	status(`${items.length} frames`);

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
				add(() => view.entry(e));
				status(`frame from ${ev.callSign || '—'}`);
			} catch (err) {
				const message = err.message;
				add(() => view.el('article.entry', view.head(arrival, ev.callSign), view.el('div.bad', `not kept: ${message}`)));
			}
		} else {
			receiving = false;
			add(() => view.event(ev, arrival));
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
				// the station doesn't listen to itself
				if (Date.now() < deafUntil)
					return;
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
		await restart();
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
		await restart();
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

// ----------------------------------------------------------------- sending

// the station's own settings: call sign, name, seconds per frame, SNR
// threshold, extra blocks
const own = async () => {
	const s = (await store.settings()).station ?? {};
	return {
		callSign: s.callSign ?? '',
		name: s.name ?? '',
		seconds: s.seconds ?? SECONDS_DEFAULT,
		snr: s.snr ?? SNR_DEFAULT,
		redundancy: s.redundancy ?? REDUNDANCY_DEFAULT,
	};
};

async function fillOwn() {
	const o = await own();
	$('call-sign').value = o.callSign;
	$('name').value = o.name;
	$('frame-seconds').value = o.seconds;
	$('snr').value = o.snr;
	$('redundancy').value = Math.round(o.redundancy * 100);
}

const validCall = (c) => {
	try {
		encodeCall(c);
		return /^[A-Z0-9/-]{1,9}$/.test(c);
	} catch {
		return false;
	}
};

async function saveOwn() {
	const call = $('call-sign').value.trim().toUpperCase();
	$('call-sign').value = call;
	const ok = !call || validCall(call);
	$('call-sign').setCustomValidity(ok ? '' : 'up to 9 of A-Z, 0-9, - and /');
	$('call-sign').reportValidity();
	const seconds = Math.min(60, Math.max(1, Math.round(Number($('frame-seconds').value) || SECONDS_DEFAULT)));
	const redundancy = Math.min(1, Math.max(0, (Number($('redundancy').value) || 0) / 100));
	const snr = Math.min(30, Math.max(1, Number($('snr').value) || SNR_DEFAULT));
	const old = await own();
	await store.setSettings({ station: { callSign: ok ? call : old.callSign, name: $('name').value.trim(), seconds, snr, redundancy } });
	await fillOwn();
	estimate();
}

for (const id of ['call-sign', 'name', 'frame-seconds', 'snr', 'redundancy'])
	$(id).onchange = saveOwn;

let kind = 'topic';
let replyTo = null;
// receiving pauses while sending and a moment after, so the station
// doesn't decode its own signal from the microphone
let deafUntil = 0;
let sending = null;

function setKind(k) {
	kind = k;
	for (const b of document.querySelectorAll('.segmented [role=radio]'))
		b.setAttribute('aria-checked', b.dataset.kind === k);
	$('subject-field').hidden = k !== 'topic';
	$('reply-to').hidden = k !== 'reply' || !replyTo;
	$('reply-hint').hidden = k !== 'reply' || !!replyTo;
	if (replyTo)
		$('reply-to').replaceChildren('Reply to ', view.el('span.key', view.short(replyTo)));
	estimate();
}

for (const b of document.querySelectorAll('.segmented [role=radio]'))
	b.onclick = () => setKind(b.dataset.kind);

// the post as it stands, or null with the reason
async function draft() {
	const o = await own();
	const text = $('text').value;
	if (!text.trim())
		return { why: 'Write something.' };
	if (kind === 'topic' && !$('subject').value.trim())
		return { why: 'A topic needs a subject.' };
	if (kind === 'reply' && !replyTo)
		return { why: 'Pick a post to reply to.' };
	const payload = compose({
		kind, subject: $('subject').value.trim(), text, parent: replyTo,
		callSign: o.callSign || null, name: o.name || null,
	});
	return { payload, o };
}

// what the post would take on the air, updated while typing
let estimating = 0;
async function estimate() {
	const mine = ++estimating;
	await new Promise((r) => setTimeout(r, 250));
	if (mine !== estimating)
		return;
	let d;
	try {
		d = await draft();
	} catch (err) {
		d = { why: err.message };
	}
	$('send-button').disabled = !d.payload || !!sending;
	if (!d.payload) {
		$('send-info').textContent = d.why;
		return;
	}
	// the modes are the same at both rates, so the estimate uses 48000
	const E = await encoderFor(48000);
	const anon = d.o.callSign ? '' : ' Sent as ANONYMOUS.';
	const describe = (p) => {
		const info = E.modeInfo(p.modes[0]);
		return `${info.modulation} ${info.codeRate}, decodes from ${needs(p.modes[0])} dB`;
	};
	const fits = pick(E, d.payload.length, d.o) !== null;
	$('send-choice').hidden = fits;
	if (fits) {
		const p = plan(E, d, 'fragments');
		$('send-info').textContent = `${view.bytes(d.payload.length)} in one frame of ${p.airtime.toFixed(1)} s, ${describe(p)}.${anon}`;
		return;
	}
	$('send-info').textContent = `${view.bytes(d.payload.length)}.${anon}`;
	const choice = (how, span, label) => {
		const radio = document.querySelector(`input[name=how][value=${how}]`);
		try {
			const p = plan(E, d, how);
			radio.disabled = false;
			$(span).textContent = label(p);
		} catch (err) {
			radio.disabled = true;
			$(span).textContent = err.message;
		}
	};
	choice('fragments', 'choice-fragments', (p) => `${p.frames.length} fragments of ${E.modeInfo(p.modes[0]).seconds.toFixed(1)} s, any ${p.K} of them enough, ${p.airtime.toFixed(1)} s in all, ${describe(p)}`);
	choice('longer', 'choice-longer', (p) => `one frame of ${p.airtime.toFixed(1)} s, ${describe(p)}`);
	const radios = [...document.querySelectorAll('input[name=how]')];
	if (radios.find((r) => r.checked)?.disabled)
		radios.find((r) => !r.disabled)?.click();
	$('send-button').disabled = !d.payload || !!sending || radios.every((r) => r.disabled);
}

// How a draft goes on the air, at the settings or, with how = 'longer', in
// one frame as long as it needs. Returns what split() gives, with the
// seconds and SNR used, the modes and the airtime.
function plan(E, d, how) {
	const { snr, redundancy } = d.o;
	let seconds = d.o.seconds;
	if (how === 'longer') {
		seconds = secondsFor(E, d.payload.length, snr);
		if (seconds === null)
			throw new RangeError(`too long for one frame at ${snr} dB`);
	}
	const s = split(d.payload, { encoder: E, hydra, seconds, snr, redundancy });
	const lengths = s.frames.map((f) => f.length);
	return { ...s, seconds, snr, modes: lengths.map((n) => pick(E, n, { seconds, snr })), airtime: airtime(E, lengths, { seconds, snr }) };
}

for (const r of document.querySelectorAll('input[name=how]'))
	r.onchange = estimate;

// typing starts the next post
const typed = () => {
	if (!sending)
		$('send-status').textContent = '';
	estimate();
};
$('subject').oninput = typed;
$('text').oninput = typed;

$('send-button').onclick = async () => {
	$('send-button').disabled = true;
	try {
		const d = await draft();
		if (!d.payload)
			throw new Error(d.why);
		const ctx = await output();
		const E = await encoderFor(ctx.sampleRate);
		const callSign = d.o.callSign || 'ANONYMOUS';
		const how = document.querySelector('input[name=how]:checked')?.value ?? 'fragments';
		const s = plan(E, d, pick(E, d.payload.length, d.o) !== null ? 'fragments' : how);
		const c = chain(E, s.frames, { seconds: s.seconds, snr: s.snr, callSign });
		// the station's own frames, kept as sent
		const arrival = Date.now();
		for (const [i, f] of s.frames.entries()) {
			const e = await station.sent(f, { arrival, callSign: d.o.callSign || null, mode: c.modes[i] });
			add(() => view.entry(e));
		}
		deafUntil = Infinity;
		sending = play(ctx, c.audio);
		$('send-stop').hidden = false;
		$('send-status').textContent = `Sending ${s.frames.length === 1 ? 'one frame' : `${s.frames.length} fragments`}, ${c.seconds.toFixed(1)} s …`;
		status('sending', 'ok');
		const complete = await sending.done;
		$('send-status').textContent = complete ? 'Sent.' : 'Stopped.';
		if (complete) {
			$('text').value = '';
			$('subject').value = '';
			replyTo = null;
			setKind(kind === 'reply' ? 'topic' : kind);
		}
	} catch (err) {
		$('send-status').textContent = `Can't send: ${err.message}`;
	}
	sending = null;
	deafUntil = Date.now() + 1500;
	$('send-stop').hidden = true;
	status(receiver ? 'listening' : 'not listening');
	refreshStorage();
	estimate();
};

$('send-stop').onclick = () => sending?.stop();

await fillOwn();
setKind('topic');

const startTab = recall('tab');
showTab(['station', 'send'].includes(startTab) ? startTab : 'log');
