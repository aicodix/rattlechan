// Turning parsed records (records.js nodes) and station entries into DOM.
// Received content only ever goes in as text, never as markup.

import { T, decodeText, TEXT_TABLE } from './records.js';
import { blake2s } from './blake2s.js';

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

export const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`;

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

function prefix(p) {
	const what = {
		[T.FROM_CALL]: 'from', [T.FROM_NAME]: 'from', [T.TO_KEY]: 'to key', [T.TO_CALL]: 'to',
		[T.TO_NAME]: 'to', [T.TO_GROUP_NAME]: 'to group', [T.TO_GROUP_KEY]: 'to group key',
	}[p.type];
	let handle;
	if (p.type === T.FROM_CALL || p.type === T.TO_CALL)
		handle = el('span.call', p.handle);
	else if (p.type === T.TO_KEY || p.type === T.TO_GROUP_KEY)
		handle = el('span.key', short(p.handle));
	else
		handle = text(p.handle, 'name');
	return el('span.chip', `${what} `, handle);
}

function position(n) {
	const lat = fixed(n.lat, 1e7, 7), lon = fixed(n.lon, 1e7, 7);
	const geo = `geo:${lat},${lon}${n.alt !== undefined ? `,${fixed(n.alt, 1000, 3)}` : ''}${n.acc ? `;u=${n.acc}` : ''}`;
	const a = el('a', `${lat}, ${lon}`);
	a.href = geo;
	return el('div.part', '📍 ', a,
		n.alt !== undefined ? `, ${fixed(n.alt, 1000, 1)} m` : '',
		n.acc ? ` ±${n.acc} m` : '',
		el('span.dim', ` fix ${when(n.time * 1000)}`));
}

// Animated WebP: a VP8X chunk first, with its animation flag set
export const animatedWebP = (b) => b.length > 20
	&& String.fromCharCode(...b.subarray(0, 4), ...b.subarray(8, 16)) === 'RIFFWEBPVP8X'
	&& (b[20] & 0x02) !== 0;

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
async function animated(blob, label) {
	const frame = await still(blob);
	frame.setAttribute('role', 'img');
	frame.setAttribute('aria-label', `${label}, animated`);
	const wrap = el('span.animated', frame);
	let img = null;
	const play = () => {
		if (img)
			return;
		img = el('img.picture');
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
function touchToPlay(box) {
	const all = (what) => {
		for (const a of box.querySelectorAll('.animated'))
			players.get(a)?.[what]();
	};
	box.addEventListener('pointerdown', (e) => e.pointerType === 'touch' && all('play'));
	for (const type of ['pointerup', 'pointercancel', 'pointerleave'])
		box.addEventListener(type, (e) => e.pointerType === 'touch' && all('stop'));
}

// a WebP from a stranger is only drawn when asked for
function picture(n, label) {
	const b = el('button.small', `show ${label}, ${bytes(n.body.length)}`);
	b.onclick = async () => {
		const blob = new Blob([n.body], { type: 'image/webp' });
		if (animatedWebP(n.body)) {
			try {
				b.replaceWith(await animated(blob, label));
			} catch {
				b.replaceWith(el('span.bad', `${label} can't be shown`));
			}
			return;
		}
		const img = el('img.picture');
		img.src = URL.createObjectURL(blob);
		img.alt = label;
		b.replaceWith(img);
	};
	return el('div.part', b, n.signer ? el('span.dim', ` for key ${short(n.signer)}`) : '');
}

function leaf(n) {
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
		return el('div.part', `🌬 from ${fixed(n.direction, 100, 2)}°, ${fixed(n.speed, 100, 2)} m/s`, n.gust !== undefined ? `, gusts ${fixed(n.gust, 100, 2)} m/s` : '');
	case T.VOLTAGE:
		return el('div.part', `🔋 ${fixed(n.value, 1000, 3)} V`);
	case T.MENTION:
		return el('div.part', '↗ ', el('span.key', short(n.id)));
	case T.WEBP:
		return picture(n, 'picture');
	case T.AVATAR:
		return picture(n, 'avatar');
	case T.CODEC2:
		return el('div.part', `🔊 Codec2 mode ${n.mode}, ${bytes(n.body.length - 1)}`);
	case T.MIME:
		return el('div.part', '📄 ', n.fileName || 'unnamed', el('span.dim', ` ${n.mime}, ${bytes(n.content.length)}`));
	case T.FRAGMENT:
		return el('div.part.dim', `Fragment ${n.index} of ${n.N}, ${n.K} needed, root ${short(n.root)}`, n.verified ? '' : ' (unchecked)');
	case T.REQUEST_POST:
		return el('div.part.dim', `asks for post ${short(n.id)}`);
	case T.REQUEST_ROOT:
		return el('div.part.dim', `asks for ${n.needed} more blocks of root ${short(n.root)}`);
	case T.REVOKE_RETIRED:
	case T.REVOKE_COMPROMISED:
		return el('div.part.warn', `revokes the key: ${n.reason}`, n.effective ? '' : ' (no effect here)');
	}
	return el('div.part.dim', `unknown record 0x${n.type.toString(16).padStart(2, '0')}, ${bytes(n.body?.length ?? 0)}`);
}

function post(n) {
	const head = el('div.post-head');
	if (n.type === T.TOPIC)
		head.append(el('strong', text(n.subject, 'subject')));
	else
		head.append('↩ reply to ', el('span.key', short(n.parent)));
	const e = el('div.post', head,
		el('div.dim', when(n.timestamp * 1000), n.id ? ` · ${short(n.id)}` : ''),
		...n.parts.map(leaf));
	return e;
}

const DROPPED = {
	signature: 'bad signature, dropped',
	'must-understand': 'needs a newer client, dropped',
	empty: 'empty post, dropped',
};

function signed(n) {
	const state = n.verified === true ? el('span.ok', '✓ signed') : n.verified === false ? el('span.bad', '✗ signed') : el('span.dim', '? signed (unchecked)');
	return el('div.box', el('div.box-head', state, ' by key ', el('span.key', short(n.key))), n.dropped ? null : nodes(n.children));
}

export function node(n) {
	let e;
	if (n.type === T.SIGNED)
		e = signed(n);
	else if (n.type === T.KEYED)
		e = el('div.box', el('div.box-head', el('span.dim', '🔑 keyed, tag '), el('span.key', short(n.tag))), nodes(n.children));
	else if (n.type === T.BUNDLE)
		e = el('div.box', el('div.box-head.dim', 'bundle'), nodes(n.children));
	else if (n.type === T.TOPIC || n.type === T.REPLY)
		e = post(n);
	else
		e = leaf(n);
	if (n.prefixes?.length)
		e.prepend(el('div.chips', ...n.prefixes.map(prefix)));
	if (n.dropped) {
		e.classList.add('dropped');
		e.prepend(el('div.bad', DROPPED[n.dropped] ?? n.dropped));
	}
	return e;
}

export const nodes = (list) => el('div.nodes', ...list.map(node));

// the head line of an entry or event: time, call sign and the rest
export function head(arrival, callSign, ...rest) {
	return el('div.entry-head', el('span.time', when(arrival)), ' ', el('span.call', callSign ?? '—'), ...rest);
}

// a station entry (station.js): a frame as received
export function entry(e) {
	const info = [];
	if (e.mode !== null && e.mode !== undefined)
		info.push(`mode ${e.mode}`);
	info.push(e.used !== undefined ? `${bytes(e.used)} of ${bytes(e.size)}` : bytes(e.size));
	if (e.snr)
		info.push(`SNR ${e.snr.median.toFixed(1)} dB`);
	if (e.bitFlips)
		info.push(`${e.bitFlips} bit flips`);
	const box = el('article.entry', head(e.arrival, e.callSign, el('span.dim', ` ${info.join(' · ')}`),
		e.error ? el('span.badge.bad', 'dropped') : e.tier ? el('span.badge', e.tier) : el('span.badge.dim', 'not kept')));
	if (e.error) {
		box.append(el('div.bad', `malformed: ${e.error}`));
	} else {
		if (!e.nodes.length)
			box.append(el('div.dim', 'empty frame'));
		box.append(nodes(e.nodes));
	}
	for (const f of e.fragments) {
		if (f.nodes)
			box.append(el('div.box', el('div.box-head.ok', `reassembled, ${bytes(f.used)}`), nodes(f.nodes)));
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
