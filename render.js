// Turning parsed records (records.js nodes) and station entries into DOM.
// Received content only ever goes in as text, never as markup.

import { T, decodeText, TEXT_TABLE, audioInfo } from './records.js';
import { blake2s } from './blake2s.js';
import { pictureInfo, small, huge, decodedBytes, formatOf, WARN_MAX } from './pictures.js';

export const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
export const short = (a) => hex(a.subarray(0, 4));

// el('div.a.b', child, 'text', ...) with classes after the tag name
export function el(spec, ...children) {
	const [tag, ...classes] = spec.split('.');
	const e = document.createElement(tag || 'div');
	if (classes.length)
		e.className = classes.join(' ');
	for (const c of children)
		if (c !== null && c !== undefined && c !== false)
			e.append(c instanceof Node ? c : String(c));
	return e;
}

export const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1073741824).toFixed(1)} GiB`;

export const when = (ms) => new Date(ms).toLocaleString(undefined, {
	year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// a text record as text, or a short hash where this client can't decode it
function text(node, cls = 'text') {
	const s = decodeText(node);
	if (s === null)
		return el('span.hash', `#${short(blake2s(node.body))}`);
	const e = el(`span.${cls}`, s);
	e.dir = 'auto';
	return e;
}

function encodingOf(node) {
	if (node.type === T.TEXT_TABLE)
		return TEXT_TABLE[node.table] ?? `table ${node.table}`;
	return { [T.TEXT_UTF8]: 'UTF-8', [T.TEXT_GB18030]: 'GB 18030', [T.TEXT_SCSU]: 'SCSU' }[node.type] ?? `0x${node.type.toString(16)}`;
}

const fixed = (v, scale, digits) => (v / scale).toFixed(digits);

// What the page knows about keys, set by the app with configure():
//   keyInfo(hex) -> { trusted, own, callSign, name, avatar }, own for the
//     station's own keys, which are always trusted
//   trust(hex, on) is called when the user asks to trust or not
//   reply(id) when the user wants to answer a post
//   setOf(id) -> the decoded fragment set a post arrived in, or null
//   resend(set) when the user wants to send new blocks of that set
//   postAgain(id) whether a post that came in one frame can go out again
//   resendPost(id) when the user wants to send that post again
let station = { keyInfo: (key) => ({ key, trusted: false }), trust: () => {}, reply: () => {}, setOf: () => null, resend: () => {}, postAgain: () => false, resendPost: () => {} };
export const configure = (s) => {
	station = s;
};
const trusted = (key) => key !== null && station.keyInfo(key).trusted;

// From prefixes are believed only on posts signed by a trusted key; anyone
// can claim a call sign or name, so otherwise they are marked
function prefix(p, believed) {
	const what = {
		[T.FROM_CALL]: 'from', [T.FROM_NAME]: 'from', [T.TO_KEY]: 'to', [T.TO_CALL]: 'to',
		[T.TO_NAME]: 'to', [T.TO_GROUP_NAME]: 'to group', [T.TO_GROUP_KEY]: 'to group',
	}[p.type];
	let handle;
	if (p.type === T.FROM_CALL || p.type === T.TO_CALL)
		handle = el('span.call', p.handle);
	else if (p.type === T.TO_KEY || p.type === T.TO_GROUP_KEY)
		return recipient(p.handle, what);
	else
		handle = text(p.handle, 'name');
	if (p.type !== T.FROM_CALL && p.type !== T.FROM_NAME || believed)
		return el('span.chip', `${what} `, handle);
	const chip = el('span.chip.unverified', `${what} `, handle, '?');
	chip.title = 'unverified: anyone can claim this';
	return chip;
}

// A recipient key: its identicon, and what the station learned about it,
// call sign and name, once it is trusted (SPEC.md: names are earned),
// otherwise its short hash; the whole fingerprint on hover
function recipient(keyBytes, what) {
	const key = hex(keyBytes);
	const info = station.keyInfo(key);
	const chip = el('span.chip.recipient', `${what} `, identicon(keyBytes, 16), ' ');
	if (info.trusted && (info.callSign || info.name)) {
		if (info.callSign)
			chip.append(el('span.call', info.callSign));
		if (info.name)
			chip.append(info.callSign ? ' ' : '', nameOf(info.name));
	} else {
		chip.append('fingerprint ', el('span.key', short(keyBytes)));
	}
	const status = revokedAs(info);
	if (status)
		chip.append(' ', el(status === 'compromised' ? 'span.bad' : 'span.warn', status));
	chip.title = key.match(/.{4}/g).join(' ');
	return chip;
}

// ------------------------------------------------------------ identicons

// A key's identicon: a mirrored 5x5 grid in one of 8 colours, from its
// fingerprint. The colours are --id-0 .. --id-7 in app.css.
const SVG = 'http://www.w3.org/2000/svg';
export function identiconCells(key) {
	const cells = [];
	for (let i = 0; i < 15; ++i)
		if (key[1 + (i >> 3)] >> (i & 7) & 1) {
			const x = i % 3, y = Math.floor(i / 3);
			cells.push([x, y]);
			if (x < 2)
				cells.push([4 - x, y]);
		}
	return { colour: key[0] % 8, cells };
}

export function identicon(key, size = 32) {
	const { colour, cells } = identiconCells(key);
	const svg = document.createElementNS(SVG, 'svg');
	svg.setAttribute('viewBox', '-0.5 -0.5 6 6');
	svg.setAttribute('width', size);
	svg.setAttribute('height', size);
	svg.setAttribute('class', `identicon id-${colour}`);
	svg.setAttribute('role', 'img');
	svg.setAttribute('aria-label', `identicon of fingerprint ${short(key)}`);
	for (const [x, y] of cells) {
		const r = document.createElementNS(SVG, 'rect');
		r.setAttribute('x', x);
		r.setAttribute('y', y);
		r.setAttribute('width', 1);
		r.setAttribute('height', 1);
		svg.append(r);
	}
	return svg;
}

const fromHex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));

// a trusted key's avatar, or its identicon until there is one
export function face(key, size = 32) {
	const info = station.keyInfo(key);
	const icon = identicon(fromHex(key), size);
	if (!info.trusted || !info.avatar)
		return icon;
	return withAvatar(icon, info.avatar);
}

// an avatar (PNG, JPEG, GIF or WebP bytes) in place of icon once it
// loads, an animated one still until hovered or touched; icon stays if it
// can't be drawn
export function withAvatar(icon, avatar) {
	const wrap = el('span.face', icon);
	const info = pictureInfo(avatar);
	if (!info)
		return wrap;
	const blob = new Blob([avatar], { type: info.type });
	(info.animated ? animated(blob, 'avatar', 'avatar') : Promise.resolve(Object.assign(el('img.avatar'), { src: URL.createObjectURL(blob), alt: 'avatar' })))
		.then((pic) => icon.replaceWith(pic))
		.catch(() => {});
	return wrap;
}

// a name learned from a post is a text record, one from the station's own
// key list a string
function nameOf(name) {
	if (typeof name !== 'string')
		return text(name, 'name');
	const e = el('span.name', name);
	e.dir = 'auto';
	return e;
}

// a key's revocation as it stands: 'compromised', 'retired' or null
const revokedAs = (info) => info.revoked?.compromised != null ? 'compromised' : info.revoked?.retired != null ? 'retired' : null;

// the arrival of the entry being drawn: a retired key's posts are marked
// from its revocation on
let drawing = null;
// whether a post is drawn in a thread, where pictures show right away
let inThread = false;

// who signed: face, then call sign and name once trusted, the short
// fingerprint otherwise, and the button to trust or stop trusting. A
// compromised key gets no button: trust can't bring it back.
function signer(n) {
	const key = hex(n.key);
	const info = station.keyInfo(key);
	const who = el('span.who');
	if (info.trusted && (info.callSign || info.name)) {
		if (info.callSign)
			who.append(el('span.call', info.callSign));
		if (info.name)
			who.append(info.callSign ? ' ' : '', nameOf(info.name));
		who.append(' ', el('span.key', short(n.key)));
	} else {
		who.append('fingerprint ', el('span.key', short(n.key)));
	}
	const status = revokedAs(info);
	const mark = status === 'compromised' ? el('span.bad', 'compromised')
		: status === 'retired' && drawing !== null && drawing >= info.revoked.retired ? el('span.warn', 'retired key') : null;
	if (mark)
		who.append(' ', mark);
	if (info.own)
		return [face(key), who, el('span.ok', 'your key')];
	if (status === 'compromised')
		return [face(key), who];
	if (info.trusted)
		who.append(' ', el('span.ok', 'trusted'));
	const button = el('button.small.trust', info.trusted ? 'Untrust' : 'Trust');
	button.onclick = () => station.trust(key, !info.trusted);
	return [face(key), who, button];
}

// Asks whether to trust a key, showing its whole fingerprint to compare
// with its owner. Resolves to true or false.
export function confirmTrust(key) {
	const info = station.keyInfo(key);
	const groups = key.match(/.{4}/g);
	const fp = el('p.fingerprint');
	for (let i = 0; i < groups.length; i += 4)
		fp.append(el('span', groups.slice(i, i + 4).join(' ')));
	const says = [];
	if (info.callSign)
		says.push(el('span.call', info.callSign));
	if (info.name)
		says.push(says.length ? ' ' : '', nameOf(info.name));
	const cancel = el('button', 'Cancel');
	const ok = el('button.primary', 'Trust');
	const dialog = el('dialog.trust-dialog',
		el('h3', 'Trust this key?'),
		identicon(fromHex(key), 64),
		fp,
		says.length ? el('p', 'It says it is ', ...says, '.') : el('p.dim', 'It has not said who it is.'),
		info.unkept?.length ? el('p.warn', `It was revoked as ${info.unkept.includes('compromised') ? 'compromised: trusting it keeps the revocation, and its posts stay untrusted' : 'retired: trusting it keeps the revocation, and marks its posts from then on'}.`) : null,
		el('p.dim', 'Compare the fingerprint with its owner, in person or over a channel you trust. Posts signed by a trusted key show its call sign, name and avatar, and are kept in the precious tier.'),
		el('div.row', cancel, ok));
	document.body.append(dialog);
	return new Promise((resolve) => {
		const done = (answer) => {
			dialog.close();
			dialog.remove();
			resolve(answer);
		};
		cancel.onclick = () => done(false);
		ok.onclick = () => done(true);
		dialog.oncancel = (e) => {
			e.preventDefault();
			done(false);
		};
		dialog.showModal();
	});
}

function position(n) {
	const lat = fixed(n.lat, 1e7, 7), lon = fixed(n.lon, 1e7, 7);
	const a = el('a', `${lat}, ${lon}`);
	a.href = `geo:${lat},${lon}`;
	return el('div.part', '📍 ', a, el('span.dim', ` fix ${when(n.time * 1000)}`));
}

// the first frame of a picture, on a canvas
async function still(blob) {
	const canvas = el('canvas.picture');
	const ctx = canvas.getContext('2d');
	if (typeof ImageDecoder !== 'undefined') {
		try {
			const dec = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type });
			const { image } = await dec.decode({ frameIndex: 0 });
			canvas.width = image.displayWidth;
			canvas.height = image.displayHeight;
			ctx.drawImage(image, 0, 0);
			image.close();
			dec.close();
			return canvas;
		} catch {}
	}
	// a freshly decoded image draws its first frame
	const img = new Image();
	img.src = URL.createObjectURL(blob);
	try {
		await img.decode();
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		ctx.drawImage(img, 0, 0);
	} finally {
		URL.revokeObjectURL(img.src);
	}
	return canvas;
}

// play() and stop() of each animated picture on the page
const players = new WeakMap();

// Nothing moves by itself: an animated picture shows its first frame and
// plays only while the mouse is over it, or while a finger is on its
// entry (see entry()), each time from the start
async function animated(blob, label, cls = 'picture') {
	const frame = await still(blob);
	frame.className = cls;
	frame.setAttribute('role', 'img');
	frame.setAttribute('aria-label', `${label}, animated`);
	const wrap = el('span.animated', frame);
	let img = null;
	const play = () => {
		if (img)
			return;
		img = el(`img.${cls}`);
		img.alt = label;
		img.src = URL.createObjectURL(blob);
		frame.replaceWith(img);
	};
	const stop = () => {
		if (!img)
			return;
		img.replaceWith(frame);
		URL.revokeObjectURL(img.src);
		img = null;
	};
	players.set(wrap, { play, stop });
	wrap.addEventListener('pointerenter', (e) => e.pointerType !== 'touch' && play());
	wrap.addEventListener('pointerleave', (e) => e.pointerType !== 'touch' && stop());
	return wrap;
}

// a touch anywhere on an entry plays its animated pictures until the
// finger lifts, so the finger doesn't cover them
export function touchToPlay(box) {
	const all = (what) => {
		for (const a of box.querySelectorAll('.animated'))
			players.get(a)?.[what]();
	};
	box.addEventListener('pointerdown', (e) => e.pointerType === 'touch' && all('play'));
	for (const type of ['pointerup', 'pointercancel', 'pointerleave'])
		box.addEventListener(type, (e) => e.pointerType === 'touch' && all('stop'));
}

// An Audio part by its bytes: Codec2 to save (browsers don't decode it),
// Opus in Ogg also to play, but only when asked for: nothing plays by itself
function audioPart(n, key) {
	const info = audioInfo(n.body);
	if (!info)
		return el('div.part.dim', `🔊 audio that can't be read, ${bytes(n.body.length)} `, saveButton(n, key));
	if (info.format === 'codec2')
		return el('div.part', `🔊 Codec2 ${info.name}, ${bytes(info.frames)} of voice `, saveButton(n, key));
	const play = el('button.small', 'Play');
	play.onclick = () => {
		const a = el('audio');
		a.controls = true;
		a.src = URL.createObjectURL(new Blob([n.body], { type: 'audio/ogg; codecs=opus' }));
		a.onerror = () => a.replaceWith(el('span.dim', "this browser can't play Opus; save it instead"));
		play.replaceWith(a);
		a.play().catch(() => {});
	};
	return el('div.part', `🔊 Opus${info.channels === 2 ? ', stereo' : ''}, ${bytes(n.body.length)} `, play, ' ', saveButton(n, key));
}

// A picture part: PNG, JPEG, GIF or WebP by its bytes, whatever type it
// claims. In a thread, one up to 1024x1024 under a trusted key's signature
// is drawn right away, scaled to fit; any other only when asked for. An
// avatar under a trusted key's signature is drawn right away anywhere.
// A drawn picture opens at full size when tapped. null if data is no
// picture.
function picture(n, data, label, key) {
	const info = pictureInfo(data);
	if (!info)
		return null;
	// beyond 4096 on a side only after a warning, never right away
	const warn = huge(info);
	const b = el(warn ? 'button.small.warn' : 'button.small', `show ${warn ? 'very large ' : ''}${label}, ${formatOf(info)}, ${info.width}x${info.height}, ${bytes(data.length)}`);
	const draw = async () => {
		if (warn && !await ask('Show a very large picture?', [
			`It is ${info.width}x${info.height} pixels in a file of ${bytes(data.length)}. Drawing it takes at least ${bytes(decodedBytes(info))} of memory${info.animated ? ' for each of its frames' : ''}, and may freeze or crash the app.`,
			`Pictures larger than ${WARN_MAX} pixels on a side are rare on the air; a small file holding a huge picture is a known trick to bring a station down.`,
		], 'Show it'))
			return;
		try {
			b.replaceWith(await drawn(data, info, label, 'picture', true));
		} catch {
			b.replaceWith(el('span.bad', `${label} can't be shown`));
		}
	};
	b.onclick = draw;
	if (trusted(key) && (label === 'avatar' || (inThread && small(info))))
		queueMicrotask(draw);
	return el('div.part', b, label === 'avatar' && key ? el('span.dim', ` for fingerprint ${key.slice(0, 8)}`) : '', ' ', saveButton(n, key));
}

// a picture as an element of class cls, an animated one still until
// played, or playing with plays; with opens, tapping it opens it at full
// size
async function drawn(data, info, label, cls, opens, plays = false) {
	const blob = new Blob([data], { type: info.type });
	let e;
	if (info.animated && !plays) {
		e = await animated(blob, label, cls);
	} else {
		e = el(`img.${cls}`);
		e.alt = label;
		e.src = URL.createObjectURL(blob);
		await e.decode();
	}
	if (opens) {
		e.classList.add('opens');
		e.onclick = () => fullSize(data, info, label);
	}
	return e;
}

// the picture at its own size, scrolling if it doesn't fit, closed by its
// button, Escape or a tap beside it; an animated one plays at once, as the
// tap that opened it asked to watch it
async function fullSize(data, info, label) {
	const close = el('button.small', 'Close');
	const dialog = el('dialog.picture-dialog', el('div.row', el('span.dim', `${formatOf(info)}, ${info.width}x${info.height}, ${bytes(data.length)}`), close),
		el('div.picture-full', await drawn(data, info, label, 'picture-natural', false, true)));
	document.body.append(dialog);
	const done = () => {
		dialog.close();
		dialog.remove();
	};
	close.onclick = done;
	dialog.onclick = (e) => e.target === dialog && done();
	dialog.onclose = () => dialog.remove();
	dialog.showModal();
	close.focus();
}

// ------------------------------------------------------------- saving

// Extensions for the content types a MIME escape may name; anything else
// is saved as .bin, so no content type turns a file into a program by
// its name (SPEC.md, File names only on MIME escape)
const EXTENSIONS = Object.freeze({
	'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv',
	'application/pdf': 'pdf', 'application/json': 'json', 'application/gpx+xml': 'gpx',
	'application/zip': 'zip', 'application/gzip': 'gz',
	'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
	'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/flac': 'flac',
	'video/mp4': 'mp4', 'video/webm': 'webm',
});

// A media part as a file: { name, data }. Only a MIME escape brings its
// own name; everything else is named by the BLAKE2s-256 of the file, hex,
// with the extension of its type. Pictures and audio are saved as they
// came, a Codec2 file as .c2 and Opus in Ogg as .opus.
export function fileOf(n) {
	let data, ext;
	switch (n.type) {
	case T.PICTURE:
	case T.AVATAR:
		data = n.body;
		ext = EXTENSIONS[pictureInfo(n.body)?.type] ?? 'bin';
		break;
	case T.AUDIO:
		data = n.body;
		ext = { codec2: 'c2', opus: 'opus' }[audioInfo(n.body)?.format] ?? 'bin';
		break;
	case T.MIME:
		if (n.fileName)
			return { name: n.fileName, data: n.content };
		data = n.content;
		ext = EXTENSIONS[n.mime] ?? 'bin';
		break;
	default:
		return null;
	}
	return { name: `${hex(blake2s(data))}.${ext}`, data };
}

function download(f) {
	const a = el('a');
	a.href = URL.createObjectURL(new Blob([f.data], { type: 'application/octet-stream' }));
	a.download = f.name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// A question in a dialog, Cancel first and focused. Resolves to true or
// false.
function ask(title, lines, yes) {
	const cancel = el('button', 'Cancel');
	const ok = el('button.danger', yes);
	const dialog = el('dialog.trust-dialog', el('h3', title), ...lines.map((l) => el('p', l)), el('div.row', cancel, ok));
	document.body.append(dialog);
	return new Promise((resolve) => {
		const done = (answer) => {
			dialog.close();
			dialog.remove();
			resolve(answer);
		};
		cancel.onclick = () => done(false);
		ok.onclick = () => done(true);
		dialog.oncancel = (e) => {
			e.preventDefault();
			done(false);
		};
		dialog.showModal();
		cancel.focus();
	});
}

// Save a part: right away under a trusted key's signature, otherwise only
// after two questions (SPEC.md, Downloads)
function saveButton(n, key) {
	const f = fileOf(n);
	const sure = trusted(key);
	const b = el('button.small', sure ? 'Save' : 'Save…');
	b.title = f.name;
	b.onclick = async () => {
		if (!sure) {
			if (!await ask('Save a file from a stranger?', [
				key ? 'It is signed by a key you don\'t trust.' : 'No key you trust signed it.',
				'A file can harm your computer when opened.',
			], 'Continue'))
				return;
			if (!await ask('Are you really sure?', [
				`${f.name}, ${bytes(f.data.length)}`,
				'Its name and type prove nothing about what it really contains. Open it only with a program you trust.',
			], 'Save the file'))
				return;
		}
		download(f);
	};
	return b;
}

// whether a Revoke counts: not where it is, kept, or waiting for the key
// to be trusted
function revocationNote(n, key) {
	if (!n.effective)
		return ' (no effect here)';
	const info = key ? station.keyInfo(key) : null;
	if (info?.revoked?.[n.reason] != null)
		return el('span.dim', ' (kept)');
	if (info?.unkept?.includes(n.reason))
		return el('span.dim', ' (counts once you trust the key)');
	return '';
}

function leaf(n, key = null) {
	switch (n.type) {
	case T.TEXT_UTF8:
	case T.TEXT_GB18030:
	case T.TEXT_TABLE:
	case T.TEXT_SCSU: {
		const e = el('div.part', text(n));
		e.title = encodingOf(n);
		return e;
	}
	case T.POSITION:
		return position(n);
	case T.TEMPERATURE:
		return el('div.part', `🌡 ${fixed(n.value, 100, 2)} °C`);
	case T.HUMIDITY:
		return el('div.part', `💧 ${fixed(n.value, 100, 2)} %`);
	case T.PRESSURE:
		return el('div.part', `${fixed(n.value, 100, 2)} hPa`);
	case T.WIND:
		return el('div.part', `🌬 from ${fixed(n.direction, 100, 2)}°, ${fixed(n.speed, 100, 2)} m/s`);
	case T.ALTITUDE:
		return el('div.part', `⛰ ${fixed(n.value, 1000, 1)} m`);
	case T.VOLTAGE:
		return el('div.part', `🔋 ${fixed(n.value, 1000, 3)} V`);
	case T.MENTION:
		return el('div.part', '↗ ', el('span.key', short(n.id)));
	case T.PICTURE:
		return picture(n, n.body, 'picture', key) ?? el('div.part.dim', 'a picture that can\'t be read, ', bytes(n.body.length), ' ', saveButton(n, key));
	case T.AVATAR:
		if (n.ignored)
			return el('div.part.dim', `avatar ignored: ${n.ignored}`);
		return picture(n, n.body, 'avatar', key);
	case T.AUDIO:
		return audioPart(n, key);
	case T.MIME:
		// a picture is drawn whatever type it claims, anything else is a file
		return picture(n, n.content, 'picture', key) ?? el('div.part', '📄 ', n.fileName || 'unnamed', el('span.dim', ` ${n.mime}, ${bytes(n.content.length)} `), saveButton(n, key));
	case T.FRAGMENT:
		return el('div.part.dim', `Fragment ${n.index} of ${n.N}, ${n.K} needed, root ${short(n.root)}`, n.verified ? '' : ' (unchecked)');
	case T.REQUEST_POST:
		return el('div.part.dim', `asks for post ${short(n.id)}`);
	case T.REQUEST_ROOT:
		return el('div.part.dim', `asks for ${n.needed} more blocks of root ${short(n.root)}`);
	case T.REVOKE_RETIRED:
	case T.REVOKE_COMPROMISED:
		return el('div.part.warn', `revokes the key: ${n.reason}`, revocationNote(n, key));
	}
	return el('div.part.dim', `unknown record 0x${n.type.toString(16).padStart(2, '0')}, ${bytes(n.body?.length ?? 0)}`);
}

function post(n, key) {
	const head = el('div.post-head');
	if (n.type === T.TOPIC)
		head.append(el('strong', text(n.subject, 'subject')));
	else
		head.append('↩ reply to ', el('span.key', short(n.parent)));
	const e = el('div.post', head,
		el('div.dim', when(n.timestamp * 1000), n.id ? ` · ${short(n.id)}` : ''),
		...n.parts.map((p) => leaf(p, key)));
	if (n.id && !n.dropped) {
		const b = el('button.small.reply', 'Reply');
		b.onclick = () => station.reply(n.id);
		const actions = el('div.post-actions', b);
		// in a thread, a post that came in fragments can go out again; the
		// log has the button on its reassembled payload instead
		const set = inThread ? station.setOf(n.id) : null;
		if (set) {
			const again = el('button.small', 'Send again');
			again.onclick = () => station.resend(set);
			actions.append(again);
		} else if (station.postAgain(n.id)) {
			// one that came in one frame, its Signed record as it is
			const again = el('button.small', 'Send again');
			again.onclick = () => station.resendPost(n.id);
			actions.append(again);
		}
		e.append(actions);
	}
	return e;
}

const DROPPED = {
	'must-understand': 'needs a newer client, dropped',
	empty: 'empty post, dropped',
};

// only a verified signature puts a face and a trust button on it
function signed(n) {
	if (n.verified !== true) {
		const state = n.verified === false ? el('span.bad', '✗ signed') : el('span.dim', '? signed (unchecked)');
		return el('div.box', el('div.box-head', state, ' by fingerprint ', el('span.key', short(n.key))), n.dropped ? null : nodes(n.children));
	}
	return el('div.box', el('div.box-head.signer', el('span.ok', '✓'), ...signer(n)), n.dropped ? null : nodes(n.children, hex(n.key)));
}

// key: the hex key of the innermost verified signature around n, or null
export function node(n, key = null) {
	let e;
	if (n.type === T.SIGNED)
		e = signed(n);
	else if (n.type === T.KEYED)
		e = el('div.box', el('div.box-head', el('span.dim', '🔑 keyed, tag '), el('span.key', short(n.tag))), nodes(n.children));
	else if (n.type === T.BUNDLE)
		e = el('div.box', el('div.box-head.dim', 'bundle'), nodes(n.children, key));
	else if (n.type === T.TOPIC || n.type === T.REPLY)
		e = post(n, key);
	else
		e = leaf(n, key);
	if (n.prefixes?.length)
		e.prepend(el('div.chips', ...n.prefixes.map((p) => prefix(p, trusted(key)))));
	if (n.dropped) {
		e.classList.add('dropped');
		e.prepend(el('div.bad', DROPPED[n.dropped] ?? n.dropped));
	}
	return e;
}

export const nodes = (list, key = null) => el('div.nodes', ...list.map((n) => node(n, key)));

// A post of the BBS tree (tree.js): its signer, as in the log, then the
// post with its prefixes; a retired key is marked from the post's arrival
export function postBox(p) {
	drawing = p.arrival;
	inThread = true;
	try {
		const box = el('div.box.tree-post', el('div.box-head.signer', el('span.ok', '✓'), ...signer(p.signed)), node(p.node, hex(p.signed.key)));
		touchToPlay(box);
		return box;
	} finally {
		drawing = null;
		inThread = false;
	}
}

// a text record as text, or its short hash if it can't be decoded
export const textOf = (record, cls = 'text') => text(record, cls);

// the head line of an entry or event: time, call sign and the rest
export function head(arrival, callSign, ...rest) {
	return el('div.entry-head', el('span.time', when(arrival)), ' ', el('span.call', callSign ?? '—'), ...rest);
}

// a station entry (station.js): a frame as received
export function entry(e) {
	drawing = e.arrival;
	try {
		return entryBox(e);
	} finally {
		drawing = null;
	}
}

function entryBox(e) {
	const info = [];
	if (e.mode !== null && e.mode !== undefined)
		info.push(`mode ${e.mode}`);
	info.push(e.used !== undefined ? `${bytes(e.used)} of ${bytes(e.size)}` : bytes(e.size));
	if (e.snr)
		info.push(`SNR ${e.snr.median.toFixed(1)} dB`);
	if (e.bitFlips)
		info.push(`${e.bitFlips} bit flips`);
	const box = el('article.entry', head(e.arrival, e.callSign, el('span.dim', ` ${info.join(' · ')}`),
		e.error ? el('span.badge.bad', 'dropped') : e.tier ? el('span.badge', e.sent ? `sent · ${e.tier}` : e.tier) : el('span.badge.dim', 'not kept')));
	if (e.error) {
		box.append(el('div.bad', `malformed: ${e.error}`));
	} else {
		if (!e.nodes.length)
			box.append(el('div.dim', 'empty frame'));
		box.append(nodes(e.nodes));
	}
	for (const f of e.fragments) {
		if (f.nodes) {
			const again = el('button.small', 'Send again');
			again.onclick = () => station.resend(f.key);
			box.append(el('div.box', el('div.box-head.ok.row-between', el('span', `reassembled, ${bytes(f.used)}`), again), nodes(f.nodes)));
		}
		else if (f.error)
			box.append(el('div.bad', `reassembled payload malformed: ${f.error}`));
		else if (f.failed)
			box.append(el('div.bad', 'blocks did not decode'));
		else if (f.have)
			box.append(el('div.dim', `${f.have} of ${f.K} blocks`));
	}
	touchToPlay(box);
	return box;
}

// a decoder event that isn't a frame: pings and errors
export function event(ev, arrival) {
	if (ev.type === 'ping')
		return el('article.entry.event', head(arrival, ev.callSign, el('span.dim', ` ping ${ev.value}`)));
	const what = { preamble: 'preamble damaged', 'call sign': 'call sign not supported', mode: `unknown mode ${ev.mode}`, payload: 'payload did not decode' }[ev.what] ?? ev.what;
	return el('article.entry.event', head(arrival, ev.callSign, el('span.bad', ` ${what}`)));
}
