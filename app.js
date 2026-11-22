// The page: tabs, the log of everything received and sent, sending, and
// the station's settings, receiver and storage. The work is done in
// station.js, sender.js, receiver.js and transmitter.js.

import { opfsBackend, memoryBackend, openStore, TIERS } from './storage.js';
import { exportArchive, importArchive } from './archive.js';
import { loadCrypto } from './crypto.js';
import { loadHydra } from './hydra.js';
import { openStation } from './station.js';
import { listen, inputs, decodeRecording } from './receiver.js';
import { compose, composeAvatar, split, chain, pick, secondsFor, airtime, needs, SECONDS_DEFAULT, SNR_DEFAULT, REDUNDANCY_DEFAULT } from './sender.js';
import { output, encoderFor, play } from './transmitter.js';
import { encodeCall, decodeText, fromCall, fromName } from './records.js';
import { smallestText } from './encodings.js';
import { openKeys } from './keys.js';
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

// the station's own keys by fingerprint, filled by fillKeys()
let ownKeys = new Map();

// what the page knows about a key: an own key says who it is from the key
// list, before any post has
function keyInfo(key) {
	const info = station.keyInfo(key);
	const own = ownKeys.get(key);
	return own ? { ...info, own: true, callSign: own.callSign, name: own.name } : { ...info, own: false };
}

// whether an entry holds a revocation the station acts on
const revokes = (e) => [e.facts, ...(e.fragments ?? []).map((f) => f.facts)].some((f) => f?.revocations.length);

// after a revocation: the key cards, Sign as and the log change
async function revoked() {
	await fillKeys();
	redraw();
	refreshStorage();
}

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
	// an own key says who it is from the key list, before any post has
	keyInfo: (key) => keyInfo(key),
	trust: async (key, on) => {
		if (on && !await view.confirmTrust(key))
			return;
		await station.setTrust(key, on);
		await fillKeys();
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
				if (revokes(e))
					await revoked();
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
				// the meter keeps showing the input, but the station
				// doesn't decode itself
				level(r.peak);
				if (Date.now() < deafUntil)
					return;
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
		await trustOwn();
		await fillKeys();
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
		await trustOwn();
		await fillKeys();
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

// the station's own settings: the preamble's call sign, seconds per frame,
// SNR threshold, extra blocks
const own = async () => {
	const s = (await store.settings()).station ?? {};
	return {
		callSign: s.callSign ?? '',
		seconds: s.seconds ?? SECONDS_DEFAULT,
		snr: s.snr ?? SNR_DEFAULT,
		redundancy: s.redundancy ?? REDUNDANCY_DEFAULT,
	};
};

async function fillOwn() {
	const o = await own();
	$('call-sign').value = o.callSign;
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
	await store.setSettings({ station: { callSign: ok ? call : old.callSign, seconds, snr, redundancy } });
	await fillOwn();
	estimate();
}

for (const id of ['call-sign', 'frame-seconds', 'snr', 'redundancy'])
	$(id).onchange = saveOwn;

// ------------------------------------------------------------------ keys

const keys = crypto ? await openKeys(store, crypto) : null;
const fromHex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));

// keys held here count as trusted, also those an import brought
async function trustOwn() {
	let moved = false;
	for (const k of keys ? await keys.list() : [])
		if (!station.isTrusted(k.key)) {
			await station.setTrust(k.key, true);
			moved = true;
		}
	if (moved)
		redraw();
}

// a call sign field: upper case, and checked
function callField(input) {
	const call = input.value.trim().toUpperCase();
	input.value = call;
	const ok = !call || validCall(call);
	input.setCustomValidity(ok ? '' : 'up to 9 of A-Z, 0-9, - and /');
	input.reportValidity();
	return ok ? call : null;
}

// The revocations of a key on paper, one page each, in a window of their
// own to print. Everything goes in as text.
function printRevocations(k) {
	const w = window.open('', '_blank');
	if (!w)
		return false;
	const d = w.document;
	d.title = `Revocations of ${k.label}`;
	const el = (tag, text, style) => {
		const e = d.createElement(tag);
		if (text)
			e.textContent = text;
		if (style)
			e.style.cssText = style;
		return e;
	};
	const groups = (h, per) => h.match(/.{1,4}/g).reduce((lines, g, i) => {
		if (i % per === 0)
			lines.push([]);
		lines[lines.length - 1].push(g);
		return lines;
	}, []).map((l) => l.join(' ')).join('\n');
	d.body.style.cssText = 'font: 12pt/1.4 system-ui, sans-serif; color: #000; background: #fff; margin: 1.5cm;';
	const notes = {
		retired: 'This revokes the key with the fingerprint below as retired: its owner no longer uses it, for instance after becoming a silent key. If the owner can\'t send it anymore, please send this code over Rattlechan: stations then mark later posts by this key as signed by a retired key.',
		compromised: 'This revokes the key with the fingerprint below as compromised: lost or stolen. Send this code over Rattlechan as soon as the key may be in someone else\'s hands: stations then stop trusting every post by this key.',
	};
	for (const reason of ['retired', 'compromised']) {
		const page = el('section', null, 'page-break-after: always; break-after: page;');
		page.append(
			el('h1', `Rattlechan revocation: ${reason}`, 'font-size: 18pt;'),
			el('p', notes[reason]),
			el('p', `Fingerprint of ${k.label}${k.callSign ? `, ${k.callSign}` : ''}${k.name ? `, ${k.name}` : ''}:`),
			el('pre', groups(k.key, 8), 'font: 11pt ui-monospace, monospace;'),
			el('p', 'Revocation, 99 bytes, to send as it is:'),
			el('pre', groups(k.revocations[reason], 8), 'display: inline-block; font: 13pt ui-monospace, monospace; border: 1px solid #000; padding: 8pt;'),
			el('p', 'Anyone holding this sheet can revoke the key, so keep it safe, as you would the key itself.', 'font-size: 10pt;'));
		d.body.append(page);
	}
	w.focus();
	w.print();
	return true;
}

function keyCard(k) {
	const field = (label, value, attrs = {}) => {
		const input = view.el('input');
		input.value = value ?? '';
		Object.assign(input, attrs);
		return [view.el('label.field', label, input), input];
	};
	const [labelField, label] = field('Label', k.label, { dir: 'auto' });
	const [callFieldEl, call] = field('From-Call', k.callSign, { autocapitalize: 'characters', spellcheck: false, maxLength: 9, placeholder: 'none' });
	const [nameField, name] = field('From-Name', k.name, { dir: 'auto', placeholder: 'none' });
	const save = async () => {
		const c = callField(call);
		try {
			await keys.update(k.key, { label: label.value.trim() || k.label, callSign: c ?? k.callSign, name: name.value.trim() });
		} catch (err) {
			$('new-key-result').textContent = err.message;
		}
		fillKeys();
	};
	label.onchange = call.onchange = name.onchange = save;
	const print = view.el('button.small', 'Print revocations');
	print.onclick = () => {
		if (!printRevocations(k))
			$('new-key-result').textContent = 'The browser blocked the window to print in.';
	};
	const confirm = view.el('input');
	confirm.placeholder = 'DELETE';
	confirm.setAttribute('aria-label', 'type DELETE to remove this key');
	confirm.autocomplete = 'off';
	const removeNow = view.el('button.small.danger', 'Remove key');
	removeNow.disabled = true;
	confirm.oninput = () => {
		removeNow.disabled = confirm.value !== 'DELETE';
	};
	removeNow.onclick = async () => {
		await keys.remove(k.key);
		fillKeys();
	};
	const removeArea = view.el('div.remove-confirm',
		view.el('p.warn', 'Export secrets and keep the printed revocations first: without them, a removed key can never be revoked. Type DELETE to remove it.'),
		view.el('div.row', confirm, removeNow));
	removeArea.hidden = true;
	const remove = view.el('button.small', 'Remove…');
	remove.onclick = () => {
		removeArea.hidden = !removeArea.hidden;
	};
	// what the station knows of its revocations
	const { revoked } = station.keyInfo(k.key);
	const state = revoked.compromised !== null ? view.el('p.bad', `Compromised since ${view.when(revoked.compromised)}: it no longer signs, and stations that trust it stop trusting all its posts.`)
		: revoked.retired !== null ? view.el('p.warn', `Retired since ${view.when(revoked.retired)}: it no longer signs.`)
		: view.el('p.ok', 'Active');
	// sending one of its revocations, permanent, so behind typing REVOKE;
	// compromised overrides retired, never the other way round
	const reason = view.el('select');
	reason.setAttribute('aria-label', 'reason');
	for (const [value, text] of [['retired', 'retired: no longer used'], ['compromised', 'compromised: lost or stolen']])
		if (revoked[value] === null && revoked.compromised === null) {
			const o = view.el('option', text);
			o.value = value;
			reason.append(o);
		}
	reason.value = 'compromised';
	const word = view.el('input');
	word.placeholder = 'REVOKE';
	word.setAttribute('aria-label', 'type REVOKE to send the revocation');
	word.autocomplete = 'off';
	const revokeNow = view.el('button.small.danger', 'Send revocation');
	revokeNow.disabled = true;
	word.oninput = () => {
		revokeNow.disabled = word.value !== 'REVOKE';
	};
	const revokeStop = view.el('button.small', 'Stop');
	revokeStop.hidden = true;
	const revokeStatus = view.el('p.dim');
	revokeNow.onclick = async () => {
		revokeNow.disabled = true;
		const say = (t) => {
			revokeStatus.textContent = t;
		};
		try {
			const d = { payload: fromHex(k.revocations[reason.value]), o: await own(), raw: true };
			if (await transmit(d, 'longer', say, revokeStop))
				word.value = '';
		} catch (err) {
			say(`Can't send: ${err.message}`);
		}
		revokeNow.disabled = word.value !== 'REVOKE';
	};
	const revokeArea = view.el('div.revoke-confirm',
		view.el('p.warn', 'A revocation can never be taken back: stations that trust this key mark it retired, or stop trusting every post by it if compromised. Type REVOKE to send it.'),
		reason,
		view.el('div.row', word, revokeNow, revokeStop),
		revokeStatus);
	revokeArea.hidden = true;
	// its avatar: a WebP file as it is, sent now and then from here
	const avatarInfo = view.el('p.dim');
	const file = view.el('input');
	file.type = 'file';
	file.accept = 'image/webp,.webp';
	file.hidden = true;
	file.onchange = async () => {
		const f = file.files[0];
		if (!f)
			return;
		try {
			await keys.update(k.key, { avatar: new Uint8Array(await f.arrayBuffer()) });
			fillKeys();
		} catch (err) {
			avatarInfo.textContent = `${f.name}: ${err.message}.`;
		}
	};
	const choose = view.el('button.small', k.avatar ? 'Change avatar…' : 'Choose avatar…');
	choose.onclick = () => file.click();
	const dropAvatar = view.el('button.small', 'Remove avatar');
	dropAvatar.hidden = !k.avatar;
	dropAvatar.onclick = async () => {
		await keys.update(k.key, { avatar: null });
		fillKeys();
	};
	const sendAvatar = view.el('button.small', 'Send avatar');
	sendAvatar.hidden = !k.avatar || revoked.retired !== null || revoked.compromised !== null;
	const avatarStop = view.el('button.small', 'Stop');
	avatarStop.hidden = true;
	const avatarFinish = view.el('button.small', 'Finish');
	avatarFinish.hidden = true;
	const stepBox = view.el('input');
	stepBox.type = 'checkbox';
	stepBox.checked = oneAtATime();
	stepBox.onchange = () => setOneAtATime(stepBox.checked);
	const stepField = view.el('label.check', stepBox, view.el('span', 'fragments one at a time, pressing Send for each'));
	stepField.hidden = sendAvatar.hidden;
	sendAvatar.onclick = async () => {
		sendAvatar.disabled = true;
		const say = (t) => {
			avatarInfo.textContent = t;
		};
		try {
			await transmit(await avatarDraft(k), 'fragments', say, avatarStop, stepBox.checked ? { next: sendAvatar, finish: avatarFinish } : null);
		} catch (err) {
			say(`Can't send: ${err.message}`);
		}
		sendAvatar.disabled = false;
	};
	if (k.avatar && !sendAvatar.hidden)
		avatarDraft(k).then(async (d) => {
			const p = plan(await encoderFor(48000), d, 'fragments');
			avatarInfo.textContent = `${view.bytes(k.avatar.length)} WebP, on the air as ${p.frames.length === 1 ? 'one frame' : `${p.frames.length} fragments, any ${p.K} of them enough`}, ${p.airtime.toFixed(1)} s. Stations that trust this key show it beside its posts.`;
		}).catch((err) => {
			avatarInfo.textContent = err.message;
		});
	else if (!k.avatar)
		avatarInfo.textContent = 'No avatar: stations show the identicon. An avatar is a square WebP picture or animation from 128x128 to 512x512 pixels in at most 8 KiB; stations ignore any other.';
	const revoke = view.el('button.small', 'Revoke…');
	revoke.hidden = reason.options.length === 0;
	revoke.onclick = () => {
		revokeArea.hidden = !revokeArea.hidden;
	};
	const icon = view.identicon(fromHex(k.key));
	const card = view.el('article.key-card',
		view.el('div.key-card-head', k.avatar ? view.withAvatar(icon, k.avatar) : icon, view.el('strong', k.label), view.el('span.key', k.key.slice(0, 8))),
		state,
		labelField, callFieldEl, nameField,
		view.el('div.row', choose, dropAvatar, sendAvatar, avatarStop, avatarFinish, file),
		stepField,
		avatarInfo,
		view.el('div.row', print, revoke, remove),
		revokeArea,
		removeArea);
	view.touchToPlay(card);
	return card;
}

// an Avatar post of an own key, signed, with its From-Call and From-Name
async function avatarDraft(k) {
	const payload = composeAvatar({ avatar: k.avatar, callSign: k.callSign, name: k.name, sign: await keys.signer(k.key) });
	return { payload, o: await own() };
}

// the key list in Station and the choice in Send
async function fillKeys() {
	const list = keys ? await keys.list() : [];
	const shown = (m) => JSON.stringify([...m].sort());
	const before = shown(ownKeys);
	ownKeys = new Map(list.map((k) => [k.key, { callSign: k.callSign, name: k.name }]));
	if (shown(ownKeys) !== before)
		redraw();
	$('key-list').replaceChildren(...list.map(keyCard));
	const sel = $('signer');
	const was = sel.value || recall('signer');
	// a revoked key signs nothing new
	const active = list.filter((k) => {
		const r = station.keyInfo(k.key).revoked;
		return r.retired === null && r.compromised === null;
	});
	sel.replaceChildren(...active.map((k) => {
		const o = view.el('option', [k.label, k.callSign, k.name].filter(Boolean).join(' · '));
		o.value = k.key;
		return o;
	}));
	if (active.some((k) => k.key === was))
		sel.value = was;
	$('no-keys').textContent = list.length ? 'Every key here is revoked: add a new key in Station first.' : 'Every post is signed: add a key in Station first.';
	$('no-keys').hidden = active.length > 0;
	$('signer-field').hidden = active.length === 0;
	estimate();
}

$('signer').onchange = () => {
	remember('signer', $('signer').value);
	estimate();
};

$('new-key-button').onclick = async () => {
	if (!keys) {
		$('new-key-result').textContent = 'CRYPTO failed to load: no keys.';
		return;
	}
	const call = callField($('new-call'));
	if (call === null)
		return;
	const fields = { label: $('new-label').value.trim() || 'Personal', callSign: call, name: $('new-name').value.trim() };
	try {
		const priv = $('new-private').value.trim();
		const k = priv ? await keys.import(priv, fields) : await keys.create(fields);
		for (const id of ['new-label', 'new-call', 'new-name', 'new-private'])
			$(id).value = '';
		$('new-key').open = false;
		$('new-key-result').textContent = `Added ${k.label}. Print its revocations and export secrets now.`;
		remember('signer', k.key);
		await trustOwn();
		await fillKeys();
	} catch (err) {
		$('new-key-result').textContent = err.message;
	}
};

let kind = 'topic';
let replyTo = null;
// while sending and a moment after, the decoder's reports are ignored, so
// the station doesn't decode its own signal from the microphone; the
// microphone and the decoder keep running
let deafUntil = 0;
let sending = null;
// while fragments go out one at a time, between them too
let stepping = false;

function setKind(k) {
	kind = k;
	for (const b of document.querySelectorAll('.segmented [role=radio]'))
		b.setAttribute('aria-checked', b.dataset.kind === k);
	$('signing').hidden = k === 'hex';
	$('subject-field').hidden = k !== 'topic';
	$('to-field').hidden = k !== 'topic';
	$('text-field').hidden = k === 'hex';
	$('hex-hint').hidden = k !== 'hex';
	$('hex-field').hidden = k !== 'hex';
	$('hex-preview').hidden = k !== 'hex';
	$('reply-to').hidden = k !== 'reply' || !replyTo;
	$('reply-hint').hidden = k !== 'reply' || !!replyTo;
	if (replyTo)
		$('reply-to').replaceChildren('Reply to ', view.el('span.key', view.short(replyTo)));
	estimate();
}

for (const b of document.querySelectorAll('.segmented [role=radio]'))
	b.onclick = () => setKind(b.dataset.kind);

// where a Topic goes: everyone, or a call sign, fingerprint, name or board
const TO = {
	call: ['Call sign', 'Anyone may answer; their fingerprint becomes known when they do. Call signs get reassigned, so prefer a fingerprint once you know it.'],
	key: ['Fingerprint', 'The only reliable direct conversation: by default only replies signed with that fingerprint show. Pick a fingerprint from your log, or paste its 64 hex characters.'],
	name: ['Name', 'Names aren\'t unique, so the recipient sees it as "maybe for you".'],
	group: ['Board', 'A group name works like a channel: anyone can post to it.'],
};

// the keys seen in the log, to pick from
function fillKnownKeys() {
	$('known-keys').replaceChildren(...station.seen().map((k) => {
		const info = keyInfo(k.key);
		const name = info.name && (typeof info.name === 'string' ? info.name : decodeText(info.name));
		const revoked = info.revoked.compromised !== null ? 'compromised' : info.revoked.retired !== null ? 'retired' : null;
		const o = view.el('option', [info.own ? 'your key' : info.trusted ? 'trusted' : null, revoked, info.callSign, name, k.key.slice(0, 8)].filter(Boolean).join(' · '));
		o.value = k.key;
		return o;
	}));
}

function setTo() {
	const to = $('to-kind').value;
	$('to-value-field').hidden = !to;
	$('to-hint').hidden = !to;
	if (to) {
		$('to-value-label').textContent = TO[to][0];
		$('to-hint').textContent = TO[to][1];
	}
	$('to-value').autocapitalize = to === 'call' ? 'characters' : 'off';
	if (to === 'key') {
		fillKnownKeys();
		$('to-value').setAttribute('list', 'known-keys');
	} else {
		$('to-value').removeAttribute('list');
	}
	estimate();
}

$('to-kind').onchange = () => {
	$('to-value').value = '';
	setTo();
	$('to-value').focus();
};
$('to-value').oninput = estimate;

// the address of a Topic as compose() takes it, or { why }
function address() {
	const to = $('to-kind').value;
	const v = $('to-value').value.trim();
	if (!to)
		return { to: null };
	if (!v)
		return { why: `Who is it for? Enter a ${TO[to][0].toLowerCase()}.` };
	if (to === 'call') {
		const call = v.toUpperCase();
		return validCall(call) ? { to: { call } } : { why: 'A call sign is up to 9 of A-Z, 0-9, - and /.' };
	}
	if (to === 'key') {
		const h = v.toLowerCase().replace(/\s+/g, '');
		return /^[0-9a-f]{64}$/.test(h) ? { to: { key: fromHex(h) } } : { why: 'A fingerprint is 64 hex characters.' };
	}
	return { to: to === 'name' ? { name: v } : { group: v } };
}

// the post as it stands, signed, or null with the reason
async function draft() {
	const o = await own();
	if (kind === 'hex') {
		const h = $('hex').value.replace(/\s+/g, '').toLowerCase();
		if (!h)
			return { why: 'Paste a payload in hex.' };
		if (!/^[0-9a-f]+$/.test(h))
			return { why: 'Only hex digits, spaces and line breaks.' };
		if (h.length % 2)
			return { why: 'An odd number of hex digits.' };
		return { payload: fromHex(h), o, raw: true };
	}
	const k = keys && (await keys.list()).find((x) => x.key === $('signer').value);
	if (!k)
		return { why: keys ? $('no-keys').textContent : 'CRYPTO failed to load, so nothing can be signed.' };
	// the choice to include call sign and name, for keys that have them
	// the key's call sign and name, each on its own with what it costs
	const offer = (what, value, bytes) => {
		$(`include-${what}-field`).hidden = !value;
		if (value) {
			$(`include-${what}-what`).textContent = value;
			$(`include-${what}-size`).textContent = view.bytes(bytes(value));
		}
		return !!value && $(`include-${what}`).checked;
	};
	const withCall = offer('call', k.callSign, (c) => fromCall(c).length);
	const withName = offer('name', k.name, (n) => fromName(smallestText(n)).length);
	// and to include its avatar, for keys that have one
	$('include-avatar-field').hidden = !k.avatar;
	if (k.avatar)
		$('include-avatar-size').textContent = view.bytes(k.avatar.length);
	const withAvatar = !!k.avatar && $('include-avatar').checked;
	const text = $('text').value;
	if (!text.trim())
		return { why: 'Write something.' };
	if (kind === 'topic' && !$('subject').value.trim())
		return { why: 'A topic needs a subject.' };
	if (kind === 'reply' && !replyTo)
		return { why: 'Pick a post to reply to.' };
	const where = kind === 'topic' ? address() : { to: null };
	if (where.why)
		return { why: where.why };
	const payload = compose({
		kind, subject: $('subject').value.trim(), text, parent: replyTo,
		// the key's call sign and name only when asked for: they cost bytes,
		// and stations remember them from earlier posts
		callSign: withCall ? k.callSign : null, name: withName ? k.name : null, to: where.to,
		sign: await keys.signer(k.key),
		avatar: withAvatar ? k.avatar : null,
	});
	return { payload, o };
}

// what the post would take on the air, updated while typing
let estimating = 0;
async function estimate() {
	if (stepping)
		return;
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
	$('hex-preview').replaceChildren();
	if (!d.payload) {
		// nothing to send, so no choice of how
		$('send-choice').hidden = true;
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
	if (d.raw) {
		// what stations would make of it, sent all the same
		const a = station.analyze(d.payload);
		$('hex-preview').replaceChildren(a.error ? view.el('div.bad', `malformed: ${a.error}; stations drop it`) : a.nodes.length ? view.nodes(a.nodes) : view.el('div.dim', 'empty frame'));
		$('send-choice').hidden = true;
		try {
			const p = plan(E, d, 'longer');
			$('send-info').textContent = `${view.bytes(d.payload.length)} in one frame of ${p.airtime.toFixed(1)} s, ${describe(p)}.${anon}`;
		} catch (err) {
			$('send-info').textContent = err.message;
			$('send-button').disabled = true;
		}
		return;
	}
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
	// one at a time is a way of sending fragments
	$('one-at-a-time').closest('label').hidden = radios.find((r) => r.checked)?.value !== 'fragments';
	$('send-button').disabled = !d.payload || !!sending || radios.every((r) => r.disabled);
}

// How a draft goes on the air, at the settings or, with how = 'longer', in
// one frame as long as it needs. Returns what split() gives, with the
// seconds and SNR used, the modes and the airtime.
function plan(E, d, how) {
	const { snr, redundancy } = d.o;
	let seconds = d.o.seconds;
	if (how === 'longer' && pick(E, d.payload.length, { seconds, snr }) === null) {
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
$('one-at-a-time').onchange = () => setOneAtATime($('one-at-a-time').checked);

// typing starts the next post
const typed = () => {
	if (!sending)
		$('send-status').textContent = '';
	estimate();
};
$('include-call').onchange = estimate;
$('include-name').onchange = estimate;
$('include-avatar').onchange = estimate;
$('subject').oninput = typed;
$('text').oninput = typed;
$('hex').oninput = typed;

// Puts a draft on the air: in one frame if it fits the settings, otherwise
// as Fragments or, with how = 'longer', in one longer frame. Logs the
// station's own frames as they went out, tells say() how it goes and shows
// stop while sending. Fragments go out all at once, chained, or with step
// = { next, finish } (two buttons) one at a time, each its own
// transmission with its leading noise, next sending the next and finish
// ending early. Resolves to true once it went out or was finished, false
// if stopped.
async function transmit(d, how, say, stop, step = null) {
	if (sending || stepping)
		throw new Error('already sending');
	const ctx = await output();
	const E = await encoderFor(ctx.sampleRate);
	const callSign = d.o.callSign || 'ANONYMOUS';
	const s = plan(E, d, how);
	const opts = { seconds: s.seconds, snr: s.snr, callSign };
	const n = s.frames.length;
	// one transmission: frames chained back to back, kept once all went out
	const air = async (frames, what) => {
		const c = chain(E, frames, opts);
		const arrival = Date.now();
		deafUntil = Infinity;
		sending = play(ctx, c.audio);
		$('send-button').disabled = true;
		stop.onclick = () => sending?.stop();
		stop.hidden = false;
		say(`Sending ${what}, ${c.seconds.toFixed(1)} s …`);
		status('sending', 'ok');
		try {
			const complete = await sending.done;
			if (!complete)
				return false;
			// a revocation among them counts from then on
			let revoking = false;
			for (const [i, f] of frames.entries()) {
				const e = await station.sent(f, { arrival, callSign: d.o.callSign || null, mode: c.modes[i] });
				add(() => view.entry(e));
				revoking ||= revokes(e);
			}
			if (revoking)
				await revoked();
			return true;
		} finally {
			sending = null;
			deafUntil = Date.now() + 1500;
			stop.hidden = true;
			status(receiver ? 'listening' : 'not listening');
			refreshStorage();
		}
	};
	if (!step || n === 1) {
		try {
			const complete = await air(s.frames, n === 1 ? 'one frame' : `${n} fragments`);
			say(complete ? 'Sent.' : 'Stopped.');
			return complete;
		} finally {
			estimate();
		}
	}
	// one at a time: the operator presses next for each after the first
	const label = step.next.textContent;
	const handler = step.next.onclick;
	stepping = true;
	lockSend(true);
	try {
		for (let i = 0; i < n; ++i) {
			if (i) {
				say(`Fragment ${i} of ${n} sent, ${i >= s.K ? 'enough to decode' : `any ${s.K} needed`}. Ready for the next? Press Send.`);
				const go = await new Promise((resolve) => {
					step.next.textContent = `Send fragment ${i + 1} of ${n}`;
					step.next.disabled = false;
					step.next.onclick = () => resolve(true);
					step.finish.onclick = () => resolve(false);
					step.finish.hidden = false;
				});
				step.finish.hidden = true;
				if (!go) {
					say(`Finished after ${i} of ${n} fragments${i < s.K ? `, fewer than the ${s.K} needed` : ''}.`);
					return true;
				}
			}
			if (!await air([s.frames[i]], `fragment ${i + 1} of ${n}`)) {
				say(`Stopped at fragment ${i + 1} of ${n}.`);
				return false;
			}
		}
		say(`Sent all ${n} fragments.`);
		return true;
	} finally {
		stepping = false;
		step.next.textContent = label;
		step.next.onclick = handler;
		step.finish.hidden = true;
		lockSend(false);
		estimate();
	}
}

// the post can't change while its fragments go out one at a time
function lockSend(on) {
	for (const e of document.querySelectorAll('#send input, #send textarea, #send select, #send .segmented button'))
		e.disabled = on;
}

// fragments one at a time, as the operator last chose
const oneAtATime = () => recall('oneAtATime') === '1';
const setOneAtATime = (on) => {
	remember('oneAtATime', on ? '1' : '0');
	$('one-at-a-time').checked = on;
};

$('send-button').onclick = async () => {
	$('send-button').disabled = true;
	const say = (t) => {
		$('send-status').textContent = t;
	};
	try {
		const d = await draft();
		if (!d.payload)
			throw new Error(d.why);
		const how = d.raw ? 'longer' : document.querySelector('input[name=how]:checked')?.value ?? 'fragments';
		const step = how === 'fragments' && oneAtATime() ? { next: $('send-button'), finish: $('send-finish') } : null;
		if (await transmit(d, how, say, $('send-stop'), step)) {
			$('text').value = '';
			$('subject').value = '';
			$('hex').value = '';
			$('include-call').checked = false;
			$('include-name').checked = false;
			$('include-avatar').checked = false;
			$('to-kind').value = '';
			$('to-value').value = '';
			setTo();
			replyTo = null;
			setKind(kind === 'reply' ? 'topic' : kind);
		}
	} catch (err) {
		say(`Can't send: ${err.message}`);
		estimate();
	}
};

await fillOwn();
await trustOwn();
await fillKeys();
$('one-at-a-time').checked = oneAtATime();
setKind('topic');

const startTab = recall('tab');
showTab(['station', 'send'].includes(startTab) ? startTab : 'log');
