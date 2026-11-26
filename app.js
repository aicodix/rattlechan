// The page: tabs, the log of everything received and sent, sending, and
// the station's settings, receiver and storage. The work is done in
// station.js, sender.js, receiver.js and transmitter.js.

import { opfsBackend, memoryBackend, openStore, TIERS } from './storage.js';
import { exportArchive, importArchive } from './archive.js';
import { loadCrypto } from './crypto.js';
import { loadHydra } from './hydra.js';
import { openStation } from './station.js';
import { listen, inputs, decodeRecording } from './receiver.js';
import { sizes, chainParts, chainModes, compose, composeAvatar, bundled, attachment, fileName, FILES_MAX, FILES_MAX_BYTES, fill, pack, split, pick, secondsFor, airtime, needs, SECONDS_DEFAULT, SNR_DEFAULT, REDUNDANCY_DEFAULT } from './sender.js';
import { wake, quiet, encoderFor, play, playParts, LEVEL_DEFAULT, LEVEL_MIN } from './transmitter.js';
import { encodeCall, decodeText, fromCall, fromName, textUTF8, audioInfo, avatarProblem, AVATAR_MAX_BYTES, AVATAR_MIN_PIXELS, AVATAR_MAX_PIXELS, AVATAR_MAX_RATIO, signed as signedRecord, payload as framePayload, encodeLength, walk, T } from './records.js';
import { smallestText } from './encodings.js';
import { openKeys } from './keys.js';
import { conversations, boards } from './tree.js';
import { pictureInfo, huge, trimmed, FORMATS } from './pictures.js';
import * as view from './render.js';
import { running } from './version.js';
import { simd } from './wasm.js';

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
	if (name === 'inbox' || name === 'boards')
		showReading();
	if (name === 'outbox')
		showOutbox();
}

for (const b of document.querySelectorAll('nav [role=tab]'))
	b.onclick = () => showTab(b.dataset.tab);

// ------------------------------------------------------------- startup

if ('serviceWorker' in navigator)
	navigator.serviceWorker.register('sw.js').catch(() => {});

let store, station, persistent = false;
// when the storage figures were last shown
let lastStorageRefresh = 0;
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
	showRelay();
	await fillKeys();
	redraw();
	refreshStorage();
}

// what the log shows, newest last: () => element, so it can be drawn
// again when trust changes what an entry looks like
let items = [];

function add(draw) {
	items.push(draw);
	readingChanged();
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
	readingChanged();
}

// ------------------------------------------------------ inbox and boards

// what is open: a board, and a conversation by its root's ID, per tab
const reading = { inbox: { conversation: null }, boards: { board: null, conversation: null } };
// direct conversations whose posts by others the user opened
const strangersShown = new Set();

// who this station is, for the inbox: its keys, call signs and names,
// a name both in its smallest encoding and in UTF-8
function myself() {
	const calls = new Set([$('call-sign').value.trim().toUpperCase()].filter(Boolean));
	const names = [];
	for (const k of ownKeys.values()) {
		if (k.callSign)
			calls.add(k.callSign);
		if (k.name)
			names.push(smallestText(k.name), textUTF8(k.name));
	}
	return { keys: new Set(ownKeys.keys()), calls, names };
}

// redrawn when frames arrive or trust changes, if a reading tab is open
let readingPending = false;
function readingChanged() {
	if (readingPending || ($('inbox').hidden && $('boards').hidden))
		return;
	readingPending = true;
	setTimeout(() => {
		readingPending = false;
		showReading();
	}, 200);
}

const INBOX_WHY = {
	key: 'to your fingerprint',
	mine: 'you are in it',
	call: (c) => `to ${c.root.to.handle}, call signs get reassigned`,
	name: 'maybe for you, by name',
};

// a post's author in one line: call sign and name once trusted or own,
// otherwise the short fingerprint
function author(p) {
	const info = keyInfo(p.key);
	const name = info.name && (typeof info.name === 'string' ? info.name : decodeText(info.name));
	const who = (info.trusted || info.own) && (info.callSign || name) ? [info.callSign, name].filter(Boolean).join(' ') : `fingerprint ${p.key.slice(0, 8)}`;
	return view.el('span.who', who);
}

// the latest distinct authors of a board, newest first, those with a
// trusted avatar ahead of the others
function recentKeys(conversationList, most = 5) {
	const last = new Map();
	for (const c of conversationList)
		for (const p of c.posts)
			if (!c.hidden.has(p) && !(last.get(p.key) >= p.arrival))
				last.set(p.key, p.arrival);
	const keys = [...last].sort((a, b) => b[1] - a[1]).map(([k]) => k);
	const shown = (k) => {
		const info = station.keyInfo(k);
		return info.trusted && !!info.avatar;
	};
	return [...keys.filter(shown), ...keys.filter((k) => !shown(k))].slice(0, most);
}

function subject(c) {
	const n = c.root.node;
	return n.type === T.TOPIC ? view.textOf(n.subject, 'subject') : view.el('span.dim', `↩ to a post not received, ${c.root.parent.slice(0, 8)}`);
}

// one conversation in a list
function conversationRow(c, open) {
	const shown = c.posts.length - c.hidden.size;
	const why = c.inbox && (typeof INBOX_WHY[c.inbox] === 'function' ? INBOX_WHY[c.inbox](c) : INBOX_WHY[c.inbox]);
	const row = view.el('button.row-card', view.face(c.root.key), view.el('span.row-text',
		view.el('strong', subject(c)),
		view.el('span.dim', author(c.root), ` · ${shown} post${shown === 1 ? '' : 's'}${c.hidden.size ? ` (+${c.hidden.size} from others)` : ''} · ${view.when(c.last)}`),
		why ? view.el(c.inbox === 'name' || c.inbox === 'call' ? 'span.warn' : 'span.ok', why) : ''));
	row.onclick = open;
	return row;
}

// a conversation as a tree: replies under their parents, by arrival,
// indented a few levels at most; in a direct one, posts by others behind
// a button
function thread(c, back, backLabel) {
	const showAll = strangersShown.has(c.root.id);
	const branch = (p, depth) => {
		if (c.hidden.has(p) && !showAll)
			return null;
		const box = view.el(`div.tree-node.depth-${Math.min(depth, 4)}`, view.postBox(p));
		for (const child of p.children) {
			const e = branch(child, depth + 1);
			if (e)
				box.append(e);
		}
		return box;
	};
	const top = view.el('button.small', `← ${backLabel}`);
	top.onclick = back;
	const out = [view.el('div.thread-bar', top), view.el('h2.thread-subject', subject(c))];
	if (c.place.kind === 'direct')
		out.push(view.el('p.dim', 'A direct conversation: only the posts of its two fingerprints show. Everyone in range receives it all the same.'));
	if (c.place.kind === 'elsewhere')
		out.push(view.el('p.dim', 'The post this answers hasn\'t arrived. It joins its conversation once it does.'));
	out.push(branch(c.root, 0));
	if (c.hidden.size) {
		const b = view.el('button.small', showAll ? `Hide the ${c.hidden.size} from others` : `${c.hidden.size} more from others`);
		b.onclick = () => {
			if (showAll)
				strangersShown.delete(c.root.id);
			else
				strangersShown.add(c.root.id);
			showReading();
		};
		out.push(view.el('div.row', b));
	}
	return out;
}

const boardName = (b) => b.board === 'everyone' ? 'Everyone' : b.board === 'elsewhere' ? 'Elsewhere' : view.textOf(b.name, 'board-name');

function showReading() {
	if (!station)
		return;
	const list = conversations(station.entries(), myself());
	const byId = (id) => list.find((c) => c.root.id === id);
	// the inbox
	const inbox = list.filter((c) => c.inbox);
	const ic = reading.inbox.conversation && byId(reading.inbox.conversation);
	if (ic) {
		$('inbox').replaceChildren(...thread(ic, () => {
			reading.inbox.conversation = null;
			showReading();
		}, 'Inbox'));
	} else {
		reading.inbox.conversation = null;
		$('inbox').replaceChildren(view.el('h2', 'Inbox'),
			inbox.length ? view.el('div.rows', ...inbox.map((c) => conversationRow(c, () => {
				reading.inbox.conversation = c.root.id;
				showReading();
				window.scrollTo(0, 0);
			}))) : view.el('p.dim', 'Nothing for you yet: Topics to your fingerprints, call signs or names, and conversations you are in, land here.'));
	}
	// the boards
	const all = boards(list);
	const board = reading.boards.board && all.find((b) => b.board === reading.boards.board);
	const bc = board && reading.boards.conversation && board.conversations.find((c) => c.root.id === reading.boards.conversation);
	if (bc) {
		$('boards').replaceChildren(...thread(bc, () => {
			reading.boards.conversation = null;
			showReading();
		}, board.board === 'everyone' ? 'Everyone' : board.board === 'elsewhere' ? 'Elsewhere' : 'Board'));
	} else if (board) {
		reading.boards.conversation = null;
		const top = view.el('button.small', '← Boards');
		top.onclick = () => {
			reading.boards.board = null;
			showReading();
		};
		$('boards').replaceChildren(view.el('div.thread-bar', top), view.el('h2', boardName(board)),
			board.conversations.length ? view.el('div.rows', ...board.conversations.map((c) => conversationRow(c, () => {
				reading.boards.conversation = c.root.id;
				showReading();
				window.scrollTo(0, 0);
			}))) : view.el('p.dim', 'No Topics here yet.'));
	} else {
		reading.boards.board = null;
		$('boards').replaceChildren(view.el('h2', 'Boards'), view.el('div.rows', ...all.map((b) => {
			const faces = recentKeys(b.conversations);
			const row = view.el('button.row-card', view.el('span.row-text', view.el('strong', boardName(b)),
				view.el('span.dim', `${b.conversations.length} conversation${b.conversations.length === 1 ? '' : 's'}${b.last ? ` · ${view.when(b.last)}` : ''}`),
				faces.length ? view.el('span.faces', ...faces.map((k) => view.face(k))) : ''));
			row.onclick = () => {
				reading.boards.board = b.board;
				showReading();
				window.scrollTo(0, 0);
			};
			return row;
		})), view.el('p.dim', 'Signed Topics to everyone and to boards (group names). Posts from fingerprints you don\'t trust show without names or pictures; the Log has every frame.'));
	}
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
		showRelay();
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
	setOf: (id) => setOfPost(view.hex(id)),
	resend: (set) => sendAgain(set),
});

await restart();

if (!simd)
	status('this browser lacks WebAssembly SIMD: Rattlechan can\'t run here', 'warn');
else if (!crypto || !hydra)
	status(`${!crypto ? 'CRYPTO' : 'HYDRA'} failed to load: ${!crypto ? 'signatures stay unchecked' : 'fragments stay apart'}`, 'warn');
else if ($('status').textContent === 'starting …')
	status(`${items.length} frames`);

// ------------------------------------------------------------- receiving

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

// The screen stays on as long as the app is open: a phone stops the
// microphone and the audio once its screen goes dark. The browser drops the
// lock when the page is hidden, so it is taken again when it shows, and iOS
// may drop it while the page is shown, when the microphone prompt appears,
// say, so then it is asked for again a second later, at most every ten
// seconds by itself; a tap asks again too, and so do Listen and the end of
// a transmission. The Station tab says how it stands, so a phone that still
// goes dark shows why: kept on, refused with the browser's reason, let go
// of by the system, or not possible in this browser.
const showScreen = (text, ok = false) => {
	$('screen').textContent = text;
	$('screen').className = ok ? 'dim' : 'warn';
};
let waking = false;
let retried = 0;
async function keepAwake() {
	if (!('wakeLock' in navigator)) {
		showScreen("The screen may turn off: this browser can't keep it on.");
		return;
	}
	if (waking || (wakeLock && !wakeLock.released) || document.visibilityState !== 'visible')
		return;
	waking = true;
	try {
		const lock = await navigator.wakeLock.request('screen');
		wakeLock = lock;
		showScreen('The screen stays on while the app is open.', true);
		lock.addEventListener('release', () => {
			if (wakeLock !== lock)
				return;
			wakeLock = null;
			if (document.visibilityState !== 'visible')
				return;
			showScreen('The screen may turn off: the system let go of it. Tap anywhere to keep it on.');
			if (Date.now() - retried >= 10000) {
				retried = Date.now();
				setTimeout(keepAwake, 1000);
			}
		});
	} catch (err) {
		showScreen(`The screen may turn off: refused (${err.name}${err.message ? `: ${err.message}` : ''}). Tap anywhere to try again.`);
	}
	waking = false;
}
document.addEventListener('visibilitychange', keepAwake);
document.addEventListener('pointerdown', keepAwake, true);
keepAwake();

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

// Listen and Stop are two buttons, as on the modem's page, so it is always
// clear what a tap does, also when the audio hangs. Listen always starts
// over with a new microphone and context, also when already listening:
// iOS can leave a receiver that claims to run but hears nothing after the
// app was in the background, and a microphone asked for while the old one
// is still there doesn't work then. Neither button is ever disabled or
// waits on the audio system, and a start that hangs and settles later,
// after another Listen or a Stop, is stopped right away.
let listening = 0;
let heard = 0;
let listeningText = '';
let silentUntil = 0;

function startListening() {
	stopListening();
	const attempt = listening;
	$('receiver').textContent = 'Starting …';
	status('starting the microphone');
	listen({
		deviceId: $('input').value || recall('input') || null,
		onEnded: () => {
			if (attempt !== listening)
				return;
			stopListening();
			$('receiver').textContent = 'The microphone ended (the app was in the background?). Tap Listen to start again.';
			$('receiver').classList.add('warn');
			status('not listening', 'warn');
		},
		onReport: (r) => {
			if (attempt !== listening)
				return;
			heard = Date.now();
			// the meter keeps showing the input, but the station
			// doesn't decode itself; nothing to draw while it can't be
			// seen, on another tab or with the app in the background
			if (!$('station').hidden && !document.hidden)
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
	}).then((r) => {
		if (attempt !== listening) {
			r.stop();
			return;
		}
		receiver = r;
		heard = Date.now();
		// the microphone prompt may have let go of the screen
		keepAwake();
		listeningText = `Listening at ${r.rate} Hz${r.label ? ` on ${r.label}` : ''}.`;
		$('receiver').textContent = listeningText;
		status('listening');
		fillInputs(r.deviceId);
	}, (err) => {
		if (attempt !== listening)
			return;
		$('receiver').textContent = `Can't listen: ${err.message}`;
		$('receiver').classList.add('warn');
		status('not listening', 'warn');
	});
}

// cuts off a transmission too, as on the modem's page: it may play through
// the receiver's context, and a new microphone stalls any running context
function stopListening() {
	listening += 1;
	sending?.stop();
	quiet();
	const r = receiver;
	receiver = null;
	r?.stop();
	silentUntil = 0;
	level(0);
	$('receiver').textContent = 'Not listening.';
	$('receiver').classList.remove('warn');
	status('not listening');
}

$('listen').onclick = startListening;
$('stop-listening').onclick = stopListening;

// iOS can leave the microphone silent after the app was in the background,
// without any event: the worker reports at least every fifth of a second,
// so a second without a report means no samples arrive. The warning
// latches for two seconds instead of blinking.
setInterval(() => {
	if (!receiver)
		return;
	const now = Date.now();
	if (now - heard > 1000) {
		silentUntil = now + 2000;
		level(0);
		const h = receiver.health();
		$('receiver').textContent = `No audio from the microphone (audio ${h.context}, microphone ${h.track}${h.muted ? ', muted' : ''}). Tap Listen to start over.`;
		$('receiver').classList.add('warn');
		status('no audio', 'warn');
	} else if (silentUntil && now >= silentUntil) {
		silentUntil = 0;
		$('receiver').textContent = listeningText;
		$('receiver').classList.remove('warn');
		status('listening');
	}
}, 500);

$('input').onchange = () => {
	remember('input', $('input').value);
	if (receiver)
		startListening();
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
		$('log').scrollIntoView();
	} catch (err) {
		$('receiver').textContent = `Can't decode ${file.name}: ${err.message}`;
	}
};

// ------------------------------------------------------------- storage

async function refreshStorage() {
	// a tap on Station while the store still opens
	if (!store)
		return;
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
		await showRelay();
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
		await showRelay();
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
		const ctx = audioOut();
		revokeNow.disabled = true;
		const say = (t) => {
			revokeStatus.textContent = t;
		};
		try {
			const d = { payload: fromHex(k.revocations[reason.value]), o: await own(), raw: true };
			if (await transmit(ctx, d, 'longer', say, revokeStop))
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
	// its avatar, sent now and then from here: a still picture cropped
	// (cropAvatar), an animation only as it is
	const avatarInfo = view.el('p.dim');
	const file = view.el('input');
	file.type = 'file';
	file.accept = 'image/png,image/jpeg,image/gif,image/webp';
	file.hidden = true;
	file.onchange = async () => {
		const f = file.files[0];
		file.value = '';
		if (!f)
			return;
		try {
			let bytes = trimmed(new Uint8Array(await f.arrayBuffer()));
			const pic = pictureInfo(bytes);
			if (!pic)
				throw new RangeError('not a PNG, JPEG, GIF or WebP picture');
			if (pic.animated && avatarProblem(bytes))
				throw new RangeError(`an animation goes only as it is, and stations ignore this one: ${avatarProblem(bytes)}`);
			if (!pic.animated)
				bytes = await cropAvatar(bytes, pic);
			if (!bytes)
				return;
			await keys.update(k.key, { avatar: bytes });
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
		const ctx = audioOut();
		sendAvatar.disabled = true;
		const say = (t) => {
			avatarInfo.textContent = t;
		};
		try {
			await transmit(ctx, await avatarDraft(k), 'fragments', say, avatarStop, stepBox.checked ? { next: sendAvatar, finish: avatarFinish } : null);
		} catch (err) {
			say(`Can't send: ${err.message}`);
		}
		sendAvatar.disabled = false;
	};
	if (k.avatar && !sendAvatar.hidden)
		avatarDraft(k).then(async (d) => {
			const p = plan(await encoderFor(48000), d, 'fragments', true);
			const pic = pictureInfo(k.avatar);
			avatarInfo.textContent = `${pic.width}x${pic.height} ${FORMATS[pic.type]}${pic.animated ? ' animation' : ''} of ${view.bytes(k.avatar.length)}, on the air as ${p.count === 1 ? 'one frame' : `${p.count} fragments, any ${p.K} of them enough`}, ${p.airtime.toFixed(1)} s. Stations that trust this key show it beside its posts.`;
		}).catch((err) => {
			avatarInfo.textContent = err.message;
		});
	else if (!k.avatar)
		avatarInfo.textContent = 'No avatar: stations show the identicon. Choose any picture or photo and the part of it to use. A PNG, JPEG, GIF or WebP picture or animation of 16K to 256K pixels (128x128 to 512x512), at most 2:1 either way, in at most 8 KiB goes as it is.';
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

// ------------------------------------------------------ kept revocations

// the kept revocations, the next to go out first, and the switch
async function showRelay() {
	if (!station)
		return;
	const list = await station.relayable();
	$('relay-list').replaceChildren(...list.map((r) => {
		const info = keyInfo(r.key);
		const name = info.name && (typeof info.name === 'string' ? info.name : decodeText(info.name));
		const who = [info.callSign, name].filter(Boolean).join(' ') || `fingerprint ${r.key.slice(0, 8)}`;
		return view.el('div.relay-item', view.identicon(fromHex(r.key), 24),
			view.el('span', view.el('strong', who), ' ', view.el(r.reason === 'compromised' ? 'span.bad' : 'span.warn', r.reason),
				view.el('span.dim', ` since ${view.when(r.arrival)}, ${r.sent ? `last sent ${view.when(r.sent)}` : 'not sent yet'}`)));
	}));
	if (!list.length)
		$('relay-list').replaceChildren(view.el('p.dim', 'None kept yet.'));
	$('relay-send').disabled = !list.length;
	$('relay-fill').checked = await station.relayFill();
}

$('relay-fill').onchange = () => station.setRelayFill($('relay-fill').checked);

// every kept revocation at once: as many per frame as fit, frames chained
$('relay-send').onclick = async () => {
	const ctx = audioOut();
	$('relay-send').disabled = true;
	const say = (t) => {
		$('relay-status').textContent = t;
	};
	try {
		const list = await station.relayable();
		const o = await own();
		if (!ctx)
			throw new Error('already sending');
		const E = await encoderFor(ctx.sampleRate);
		const p = pack(E, list.map((r) => r.bytes), o);
		await transmit(ctx, { frames: p.frames, o }, 'longer', say, $('relay-stop'));
	} catch (err) {
		say(`Can't send: ${err.message}`);
	}
	showRelay();
};

// an Avatar post of an own key, signed, with its From-Call and From-Name
async function avatarDraft(k) {
	const payload = composeAvatar({ avatar: k.avatar, callSign: k.callSign, name: k.name, sign: await keys.signer(k.key) });
	return { payload, o: await own() };
}

// the key list in Station and the choice in Compose
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
	showOutbox();
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

// the AudioContext for a transmission, first thing in a click handler (see
// wake()); null while one goes out, whose audio stays untouched
function audioOut() {
	return sending ? null : wake(receiver?.context);
}

function setKind(k) {
	kind = k;
	for (const b of document.querySelectorAll('.segmented [role=radio]'))
		b.setAttribute('aria-checked', b.dataset.kind === k);
	$('signing').hidden = k === 'hex';
	$('collect-button').hidden = k === 'hex';
	$('photo-field').hidden = k === 'hex';
	$('subject-field').hidden = k !== 'topic';
	$('to-field').hidden = k !== 'topic';
	$('text-field').hidden = k === 'hex';
	$('files-field').hidden = k === 'hex';
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

// A signature's place without signing, for estimates: the same size
const unsigned = (...records) => signedRecord(new Uint8Array(32), new Uint8Array(64), ...records);

// the post as it stands, signed, or { why }; with dry, only as large as
// signed, for estimates
async function draft(dry = false) {
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
	const text = $('text').value.trim() ? $('text').value : '';
	if (!text && !attachments.length)
		return { why: 'Write something or attach a file.' };
	const bytesAttached = attachments.reduce((n, a) => n + a.bytes.length, 0);
	if (attachments.length > FILES_MAX || bytesAttached > FILES_MAX_BYTES)
		return { why: `At most ${FILES_MAX} files and ${view.bytes(FILES_MAX_BYTES)} in all per post.` };
	if (kind === 'topic' && !$('subject').value.trim())
		return { why: 'A topic needs a subject.' };
	if (kind === 'reply' && !replyTo)
		return { why: 'Pick a post to reply to.' };
	const where = kind === 'topic' ? address() : { to: null };
	if (where.why)
		return { why: where.why };
	const parts = attachments.map((a) => attachment(a.bytes, { type: a.type, name: a.name }));
	const post = { kind, subject: kind === 'topic' ? $('subject').value.trim() : '', text, parent: kind === 'reply' ? replyTo : null, to: where.to, timestamp: Math.floor(Date.now() / 1000), parts };
	const payload = compose({
		...post,
		// the key's call sign and name only when asked for: they cost bytes,
		// and stations remember them from earlier posts
		callSign: withCall ? k.callSign : null, name: withName ? k.name : null,
		sign: dry ? unsigned : await keys.signer(k.key),
		avatar: withAvatar ? k.avatar : null,
	});
	return { payload, o, post, key: k.key };
}

// what the post would take on the air, updated while typing
let estimating = 0;
async function estimate() {
	if (stepping)
		return;
	// a second after the last change, so typing never waits for it
	const mine = ++estimating;
	await new Promise((r) => setTimeout(r, 1000));
	if (mine !== estimating)
		return;
	let d;
	try {
		d = await draft(true);
	} catch (err) {
		d = { why: err.message };
	}
	$('send-button').disabled = !d.payload || !!sending;
	$('collect-button').disabled = !d.payload || !!d.raw || stepping;
	$('hex-preview').replaceChildren();
	if (!d.payload) {
		// nothing to send, so no choice of how
		$('send-choice').hidden = true;
		$('send-info').textContent = d.why;
		return;
	}
	// the modes are the same at both rates, so the estimate uses 48000
	const E = await encoderFor(48000);
	const anon = anonymous(d);
	const describe = (p) => describeMode(E, p);
	if (d.raw) {
		// what stations would make of it, sent all the same
		const a = station.analyze(d.payload);
		$('hex-preview').replaceChildren(a.error ? view.el('div.bad', `malformed: ${a.error}; stations drop it`) : a.nodes.length ? view.nodes(a.nodes) : view.el('div.dim', 'empty frame'));
		$('send-choice').hidden = true;
		try {
			const p = plan(E, d, 'longer', true);
			$('send-info').textContent = `${view.bytes(d.payload.length)} in one frame of ${p.airtime.toFixed(1)} s, ${describe(p)}.${anon}`;
		} catch (err) {
			$('send-info').textContent = err.message;
			$('send-button').disabled = true;
		}
		return;
	}
	showPlan(E, d, SEND_UI);
}

const anonymous = (d) => d.o.callSign ? '' : ' Sent as ANONYMOUS.';
const describeMode = (E, p) => {
	const info = E.modeInfo(p.modes[0]);
	return `${info.modulation} ${info.codeRate}, decodes from ${needs(p.modes[0])} dB`;
};

// where a draft's plan shows: the size and airtime, the choice of how
// when it doesn't fit one frame (its radios by name, their labels and one
// at a time) and the button that sends it
const SEND_UI = { info: 'send-info', choice: 'send-choice', how: 'how', fragments: 'choice-fragments', longer: 'choice-longer', one: 'one-at-a-time', button: 'send-button' };
const OUTBOX_UI = { info: 'outbox-info', choice: 'outbox-choice', how: 'outbox-how', fragments: 'outbox-fragments', longer: 'outbox-longer', one: 'outbox-one-at-a-time', button: 'outbox-send' };

// how a draft would go on the air, in one frame, as Fragments or in one
// longer frame, shown in ui
function showPlan(E, d, ui) {
	const anon = anonymous(d);
	const describe = (p) => describeMode(E, p);
	const fits = pick(E, d.payload.length, d.o) !== null;
	$(ui.choice).hidden = fits;
	$(ui.button).disabled = !!sending;
	if (fits) {
		const p = plan(E, d, 'fragments', true);
		$(ui.info).textContent = `${view.bytes(d.payload.length)} in one frame of ${p.airtime.toFixed(1)} s, ${describe(p)}.${anon}`;
		return;
	}
	$(ui.info).textContent = `${view.bytes(d.payload.length)}.${anon}`;
	const choice = (how, span, label) => {
		const radio = document.querySelector(`input[name=${ui.how}][value=${how}]`);
		try {
			const p = plan(E, d, how, true);
			radio.disabled = false;
			$(span).textContent = label(p);
		} catch (err) {
			radio.disabled = true;
			$(span).textContent = err.message;
		}
	};
	choice('fragments', ui.fragments, (p) => `${p.count} fragments of ${E.modeInfo(p.modes[0]).seconds.toFixed(1)} s, any ${p.K} of them enough, ${p.airtime.toFixed(1)} s in all, ${describe(p)}`);
	choice('longer', ui.longer, (p) => `one frame of ${p.airtime.toFixed(1)} s, ${describe(p)}`);
	const radios = [...document.querySelectorAll(`input[name=${ui.how}]`)];
	if (radios.find((r) => r.checked)?.disabled)
		radios.find((r) => !r.disabled)?.click();
	// one at a time is a way of sending fragments
	$(ui.one).closest('label').hidden = radios.find((r) => r.checked)?.value !== 'fragments';
	$(ui.button).disabled = !!sending || radios.every((r) => r.disabled);
}

// How a draft goes on the air, at the settings or, with how = 'longer', in
// one frame as long as it needs. Returns what split() gives (with dry,
// what sizes() gives), with the number of frames, the seconds and SNR
// used, the modes and the airtime.
function plan(E, d, how, dry = false) {
	const { snr, redundancy } = d.o;
	let seconds = d.o.seconds;
	if (how === 'longer' && pick(E, d.payload.length, { seconds, snr }) === null) {
		seconds = secondsFor(E, d.payload.length, snr);
		if (seconds === null)
			throw new RangeError(`too long for one frame at ${snr} dB`);
	}
	// an estimate only sizes the frames: encoding a large payload takes
	// seconds
	const s = dry ? sizes(d.payload.length, { encoder: E, hydra, seconds, snr, redundancy }) : split(d.payload, { encoder: E, hydra, seconds, snr, redundancy });
	const lengths = s.lengths ?? s.frames.map((f) => f.length);
	const modeOf = new Map();
	for (const n of lengths)
		if (!modeOf.has(n))
			modeOf.set(n, pick(E, n, { seconds, snr }));
	return { ...s, count: lengths.length, seconds, snr, modes: lengths.map((n) => modeOf.get(n)), airtime: airtime(E, lengths, { seconds, snr, lead: leadSymbols() }) };
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

// Files attached to the post: PNG, JPEG, GIF and WebP files go as Pictures,
// Codec2 (.c2) and Ogg Opus files as Audio, both as they are, anything else
// as a MIME escape with its type and a file name the operator can change or
// clear
let attachments = [];

function describeFile(a) {
	const size = view.bytes(a.bytes.length);
	const pic = pictureInfo(a.bytes);
	if (pic)
		return `${FORMATS[pic.type]} picture${pic.animated ? ', animated' : ''}, ${pic.width}x${pic.height}, ${size}${huge(pic) ? ', so large that stations warn before drawing it' : ''}`;
	const sound = audioInfo(a.bytes);
	if (sound)
		return sound.format === 'codec2' ? `Codec2 ${sound.name} voice, ${size}` : `Opus audio${sound.channels === 2 ? ', stereo' : ''}, ${size}`;
	return `${a.type || 'a file of unknown type'}, ${size}`;
}

// A still picture made smaller to save airtime: width and height halved
// until it has at most a budget of pixels, as in Assempix, then a WebP or
// JPEG (madeType) of quality 0.7, a white background replacing
// transparency. Halving keeps it sharp. Drawing it anew leaves the
// camera's metadata (and any GPS position in it) behind.
const BUDGETS = [14, 15, 16, 17, 18, 19, 20].map((b) => 1 << b);
// what a larger still picture is shrunk to when attached
const BUDGET_DEFAULT = 1 << 18;
const pixelCount = (n) => n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}M` : `${Math.round(n / 1024)}K`;

// width and height halved until they fit the budget
function halved(width, height, budget) {
	while (width * height > budget) {
		width = Math.floor(width / 2);
		height = Math.floor(height / 2);
	}
	return [Math.max(1, width), Math.max(1, height)];
}

const canvasOf = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

// the part of img from x, y of w by h, halved until it fits the budget,
// then drawn on a white canvas of side x side, or width by height of the
// halved part (as halved() tells)
function halving(img, x, y, w, h, budget, side = null) {
	let src = img;
	while (w * h > budget) {
		const half = canvasOf(Math.max(1, Math.floor(w / 2)), Math.max(1, Math.floor(h / 2)));
		half.getContext('2d').drawImage(src, x, y, w, h, 0, 0, half.width, half.height);
		[src, x, y, w, h] = [half, 0, 0, half.width, half.height];
	}
	const out = canvasOf(side ?? w, side ?? h);
	const ctx = out.getContext('2d');
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, out.width, out.height);
	ctx.drawImage(src, x, y, w, h, 0, 0, out.width, out.height);
	return out;
}

const blobOf = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// What pictures are made as: WebP where the browser encodes it, about a
// third smaller than JPEG at the same quality, JPEG elsewhere (Safari).
// A canvas that can't encode a type gives a PNG instead. Every browser
// that runs Rattlechan decodes WebP.
let madeAs = null;
const madeType = async () => madeAs ??= (await blobOf(canvasOf(1, 1), 'image/webp', 0.7))?.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
const encodedOf = async (canvas, quality) => new Uint8Array(await (await blobOf(canvas, await madeType(), quality)).arrayBuffer());

async function shrink(bytes, type, budget) {
	const img = await createImageBitmap(new Blob([bytes], { type }));
	const out = halving(img, 0, 0, img.width, img.height, budget);
	img.close();
	return encodedOf(out, 0.7);
}

// the part of img from x, y of w by h drawn at ow by oh on white, halved
// on the way down while that stays at least as large, for a smooth result
function drawnAt(img, x, y, w, h, ow, oh) {
	let src = img;
	while (Math.floor(w / 2) >= ow && Math.floor(h / 2) >= oh) {
		const half = canvasOf(Math.floor(w / 2), Math.floor(h / 2));
		half.getContext('2d').drawImage(src, x, y, w, h, 0, 0, half.width, half.height);
		[src, x, y, w, h] = [half, 0, 0, half.width, half.height];
	}
	const out = canvasOf(ow, oh);
	const ctx = out.getContext('2d');
	ctx.imageSmoothingQuality = 'high';
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, ow, oh);
	ctx.drawImage(src, x, y, w, h, 0, 0, ow, oh);
	return out;
}

// The sizes an avatar of a w by h part of a picture is tried at: halved
// until it has at most 256K pixels, then halved again while it keeps at
// least 16K; a part of fewer than 16K pixels is drawn larger, up to them
// (SPEC.md, Avatar)
function avatarSizes(w, h) {
	while (w * h > AVATAR_MAX_PIXELS) {
		w = Math.floor(w / 2);
		h = Math.floor(h / 2);
	}
	if (w * h < AVATAR_MIN_PIXELS) {
		const k = Math.sqrt(AVATAR_MIN_PIXELS / (w * h));
		w = Math.ceil(w * k);
		h = Math.ceil(h * k);
	}
	const sizes = [[w, h]];
	while (Math.floor(w / 2) * Math.floor(h / 2) >= AVATAR_MIN_PIXELS)
		sizes.push([w = Math.floor(w / 2), h = Math.floor(h / 2)]);
	return sizes;
}

// An avatar from the w by h part at x, y of a decoded picture, at the
// sizes avatarSizes() gives, as a WebP or JPEG (madeType) of falling
// quality until it fits 8 KiB
async function avatarOf(img, x, y, w, h) {
	const sizes = avatarSizes(w, h);
	for (const [i, [ow, oh]] of sizes.entries()) {
		const out = drawnAt(img, x, y, w, h, ow, oh);
		const last = i === sizes.length - 1;
		for (const quality of last ? [0.8, 0.7, 0.6, 0.5, 0.4, 0.3] : [0.8, 0.7, 0.6, 0.5]) {
			const made = await encodedOf(out, quality);
			if (made.length <= AVATAR_MAX_BYTES && !avatarProblem(made))
				return made;
		}
	}
	const [ow, oh] = sizes.at(-1);
	throw new RangeError(`it doesn't fit in 8 KiB even at ${ow}x${oh}`);
}

// the fewest pixels of the picture the cropper's frame keeps on a side
const CROP_MIN_SIDE = 32;
// how close to an edge of the frame, in screen pixels, a drag resizes it
const CROP_GRIP = 24;

// Cropping a still picture for an avatar: the picture drawn to fit the
// screen with a frame over it, the largest centred square first, the rest
// dimmed. Dragging inside the frame (or beside it) moves it, dragging an
// edge or a corner resizes it, its shape held between 2:1 and 1:2; the
// arrow keys move it, with Shift they resize it. The whole of a picture
// already within the limits goes as it is. Resolves to the avatar's
// bytes, or null if cancelled.
async function cropAvatar(bytes, pic) {
	const img = await createImageBitmap(new Blob([bytes], { type: pic.type }));
	const W = img.width, H = img.height, S = Math.min(W, H);
	const k = Math.min(1, (Math.min(window.innerWidth, 560) - 50) / W, window.innerHeight * 0.6 / H);
	const preview = canvasOf(Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k)));
	const ctx = preview.getContext('2d');
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(halving(img, 0, 0, W, H, preview.width * preview.height * 4), 0, 0, preview.width, preview.height);
	const least = Math.min(CROP_MIN_SIDE, S);
	// the frame, in pixels of the picture
	let x = (W - S) / 2, y = (H - S) / 2, w = S, h = S;
	const frame = view.el('div.crop-square', ...['nw', 'ne', 'sw', 'se'].map((c) => view.el(`span.crop-handle.${c}`)));
	frame.tabIndex = 0;
	frame.setAttribute('aria-label', 'the part to use: the arrow keys move it, with Shift they resize it');
	const area = view.el('div.crop-area', preview, frame);
	area.style.width = `${preview.width}px`;
	const info = view.el('p.dim.crop-info', ' ');
	const cancel = view.el('button', 'Cancel');
	const use = view.el('button.primary', 'Use');
	const dialog = view.el('dialog.picture-dialog.crop-dialog', area,
		view.el('p.dim.crop-hint', 'Drag inside to move, drag an edge or a corner to change the size and shape, from 2:1 to 1:2.'),
		info, view.el('div.row', cancel, use));
	const place = () => {
		Object.assign(frame.style, { left: `${x * k}px`, top: `${y * k}px`, width: `${w * k}px`, height: `${h * k}px` });
	};
	// The frame from edges L, T, R, B, the ones being dragged in drag
	// (l, t, r, b): within the picture, at least least a side, and its
	// shape within 2:1 and 1:2. A shape too long is put right by the
	// dragged edges: shortening the long side when it is the one dragged,
	// otherwise giving the short side back what the drag took (within
	// the picture), and shortening the long side if that isn't enough.
	const settle = (L, T, R, B, drag) => {
		const horizontal = drag.l || drag.r, vertical = drag.t || drag.b;
		L = Math.max(0, L);
		T = Math.max(0, T);
		R = Math.min(W, R);
		B = Math.min(H, B);
		if (R - L < least)
			drag.l ? L = R - least : R = L + least;
		if (B - T < least)
			drag.t ? T = B - least : B = T + least;
		const fix = (long, short, setLong, setShort, longDragged) => {
			if (long() <= AVATAR_MAX_RATIO * short())
				return;
			if (!longDragged)
				setShort(long() / AVATAR_MAX_RATIO);
			if (long() > AVATAR_MAX_RATIO * short())
				setLong(AVATAR_MAX_RATIO * short());
		};
		// the right or left edge, or the bottom or top one, as dragged
		const width = (n) => drag.l ? L = Math.max(0, R - n) : R = Math.min(W, L + n);
		const height = (n) => drag.t ? T = Math.max(0, B - n) : B = Math.min(H, T + n);
		fix(() => R - L, () => B - T, width, height, horizontal);
		fix(() => B - T, () => R - L, height, width, vertical);
		[x, y, w, h] = [L, T, R - L, B - T];
	};
	// moved by dx, dy, kept within the picture
	const moveBy = (dx, dy) => {
		x = Math.min(Math.max(0, x + dx), W - w);
		y = Math.min(Math.max(0, y + dy), H - h);
	};
	// the avatar the frame makes now
	const whole = () => Math.round(x) === 0 && Math.round(y) === 0 && Math.round(w) === W && Math.round(h) === H;
	const make = () => whole() && !avatarProblem(bytes) ? Promise.resolve(bytes) : avatarOf(img, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
	let shown = 0, timer = 0;
	const estimate = () => {
		clearTimeout(timer);
		timer = setTimeout(async () => {
			const at = ++shown;
			try {
				const b = await make();
				const p = pictureInfo(b);
				if (at === shown)
					info.textContent = `${Math.round(w)}x${Math.round(h)} of the picture, sent as ${b === bytes ? 'it is, ' : ''}${p.width}x${p.height} ${FORMATS[p.type]} of ${view.bytes(b.length)}`;
			} catch (err) {
				if (at === shown)
					info.textContent = err.message;
			}
		}, 300);
	};
	// a drag: where it started, the frame then, and which edges it holds
	let drag = null;
	area.onpointerdown = (e) => {
		area.setPointerCapture(e.pointerId);
		const r = frame.getBoundingClientRect();
		const near = (a, b) => Math.abs(a - b) <= CROP_GRIP;
		const inside = e.clientX > r.left - CROP_GRIP && e.clientX < r.right + CROP_GRIP && e.clientY > r.top - CROP_GRIP && e.clientY < r.bottom + CROP_GRIP;
		const edges = inside ? { l: near(e.clientX, r.left), r: near(e.clientX, r.right), t: near(e.clientY, r.top), b: near(e.clientY, r.bottom) } : {};
		// a small frame: the edge nearer the pointer
		if (edges.l && edges.r)
			edges[Math.abs(e.clientX - r.left) < Math.abs(e.clientX - r.right) ? 'r' : 'l'] = false;
		if (edges.t && edges.b)
			edges[Math.abs(e.clientY - r.top) < Math.abs(e.clientY - r.bottom) ? 'b' : 't'] = false;
		drag = { at: [e.clientX, e.clientY], was: [x, y, w, h], edges, resize: Object.values(edges).some(Boolean) };
		e.preventDefault();
	};
	area.onpointermove = (e) => {
		if (!drag)
			return;
		const dx = (e.clientX - drag.at[0]) / k, dy = (e.clientY - drag.at[1]) / k;
		const [x0, y0, w0, h0] = drag.was;
		if (drag.resize) {
			const d = drag.edges;
			settle(x0 + (d.l ? dx : 0), y0 + (d.t ? dy : 0), x0 + w0 + (d.r ? dx : 0), y0 + h0 + (d.b ? dy : 0), d);
		} else {
			[x, y] = [x0, y0];
			moveBy(dx, dy);
		}
		place();
	};
	area.onpointerup = area.onpointercancel = () => {
		if (drag)
			estimate();
		drag = null;
	};
	frame.onkeydown = (e) => {
		const step = Math.max(1, Math.round(Math.min(w, h) / 20));
		const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
		if (!moves[e.key])
			return;
		e.preventDefault();
		const [dx, dy] = moves[e.key];
		if (e.shiftKey)
			settle(x, y, x + w + dx, y + h + dy, { r: true, b: true });
		else
			moveBy(dx, dy);
		place();
		estimate();
	};
	document.body.append(dialog);
	dialog.showModal();
	place();
	estimate();
	frame.focus();
	try {
		return await new Promise((resolve) => {
			cancel.onclick = () => resolve(null);
			dialog.oncancel = (e) => {
				e.preventDefault();
				resolve(null);
			};
			use.onclick = async () => {
				use.disabled = true;
				try {
					resolve(await make());
				} catch (err) {
					info.textContent = err.message;
					use.disabled = false;
				}
			};
		});
	} finally {
		clearTimeout(timer);
		dialog.close();
		dialog.remove();
		img.close();
	}
}

// the size picker of a still picture with more pixels than the smallest
// budget: each size it can be halved to once, with its number of pixels,
// then the original
function shrinkPicker(a) {
	const pic = pictureInfo(a.original.bytes);
	if (!pic || pic.animated)
		return null;
	const sizes = new Map();
	for (const b of BUDGETS.filter((b) => b < pic.width * pic.height))
		sizes.set(halved(pic.width, pic.height, b).join('x'), b);
	if (!sizes.size)
		return null;
	const select = view.el('select', ...[...sizes].map(([size, b]) => {
		const [w, h] = size.split('x');
		const o = view.el('option', `${size}, ${pixelCount(w * h)} pixels`);
		o.value = b;
		return o;
	}), view.el('option', `original, ${pic.width}x${pic.height}, ${pixelCount(pic.width * pic.height)} pixels`));
	select.options[select.options.length - 1].value = '';
	select.value = a.budget ? sizes.get(halved(pic.width, pic.height, a.budget).join('x')) : '';
	select.onchange = async () => {
		select.disabled = true;
		try {
			await resize(a, Number(select.value) || null);
		} catch (err) {
			$('attach-info').textContent = `Can't shrink it: ${err.message}`;
		}
		showAttachments();
	};
	return view.el('label.field', 'Size ', select);
}

// an attachment halved to a budget of pixels, or the original with null
async function resize(a, budget) {
	if (!budget) {
		Object.assign(a, a.original, { budget });
		return;
	}
	const bytes = await shrink(a.original.bytes, a.original.type, budget);
	const type = pictureInfo(bytes).type;
	Object.assign(a, { bytes, type, name: a.original.name && fileName(a.original.name.replace(/\.[a-z0-9]+$/, '') + (type === 'image/webp' ? '.webp' : '.jpg')), budget });
}

function showAttachments() {
	const total = attachments.reduce((n, a) => n + a.bytes.length, 0);
	$('attachments').replaceChildren(...attachments.map((a) => {
		const remove = view.el('button.small', 'Remove');
		remove.onclick = () => {
			attachments = attachments.filter((x) => x !== a);
			showAttachments();
		};
		const box = view.el('div.attachment', view.el('span.what', describeFile(a)), shrinkPicker(a) ?? '');
		// only a MIME escape carries a name, which costs its bytes
		if (!pictureInfo(a.bytes) && !audioInfo(a.bytes)) {
			const input = view.el('input');
			input.value = a.name;
			input.placeholder = 'none: named by its hash';
			input.autocomplete = 'off';
			input.spellcheck = false;
			input.onchange = () => {
				a.name = fileName(input.value);
				input.value = a.name;
				estimate();
			};
			box.append(view.el('label.field', 'File name ', input));
		}
		box.append(view.el('div.row', remove));
		return box;
	}));
	$('attach-info').textContent = attachments.length ? `${attachments.length} of at most ${FILES_MAX} files, ${view.bytes(total)} of ${view.bytes(FILES_MAX_BYTES)}.` : '';
	$('attach').closest('label').hidden = attachments.length >= FILES_MAX;
	estimate();
}

// A file as an attachment. A still picture of more than BUDGET_DEFAULT
// pixels is halved to fit it right away; the Size picker brings the
// original back.
async function attachFile(f) {
	const file = { bytes: trimmed(new Uint8Array(await f.arrayBuffer())), type: f.type, name: fileName(f.name) };
	const a = { ...file, original: file, budget: null };
	const pic = pictureInfo(file.bytes);
	if (pic && !pic.animated && pic.width * pic.height > BUDGET_DEFAULT)
		await resize(a, BUDGET_DEFAULT).catch(() => {});
	return a;
}

$('attach').onchange = async () => {
	const files = [...$('attach').files];
	for (const f of files) {
		if (attachments.length >= FILES_MAX)
			break;
		try {
			attachments.push(await attachFile(f));
		} catch (err) {
			console.log('attach', f.name, err.message);
		}
	}
	// the same files can be chosen again
	$('attach').value = '';
	showAttachments();
	if (files.length > FILES_MAX)
		$('attach-info').textContent += ` Only the first ${FILES_MAX} were taken.`;
};
$('text').oninput = typed;
$('hex').oninput = typed;

// Puts a draft on the air: in one frame if it fits the settings, otherwise
// as Fragments or, with how = 'longer', in one longer frame. Logs the
// station's own frames as they went out, tells say() how it goes and shows
// stop while sending. Fragments go out all at once, chained, or with step
// = { next, finish } (two buttons) one at a time, each its own
// transmission with its leading noise, next sending the next and finish
// ending early. Resolves to true once it went out or was finished with
// enough fragments to decode, 'short' if finished with fewer, false if
// stopped. ctx is the AudioContext from audioOut(), taken first thing in
// the click handler; each next of step takes a new one.
async function transmit(ctx, d, how, say, stop, step = null) {
	if (!ctx || sending || stepping)
		throw new Error('already sending');
	const E = await encoderFor(ctx.sampleRate);
	const callSign = d.o.callSign || 'ANONYMOUS';
	// splitting a large post takes seconds: say so before it starts
	say('Preparing …');
	await new Promise((r) => setTimeout(r, 50));
	// frames packed by the caller, or the draft's own
	// K null: new blocks of a set sent before, whose receivers need any
	// number of them
	const s = d.frames ? { frames: d.frames, K: d.K === undefined ? d.frames.length : d.K, seconds: d.o.seconds, snr: d.o.snr } : plan(E, d, how);
	const opts = { seconds: s.seconds, snr: s.snr, callSign, lead: leadSymbols() };
	const n = s.frames.length;
	// kept revocations in the room the frames leave anyway, the one sent
	// longest ago first; a raw payload goes as it is
	if (!d.raw && !d.frames && await station.relayFill())
		s.frames = fill(E, s.frames, (await station.relayable()).map((r) => r.bytes), opts).frames;
	// one transmission: frames chained back to back, each made as it is
	// played, kept once all went out
	const air = async (frames, what) => {
		// the context of a later fragment may run at another rate
		const E = await encoderFor(ctx.sampleRate);
		const c = { modes: chainModes(E, frames, opts), seconds: airtime(E, frames.map((f) => f.length), opts) };
		const arrival = Date.now();
		deafUntil = Infinity;
		sending = playParts(ctx, chainParts(E, frames, opts), outputLevel());
		$('send-button').disabled = true;
		$('outbox-send').disabled = true;
		stop.onclick = () => sending?.stop();
		stop.hidden = false;
		say(`Sending ${what}, ${c.seconds.toFixed(1)} s …`);
		status('sending', 'ok');
		try {
			const complete = await sending.done;
			if (!complete)
				return false;
			// a revocation among them counts from then on, and is
			// remembered as sent, however it went out
			let revoking = false;
			const repeated = [];
			for (const [i, f] of frames.entries()) {
				const e = await station.sent(f, { arrival, callSign: d.o.callSign || null, mode: c.modes[i] });
				add(() => view.entry(e));
				revoking ||= revokes(e);
				for (const facts of [e.facts, ...(e.fragments ?? []).map((x) => x.facts)])
					repeated.push(...(facts?.revocations ?? []));
			}
			if (revoking)
				await revoked();
			if (repeated.length) {
				await station.relayed(repeated);
				showRelay();
			}
			return true;
		} finally {
			sending = null;
			deafUntil = Date.now() + 1500;
			keepAwake();
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
			showOutbox();
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
				say(`Fragment ${i} of ${n} sent${s.K === null ? '' : `, ${i >= s.K ? 'enough to decode' : `any ${s.K} needed`}`}. Ready for the next? Press Send.`);
				const go = await new Promise((resolve) => {
					step.next.textContent = `Send fragment ${i + 1} of ${n}`;
					step.next.disabled = false;
					// each fragment its own context, from its own tap
					step.next.onclick = () => resolve(audioOut());
					step.finish.onclick = () => resolve(null);
					step.finish.hidden = false;
				});
				step.finish.hidden = true;
				if (go)
					ctx = go;
				if (!go) {
					say(`Finished after ${i} of ${n} fragments${s.K !== null && i < s.K ? `, fewer than the ${s.K} needed` : ''}.`);
					return s.K === null || i >= s.K ? true : 'short';
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
		showOutbox();
	}
}

// ----------------------------------------------------------- sending again

// the decoded fragment set each post arrived in, by post ID (hex), worked
// out again when the station's entries change
let setsOf = { all: null, n: -1, map: new Map() };
function setOfPost(id) {
	const all = station.entries();
	if (setsOf.all !== all || setsOf.n !== all.length) {
		const map = new Map();
		for (const e of all)
			for (const f of e.fragments)
				if (f.nodes)
					for (const [n] of walk(f.nodes))
						if ((n.type === T.TOPIC || n.type === T.REPLY) && n.id && !map.has(view.hex(n.id)))
							map.set(view.hex(n.id), f.key);
		setsOf = { all, n: all.length, map };
	}
	return setsOf.map.get(id) ?? null;
}

// New blocks of a decoded set, anyone's, as a relay sends them (SPEC.md,
// Fragments): at indices this station holds none of, so a station still
// short of blocks completes the post with any of them, and the same post
// ID and root, so they join sets waiting for them. How many, by default as
// many as the extra blocks setting adds, all at once or one at a time,
// each in a frame of its own, made longer when the station's seconds per
// frame don't hold a block.
async function sendAgain(set) {
	const [p, blen] = set.split(':');
	const params = parseInt(p, 16);
	const K = (params & 1023) + 1, N = 2 ** ((params >> 10 & 15) + 1);
	const frameLength = 1 + encodeLength(Number(blen)).length + Number(blen);
	const o = await own();
	const count = view.el('input');
	Object.assign(count, { type: 'number', min: 1, max: N - 1, step: 1, inputmode: 'numeric', value: Math.max(1, Math.ceil(K * o.redundancy)) });
	const stepBox = view.el('input');
	stepBox.type = 'checkbox';
	stepBox.checked = oneAtATime();
	stepBox.onchange = () => setOneAtATime(stepBox.checked);
	const info = view.el('p.dim');
	const status = view.el('p.dim');
	const send = view.el('button.primary', 'Send');
	const stop = view.el('button', 'Stop');
	const finish = view.el('button', 'Finish');
	const close = view.el('button', 'Close');
	stop.hidden = finish.hidden = true;
	const dialog = view.el('dialog.trust-dialog',
		view.el('h3', 'Send again'),
		view.el('p', `New blocks of this post, any ${K} of which decode it: a station still short of blocks completes it with any of them, one that heard none needs ${K}.`),
		view.el('label.field', 'New blocks ', count),
		view.el('label.check', stepBox, view.el('span', 'one at a time, pressing Send for each')),
		info,
		view.el('div.row', send, stop, finish, close),
		status);
	const say = (t) => {
		status.textContent = t;
	};
	const blocks = () => Math.max(1, Math.min(N - 1, Math.floor(Number(count.value)) || 1));
	// the seconds per frame, or the fewest that hold a block
	const seconds = (E) => {
		const s = secondsFor(E, frameLength, o.snr);
		if (s === null)
			throw new Error(`a block of ${blen} bytes doesn't fit any frame at ${o.snr} dB`);
		return Math.max(o.seconds, s);
	};
	const show = async () => {
		try {
			const E = await encoderFor(48000);
			const opts = { seconds: seconds(E), snr: o.snr, lead: leadSymbols() };
			const n = blocks();
			info.textContent = `${n} ${n === 1 ? 'frame' : 'frames'} of ${frameLength} bytes, ${opts.seconds} s each${opts.seconds > o.seconds ? ' (longer, to hold a block)' : ''}, ${airtime(E, new Array(n).fill(frameLength), opts).toFixed(1)} s in all.`;
		} catch (err) {
			info.textContent = err.message;
		}
	};
	count.oninput = show;
	show();
	send.onclick = async () => {
		const ctx = audioOut();
		send.disabled = true;
		try {
			if (!ctx || stepping)
				throw new Error('already sending');
			const E = await encoderFor(48000);
			say('Preparing …');
			const r = await station.resend(set, blocks());
			if (!r)
				throw new Error("this station no longer keeps all the blocks it decoded, or they don't rebuild the same root");
			if (!r.frames.length)
				throw new Error('every block of this post was sent already');
			await transmit(ctx, { frames: r.frames, K: null, o: { ...o, seconds: seconds(E) } }, 'fragments', say, stop, stepBox.checked ? { next: send, finish } : null);
		} catch (err) {
			say(`Can't send: ${err.message}`);
		}
		send.disabled = false;
	};
	// closing ends what this dialog sends, so nothing is left waiting
	const done = () => {
		if (!stop.hidden)
			stop.click();
		if (!finish.hidden)
			finish.click();
		dialog.remove();
	};
	close.onclick = () => dialog.close();
	dialog.onclose = done;
	document.body.append(dialog);
	dialog.showModal();
}

// ---------------------------------------------------------- output level

// dB below the modem's full scale, per device
function outputLevel() {
	const v = Number(recall('outputLevel'));
	return recall('outputLevel') !== null && Number.isFinite(v) ? Math.max(LEVEL_MIN, Math.min(0, v)) : LEVEL_DEFAULT;
}

function showLevel() {
	$('output-level').value = outputLevel();
	$('output-level-value').textContent = `${outputLevel()} dB`;
}
$('output-level').oninput = () => {
	remember('outputLevel', $('output-level').value);
	showLevel();
};
showLevel();

// symbols of leading noise before each transmission, per device
function leadSymbols() {
	const v = Number(recall('lead'));
	return Number.isInteger(v) && v >= 1 && v <= 15 ? v : 1;
}

function showLead() {
	$('lead').value = leadSymbols();
	$('lead-value').textContent = `${(leadSymbols() * 41 / 300).toFixed(2)} s`;
}
$('lead').oninput = () => {
	remember('lead', $('lead').value);
	showLead();
	estimate();
};
showLead();

$('test-output').onclick = async () => {
	if (sending || stepping)
		return;
	const ctx = audioOut();
	$('test-output').disabled = true;
	try {
		// exactly the leading noise before a transmission, at the output level
		const audio = (await encoderFor(ctx.sampleRate)).noise(leadSymbols());
		deafUntil = Infinity;
		sending = play(ctx, audio, outputLevel());
		status('sending', 'ok');
		await sending.done;
	} catch (err) {
		status(`can't test: ${err.message}`, 'warn');
	} finally {
		sending = null;
		deafUntil = Date.now() + 1500;
		$('test-output').disabled = false;
		if ($('status').textContent === 'sending')
			status(receiver ? 'listening' : 'not listening');
	}
};

// the post can't change while its fragments go out one at a time
function lockSend(on) {
	for (const e of document.querySelectorAll('#send input, #send textarea, #send select, #send .segmented button, #attachments button, #collect-button, #outbox input, #outbox .remove'))
		e.disabled = on;
}

// fragments one at a time, as the operator last chose
const oneAtATime = () => recall('oneAtATime') === '1';
const setOneAtATime = (on) => {
	remember('oneAtATime', on ? '1' : '0');
	$('one-at-a-time').checked = on;
	$('outbox-one-at-a-time').checked = on;
};

$('send-button').onclick = async () => {
	const ctx = audioOut();
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
		if (await transmit(ctx, d, how, say, $('send-stop'), step))
			clearForm();
	} catch (err) {
		say(`Can't send: ${err.message}`);
		estimate();
	}
};

// the form empty again for the next post; with keepTo, a Topic's
// address stays, for the next photo to the same place
function clearForm(keepTo = false) {
	attachments = [];
	showAttachments();
	$('text').value = '';
	$('subject').value = '';
	$('hex').value = '';
	$('include-call').checked = false;
	$('include-name').checked = false;
	$('include-avatar').checked = false;
	if (!keepTo) {
		$('to-kind').value = '';
		$('to-value').value = '';
		setTo();
	}
	replyTo = null;
	setKind(kind === 'reply' ? 'topic' : kind);
}

// ---------------------------------------------------------------- outbox

// Posts collected to go out later, together: each keeps the timestamp of
// when it was collected, so its post ID is known and stays; they are
// signed when sent, one Signed record per key with its call sign, name
// and avatar once in front of them (sender.js, bundled()). Kept in
// data/outbox.json as { posts: [{ key, kind, subject, text, parts, parent,
// to, timestamp, collected }] }, parent and a To fingerprint in hex, the
// attached files as their records in base64.
const collected = async () => (await store.getData('outbox'))?.posts ?? [];
// attached files as the records they become, in base64
const toBase64 = (b) => {
	let s = '';
	for (let i = 0; i < b.length; i += 32768)
		s += String.fromCharCode(...b.subarray(i, i + 32768));
	return btoa(s);
};
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
// what the Compose tab says waits in the Outbox
const waiting = (n) => n ? `Collected. ${n === 1 ? 'One post waits' : `${n} posts wait`} in the Outbox.` : '';
const setCollected = async (posts) => {
	await store.putData('outbox', { posts });
	// a note on the Compose tab about what waits stays true once posts are
	// sent or removed
	if ($('send-status').textContent.startsWith('Collected.'))
		$('send-status').textContent = waiting(posts.length);
};
// whether each key's call sign, name and avatar go along, off again after
// each sent bundle
const outboxWith = new Map();

$('collect-button').onclick = () => collect();

// The post as the form has it into the Outbox, the form cleared but for
// the address with keepTo. Resolves to whether it was collected.
async function collect(keepTo = false) {
	$('collect-button').disabled = true;
	try {
		const d = await draft();
		if (!d.post)
			throw new Error(d.why);
		const p = d.post;
		const to = p.to?.key ? { key: view.hex(p.to.key) } : p.to;
		const posts = [...await collected(), { key: d.key, kind: p.kind, subject: p.subject, text: p.text, parts: p.parts.map(toBase64), parent: p.parent && view.hex(p.parent), to, timestamp: p.timestamp, collected: Date.now() }];
		await setCollected(posts);
		clearForm(keepTo);
		$('send-status').textContent = waiting(posts.length);
		showOutbox();
		return true;
	} catch (err) {
		$('send-status').textContent = `Can't collect: ${err.message}`;
		estimate();
		return false;
	}
}

// Photo: the camera, then straight into the Outbox, one photo one post,
// signed as and sent to what the form says. The subject is what was
// typed, or "Photo 14:32"; the address stays for the next photo. When it
// can't be collected, the photo stays attached, with why.
$('photo').onchange = async () => {
	const f = $('photo').files[0];
	$('photo').value = '';
	if (!f)
		return;
	if (attachments.length >= FILES_MAX) {
		$('send-status').textContent = `Can't add the photo: at most ${FILES_MAX} files per post.`;
		return;
	}
	$('send-status').textContent = 'Preparing the photo …';
	try {
		attachments.push(await attachFile(f));
	} catch (err) {
		$('send-status').textContent = `Can't add the photo: ${err.message}`;
		return;
	}
	showAttachments();
	const auto = kind === 'topic' && !$('subject').value.trim();
	if (auto)
		$('subject').value = `Photo ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
	// a subject of the time goes again if not collected, so a later photo
	// gets its own time
	if (!await collect(true) && auto)
		$('subject').value = '';
};

const TO_SHOWN = { call: 'to the call sign', name: 'to the name', group: 'to the board', key: 'to the fingerprint' };
// typed text, in its own direction
const typedText = (spec, text) => {
	const e = view.el(spec, text);
	e.dir = 'auto';
	return e;
};

// the collected posts by key, each with a Remove button
let showingOutbox = 0;
async function showOutbox() {
	if (!store || $('outbox').hidden)
		return;
	const mine = ++showingOutbox;
	const posts = await collected();
	const list = keys ? await keys.list() : [];
	if (mine !== showingOutbox)
		return;
	const byKey = new Map();
	for (const p of posts)
		byKey.set(p.key, [...byKey.get(p.key) ?? [], p]);
	$('outbox-empty').hidden = posts.length > 0;
	$('outbox-groups').replaceChildren(...[...byKey].map(([key, mine]) => {
		const k = list.find((x) => x.key === key);
		const r = station.keyInfo(key).revoked;
		const w = outboxWith.get(key) ?? { call: false, name: false, avatar: false };
		outboxWith.set(key, w);
		// the key's call sign, name and avatar, once for all its posts
		const include = (what, shown, bytes) => {
			const box = view.el('input');
			box.type = 'checkbox';
			box.checked = w[what];
			box.disabled = stepping;
			box.onchange = () => {
				w[what] = box.checked;
				outboxEstimate();
			};
			return view.el('label.check', box, ' ', view.el('span', `Include the ${what === 'call' ? 'call sign' : what}`, shown ? ' ' : '', shown, `, ${view.bytes(bytes)} more`));
		};
		const icon = view.identicon(fromHex(key));
		const head = view.el('div.key-card-head', k?.avatar ? view.withAvatar(icon, k.avatar) : icon, view.el('strong', k ? k.label : 'a key no longer held'), view.el('span.key', key.slice(0, 8)));
		const out = [head];
		if (!k)
			out.push(view.el('p.warn', 'This key is gone from the station, so these posts can\'t be signed: remove them.'));
		else if (r.retired !== null || r.compromised !== null)
			out.push(view.el('p.warn', 'This key is revoked and signs nothing new: remove these posts.'));
		else {
			if (k.callSign)
				out.push(include('call', view.el('span.call', k.callSign), fromCall(k.callSign).length));
			if (k.name)
				out.push(include('name', typedText('span', k.name), fromName(smallestText(k.name)).length));
			if (k.avatar)
				out.push(include('avatar', '', k.avatar.length));
		}
		for (const p of mine) {
			const remove = view.el('button.small.remove', 'Remove');
			remove.disabled = stepping;
			remove.onclick = async () => {
				await setCollected((await collected()).filter((x) => !(x.key === p.key && x.collected === p.collected)));
				showOutbox();
			};
			const [to, handle] = p.to ? Object.entries(p.to)[0] : [];
			const where = p.kind === 'reply' ? ['↩ to ', view.el('span.key', p.parent.slice(0, 8))]
				: to ? [`${TO_SHOWN[to]} `, to === 'key' ? view.el('span.key', handle.slice(0, 8)) : typedText('span', handle)]
				: ['to everyone'];
			out.push(view.el('div.outbox-post',
				p.kind === 'topic' ? typedText('strong', p.subject) : view.el('strong', 'Reply'),
				view.el('span.dim', ...where, ` · collected ${view.when(p.collected)}`),
				p.text ? typedText('p.outbox-text', p.text.length > 300 ? `${p.text.slice(0, 300)} …` : p.text) : '',
				p.parts?.length ? view.el('span.dim', `${p.parts.length === 1 ? 'one file' : `${p.parts.length} files`}, ${view.bytes(p.parts.reduce((n, x) => n + fromBase64(x).length, 0))}`) : '',
				view.el('div.row', remove)));
		}
		return view.el('div.key-card', ...out);
	}));
	return outboxEstimate();
}

// all collected posts in one payload, a Signed record per key, or { why };
// with dry, only as large as signed, for estimates
async function outboxDraft(dry = false) {
	const o = await own();
	const posts = await collected();
	// the empty outbox says so itself
	if (!posts.length)
		return { why: '' };
	if (!keys)
		return { why: 'CRYPTO failed to load, so nothing can be signed.' };
	const list = await keys.list();
	const byKey = new Map();
	for (const p of posts)
		byKey.set(p.key, [...byKey.get(p.key) ?? [], p]);
	const records = [];
	for (const [key, mine] of byKey) {
		const k = list.find((x) => x.key === key);
		const r = station.keyInfo(key).revoked;
		if (!k || r.retired !== null || r.compromised !== null)
			return { why: 'Remove the posts of keys that can\'t sign first.' };
		const w = outboxWith.get(key) ?? {};
		records.push(bundled({
			posts: mine.map((p) => ({
				kind: p.kind, subject: p.subject, text: p.text, timestamp: p.timestamp,
				parts: (p.parts ?? []).map(fromBase64),
				parent: p.parent && fromHex(p.parent),
				to: p.to?.key ? { key: fromHex(p.to.key) } : p.to,
			})),
			callSign: w.call ? k.callSign : null,
			name: w.name ? k.name : null,
			avatar: w.avatar ? k.avatar : null,
			sign: dry ? unsigned : await keys.signer(key),
		}));
	}
	return { payload: framePayload(records), o, posts };
}

let outboxEstimating = 0;
async function outboxEstimate() {
	if (stepping || !store)
		return;
	const mine = ++outboxEstimating;
	let d;
	try {
		d = await outboxDraft(true);
	} catch (err) {
		d = { why: err.message };
	}
	if (mine !== outboxEstimating)
		return;
	if (!d.payload) {
		$('outbox-send').disabled = true;
		$('outbox-choice').hidden = true;
		$('outbox-info').textContent = d.why;
		return;
	}
	const n = d.posts.length;
	showPlan(await encoderFor(48000), d, OUTBOX_UI);
	$('outbox-info').prepend(`${n === 1 ? 'One post' : `${n} posts`}, `);
}

for (const r of document.querySelectorAll('input[name=outbox-how]'))
	r.onchange = outboxEstimate;
$('outbox-one-at-a-time').onchange = () => setOneAtATime($('outbox-one-at-a-time').checked);

$('outbox-send').onclick = async () => {
	const ctx = audioOut();
	$('outbox-send').disabled = true;
	const say = (t) => {
		$('outbox-status').textContent = t;
	};
	try {
		const d = await outboxDraft();
		if (!d.payload)
			throw new Error(d.why);
		const how = document.querySelector('input[name=outbox-how]:checked')?.value ?? 'fragments';
		const step = how === 'fragments' && oneAtATime() ? { next: $('outbox-send'), finish: $('outbox-finish') } : null;
		// finished with too few fragments to decode, the posts stay to be
		// sent again, with the same IDs
		const done = await transmit(ctx, d, how, say, $('outbox-stop'), step);
		if (done === 'short')
			say(`${$('outbox-status').textContent} The posts stay here.`);
		if (done === true) {
			// the ones sent leave, ones collected meanwhile stay
			const sent = new Set(d.posts.map((p) => `${p.key}_${p.collected}`));
			await setCollected((await collected()).filter((p) => !sent.has(`${p.key}_${p.collected}`)));
			outboxWith.clear();
			showOutbox();
		}
	} catch (err) {
		say(`Can't send: ${err.message}`);
		outboxEstimate();
	}
};

// which version runs, from its files, once the app has settled: they come
// through the service worker, the network's when online, so mostly small
// "unchanged" answers, the offline copy otherwise
setTimeout(async () => {
	try {
		$('version').textContent = `Version ${await running()}`;
	} catch (err) {
		$('version').textContent = `Version unknown: ${err.message}`;
	}
}, 3000);

await fillOwn();
await trustOwn();
await fillKeys();
await showRelay();
$('one-at-a-time').checked = oneAtATime();
$('outbox-one-at-a-time').checked = oneAtATime();
setKind('topic');
// the text encoders are built on first use, which takes a moment: build
// them while nothing else happens, not on the first post's estimate
setTimeout(() => smallestText('Rattlechan'), 3000);

const startTab = recall('tab');
showTab(['inbox', 'boards', 'send', 'outbox', 'station'].includes(startTab) ? startTab : 'inbox');
