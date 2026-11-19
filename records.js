// Rattlechan v0 records: parser and encoder, as specified in SPEC.md.
// No dependencies besides blake2s.js. Signing and HYDRA stay outside:
// the parser takes an optional verify callback, the encoder takes
// signatures or a sign callback.

import { blake2s } from './blake2s.js';

// "Rattlechan-v0" followed by a zero byte
export const CONTEXT = Uint8Array.from('Rattlechan-v0\0', (c) => c.charCodeAt(0));

export const T = Object.freeze({
	END: 0x00,
	FROM_CALL: 0x01,
	FROM_NAME: 0x02,
	TO_KEY: 0x03,
	TO_CALL: 0x04,
	TO_NAME: 0x05,
	TO_GROUP_NAME: 0x06,
	TO_GROUP_KEY: 0x07,
	SIGNED: 0x20,
	KEYED: 0x21,
	BUNDLE: 0x22,
	TOPIC: 0x23,
	REPLY: 0x24,
	FRAGMENT: 0x25,
	REQUEST_POST: 0x26,
	REQUEST_ROOT: 0x27,
	REVOKE_RETIRED: 0x28,
	REVOKE_COMPROMISED: 0x29,
	MENTION: 0x30,
	POSITION: 0x31,
	TEMPERATURE: 0x32,
	HUMIDITY: 0x33,
	PRESSURE: 0x34,
	WIND: 0x35,
	VOLTAGE: 0x36,
	TEXT_UTF8: 0x40,
	TEXT_GB18030: 0x41,
	TEXT_TABLE: 0x42,
	TEXT_SCSU: 0x43,
	CODEC2: 0x50,
	WEBP: 0x51,
	AVATAR: 0x52,
	MIME: 0xEF,
});

const NAMES = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

// CRYPTO signs at most 2^23 bytes: CONTEXT and the records of a Signed record
export const SIGNED_MAX = (1 << 23) - CONTEXT.length;

// Text-Table index byte, new entries are only ever appended
export const TEXT_TABLE = Object.freeze([
	'IBM866', 'ISO-8859-2', 'ISO-8859-3', 'ISO-8859-4',
	'ISO-8859-5', 'ISO-8859-6', 'ISO-8859-7', 'ISO-8859-8',
	'ISO-8859-10', 'ISO-8859-13', 'ISO-8859-14', 'ISO-8859-15',
	'ISO-8859-16', 'KOI8-R', 'KOI8-U', 'macintosh',
	'windows-874', 'windows-1250', 'windows-1251', 'windows-1252',
	'windows-1253', 'windows-1254', 'windows-1255', 'windows-1256',
	'windows-1257', 'windows-1258', 'x-mac-cyrillic', 'Big5',
	'EUC-JP', 'Shift_JIS', 'EUC-KR', 'UTF-16LE',
]);

// Type classes follow from the number alone
export const isPrefix = (t) => t >= 0x01 && t <= 0x1F;
export const isCore = (t) => t >= 0x20 && t <= 0x2F;
export const isOptional = (t) => t >= 0x30 && t <= 0xEF;
export const isMustUnderstand = (t) => t >= 0xF0 && t <= 0xFE;
export const isText = (t) => t >= 0x40 && t <= 0x4F;
export const isSensor = (t) => t >= T.TEMPERATURE && t <= T.VOLTAGE;
const isKnown = (t) => t in NAMES || isText(t);

// Malformed data drops the whole frame
export class MalformedError extends Error {
	constructor(message, offset) {
		super(offset === undefined ? message : `${message} at offset ${offset}`);
		this.name = 'MalformedError';
		this.offset = offset;
	}
}

// ---------------------------------------------------------------- bytes

export function concat(...chunks) {
	let n = 0;
	for (const c of chunks)
		n += c.length;
	const out = new Uint8Array(n);
	let pos = 0;
	for (const c of chunks) {
		out.set(c, pos);
		pos += c.length;
	}
	return out;
}

const u16 = (b, p) => b[p] | b[p + 1] << 8;
const i16 = (b, p) => u16(b, p) << 16 >> 16;
const u32 = (b, p) => (b[p] | b[p + 1] << 8 | b[p + 2] << 16 | b[p + 3] << 24) >>> 0;
const i32 = (b, p) => b[p] | b[p + 1] << 8 | b[p + 2] << 16 | b[p + 3] << 24;

function intBytes(n, size, min, max, what) {
	if (!Number.isInteger(n) || n < min || n > max)
		throw new RangeError(`${what} must be an integer in ${min}..${max}`);
	const out = new Uint8Array(size);
	for (let i = 0; i < size; ++i)
		out[i] = n / 2 ** (8 * i) & 255;
	return out;
}
const le16 = (n, what = 'value') => intBytes(n, 2, 0, 0xFFFF, what);
const le32 = (n, what = 'value') => intBytes(n, 4, 0, 0xFFFFFFFF, what);
function sintBytes(n, size, what) {
	const half = 2 ** (8 * size - 1);
	if (!Number.isInteger(n) || n < -half || n >= half)
		throw new RangeError(`${what} must be an integer in ${-half}..${half - 1}`);
	return intBytes(n < 0 ? n + 2 * half : n, size, 0, 2 * half - 1, what);
}
const sle16 = (n, what = 'value') => sintBytes(n, 2, what);
const sle32 = (n, what = 'value') => sintBytes(n, 4, what);

// Uint8Array or a plain array of bytes
function bytesOf(x, size, what) {
	if (Array.isArray(x) && x.every((b) => Number.isInteger(b) && b >= 0 && b < 256))
		x = Uint8Array.from(x);
	if (!(x instanceof Uint8Array) || (size !== undefined && x.length !== size))
		throw new RangeError(`${what} must be a Uint8Array${size === undefined ? '' : ` of ${size} bytes`}`);
	return x;
}

// ---------------------------------------------------------- call signs

// ROBUSTO base-40: 0 = space, 1 = unused, 2 = '-', 3 = '/', 4..13 = digits, 14..39 = A..Z
const ALPHABET = ' \u0000-/0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_CALL = 40 ** 9;

export function encodeCall(call) {
	if (typeof call !== 'string' || call.length < 1 || call.length > 9)
		throw new RangeError('call sign must be 1..9 characters');
	const s = call.toUpperCase();
	if (s[0] === ' ')
		throw new RangeError('call sign cannot start with a space');
	let v = 0;
	for (const c of s) {
		const d = ALPHABET.indexOf(c);
		if (d < 0 || d === 1)
			throw new RangeError(`invalid call sign character ${JSON.stringify(c)}`);
		v = v * 40 + d;
	}
	return intBytes(v, 6, 0, MAX_CALL - 1, 'call sign');
}

export function decodeCall(bytes, offset) {
	let v = 0;
	for (let i = 5; i >= 0; --i)
		v = v * 256 + bytes[i];
	if (v === 0)
		throw new MalformedError('empty call sign', offset);
	if (v >= MAX_CALL)
		throw new MalformedError('call sign value out of range', offset);
	let s = '';
	for (; v > 0; v = Math.floor(v / 40)) {
		const d = v % 40;
		if (d === 1)
			throw new MalformedError('call sign digit 1', offset);
		s = ALPHABET[d] + s;
	}
	return s;
}

// ------------------------------------------------------------ hashing

// Post ID: signed (signer key given) or unsigned (Keyed)
export function postId(postRecord, signerKey = null) {
	if (signerKey)
		return blake2s(concat(CONTEXT, [0x01], bytesOf(signerKey, 32, 'signer key'), postRecord));
	return blake2s(concat(CONTEXT, [0x00], postRecord));
}

// BLAKE2s-128 in keyed mode, output length 16 set in the parameter block
export function keyedTag(secret, records) {
	bytesOf(secret, 32, 'Keyed secret');
	return blake2s(concat(CONTEXT, [0x02], records), 16, secret);
}

// What a Signed record's signature covers
export const signingMessage = (records) => concat(CONTEXT, records);

export function verifyKeyed(node, secret) {
	const tag = keyedTag(secret, node.inner);
	let diff = 0;
	for (let i = 0; i < 16; ++i)
		diff |= tag[i] ^ node.tag[i];
	return diff === 0;
}

// ---------------------------------------------------------------- text

// Decode a text record to a string, or null if the encoding isn't supported
// here (SCSU needs its WebAssembly module, 0x44..0x4F are reserved).
export function decodeText(node) {
	try {
		switch (node.type) {
		case T.TEXT_UTF8:
			return new TextDecoder('utf-8').decode(node.body);
		case T.TEXT_GB18030:
			return new TextDecoder('gb18030').decode(node.body);
		case T.TEXT_TABLE: {
			const name = TEXT_TABLE[node.body[0]];
			return name === undefined ? null : new TextDecoder(name).decode(node.body.subarray(1));
		}
		}
	} catch {}
	return null;
}

// ------------------------------------------------------------- parsing

function readLength(buf, pos, end) {
	if (pos >= end)
		throw new MalformedError('missing length', pos);
	const b = buf[pos];
	if (b < 255)
		return [b, pos + 1];
	// long form: length = 255 + u24, so it can't encode anything below 255
	if (end - pos < 4)
		throw new MalformedError('truncated long length', pos);
	return [255 + (buf[pos + 1] | buf[pos + 2] << 8 | buf[pos + 3] << 16), pos + 4];
}

// Any record with a length; returns a node without type-specific fields
function readRecord(buf, pos, end) {
	const type = buf[pos];
	const [len, start] = readLength(buf, pos + 1, end);
	if (len > end - start)
		throw new MalformedError('length runs past its container', pos);
	return {
		type,
		name: NAMES[type] ?? (isText(type) ? 'TEXT' : null),
		offset: pos,
		end: start + len,
		raw: buf.subarray(pos, start + len),
		body: buf.subarray(start, start + len),
	};
}

const strictUTF8 = new TextDecoder('utf-8', { fatal: true });

// Fixed-size core records carry no length byte. Their size follows from
// the type, for Request-Root from its header.
const FIXED = new Set([T.REQUEST_POST, T.REQUEST_ROOT, T.REVOKE_RETIRED, T.REVOKE_COMPROMISED]);

function readFixed(buf, pos, end) {
	const type = buf[pos];
	let size = 0;
	if (type === T.REQUEST_POST)
		size = 32;
	else if (type === T.REQUEST_ROOT)
		size = end - pos < 3 ? 2 : 2 + (buf[pos + 2] & 0x80 ? 32 : 16);
	if (size > end - pos - 1)
		throw new MalformedError(`${NAMES[type]} runs past its container`, pos);
	const stop = pos + 1 + size;
	return {
		type,
		name: NAMES[type],
		offset: pos,
		end: stop,
		raw: buf.subarray(pos, stop),
		body: buf.subarray(pos + 1, stop),
	};
}

function checkTextRecord(node) {
	if (node.type === T.TEXT_UTF8) {
		try {
			strictUTF8.decode(node.body);
		} catch {
			throw new MalformedError('invalid UTF-8', node.offset);
		}
	}
	if (node.type === T.TEXT_TABLE) {
		if (node.body.length < 1)
			throw new MalformedError('Text-Table without index byte', node.offset);
		node.table = node.body[0];
	}
}

function parsePrefix(buf, pos, end) {
	const type = buf[pos];
	const node = { type, name: NAMES[type] ?? null, offset: pos };
	let next;
	switch (type) {
	case T.FROM_CALL:
	case T.TO_CALL:
		next = pos + 7;
		if (next > end)
			throw new MalformedError('truncated call sign', pos);
		node.handle = decodeCall(buf.subarray(pos + 1, next), pos);
		break;
	case T.TO_KEY:
	case T.TO_GROUP_KEY:
		next = pos + 33;
		if (next > end)
			throw new MalformedError('truncated key', pos);
		node.handle = buf.subarray(pos + 1, next);
		break;
	case T.FROM_NAME:
	case T.TO_NAME:
	case T.TO_GROUP_NAME: {
		if (pos + 1 >= end || !isText(buf[pos + 1]))
			throw new MalformedError('name handle is not a text record', pos);
		const text = readRecord(buf, pos + 1, end);
		checkTextRecord(text);
		node.handle = text;
		next = text.end;
		break;
	}
	default:
		throw new MalformedError(`unknown prefix type 0x${hex2(type)}`, pos);
	}
	node.end = next;
	node.raw = buf.subarray(pos, next);
	return node;
}

const hex2 = (b) => b.toString(16).padStart(2, '0').toUpperCase();

// Value checks shared by bare records and post parts
function checkValue(node) {
	const b = node.body, n = b.length, at = node.offset;
	const bad = (what) => { throw new MalformedError(what, at); };
	switch (node.type) {
	case T.MENTION:
		if (n !== 32)
			bad('Mention must be 32 bytes');
		node.id = b;
		break;
	case T.POSITION:
		if (n !== 12 && n !== 16 && n !== 18)
			bad('Position must be 12, 16 or 18 bytes');
		node.lat = i32(b, 0);
		node.lon = i32(b, 4);
		if (node.lat < -900000000 || node.lat > 900000000)
			bad('latitude out of range');
		if (node.lon < -1800000000 || node.lon > 1800000000)
			bad('longitude out of range');
		node.time = u32(b, 8);
		if (n >= 16)
			node.alt = i32(b, 12);
		if (n === 18)
			node.acc = u16(b, 16);
		break;
	case T.TEMPERATURE:
		if (n !== 2)
			bad('Temperature must be 2 bytes');
		node.value = i16(b, 0);
		break;
	case T.HUMIDITY:
		if (n !== 2)
			bad('Humidity must be 2 bytes');
		node.value = u16(b, 0);
		if (node.value > 10000)
			bad('Humidity above 100 %');
		break;
	case T.PRESSURE:
		if (n !== 4)
			bad('Pressure must be 4 bytes');
		node.value = u32(b, 0);
		break;
	case T.WIND:
		if (n !== 4 && n !== 6)
			bad('Wind must be 4 or 6 bytes');
		node.direction = u16(b, 0);
		node.speed = u16(b, 2);
		if (node.direction > 35999)
			bad('wind direction out of range');
		if (n === 6)
			node.gust = u16(b, 4);
		break;
	case T.VOLTAGE:
		if (n !== 2)
			bad('Voltage must be 2 bytes');
		node.value = u16(b, 0);
		break;
	case T.CODEC2:
		if (n < 1)
			bad('Codec2 without mode byte');
		node.mode = b[0];
		break;
	case T.MIME:
		checkMime(node);
		break;
	default:
		if (isText(node.type))
			checkTextRecord(node);
	}
}

const MIME_HALF = /^[a-z0-9!#$&\-^_.+]{1,127}$/;
const FILE_NAME = /^[a-z0-9._-]{0,64}$/;

function checkMime(node) {
	const b = node.body;
	const t = b.indexOf(0);
	if (t < 0)
		throw new MalformedError('MIME type not zero-terminated', node.offset);
	const f = b.indexOf(0, t + 1);
	if (f < 0)
		throw new MalformedError('MIME file name not zero-terminated', node.offset);
	const latin = (s) => String.fromCharCode(...s);
	const type = latin(b.subarray(0, t)), name = latin(b.subarray(t + 1, f));
	const halves = type.split('/');
	if (halves.length !== 2 || !halves.every((h) => MIME_HALF.test(h)))
		throw new MalformedError('invalid MIME type', node.offset);
	if (!FILE_NAME.test(name) || name.startsWith('.') || name.includes('..'))
		throw new MalformedError('invalid MIME file name', node.offset);
	node.mime = type;
	node.fileName = name;
	node.content = b.subarray(f + 1);
}

function parsePost(buf, node, ctx) {
	const isTopic = node.type === T.TOPIC;
	let pos = node.offset + node.raw.length - node.body.length;
	const end = node.end;
	if (end - pos < 4)
		throw new MalformedError('post without timestamp', node.offset);
	node.timestamp = u32(buf, pos);
	pos += 4;
	if (isTopic) {
		if (pos >= end || !isText(buf[pos]))
			throw new MalformedError('Topic without subject', node.offset);
		node.subject = readRecord(buf, pos, end);
		checkTextRecord(node.subject);
		pos = node.subject.end;
	} else {
		if (end - pos < 32)
			throw new MalformedError('Reply without parent', node.offset);
		node.parent = buf.subarray(pos, pos + 32);
		pos += 32;
	}
	node.parts = [];
	node.text = null;
	node.mentions = [];
	const seen = new Set(), mentioned = new Set();
	let mustDrop = false;
	while (pos < end) {
		const type = buf[pos];
		if (type === T.END)
			throw new MalformedError('end of payload inside a post', pos);
		if (isPrefix(type))
			throw new MalformedError('prefix inside a post', pos);
		if (type === 0xFF)
			throw new MalformedError('reserved type 0xFF', pos);
		if (isCore(type))
			throw new MalformedError(`core record 0x${hex2(type)} inside a post`, pos);
		const part = readRecord(buf, pos, end);
		pos = part.end;
		node.parts.push(part);
		if (isMustUnderstand(type)) {
			part.unknown = true;
			mustDrop = true;
			continue;
		}
		if (!isKnown(type)) {
			part.unknown = true;
			continue;
		}
		checkValue(part);
		if (isText(type)) {
			if (node.text)
				throw new MalformedError('more than one text part', part.offset);
			node.text = part;
		} else if (type === T.MENTION) {
			const key = part.raw.join();
			if (mentioned.has(key))
				throw new MalformedError('same post mentioned twice', part.offset);
			mentioned.add(key);
			node.mentions.push(part.id);
		} else if (type === T.POSITION || isSensor(type)) {
			if (seen.has(type))
				throw new MalformedError(`more than one ${part.name}`, part.offset);
			seen.add(type);
			if (type === T.POSITION)
				node.position = part;
		}
	}
	if (mustDrop)
		node.dropped = 'must-understand';
	else if (!node.parts.length)
		node.dropped = 'empty';
	node.signer = ctx.signer;
	if (ctx.signer)
		node.id = postId(node.raw, ctx.signer);
	else if (ctx.scope === 'keyed')
		node.id = postId(node.raw);
	else
		node.id = null;
}

function parseHeadedContainer(buf, node, ctx, head, scope, signer) {
	if (node.body.length < head)
		throw new MalformedError(`${node.name} too short`, node.offset);
	if (ctx.depth >= ctx.opts.maxDepth)
		throw new MalformedError('records nested too deep', node.offset);
	node.inner = node.body.subarray(head);
	const start = node.end - node.inner.length;
	return parseRecords(buf, start, node.end, {
		...ctx, scope, signer, chain: [], depth: ctx.depth + 1, direct: node.type, top: false,
	});
}

function parseRecord(buf, node, ctx) {
	const type = node.type, n = node.body.length;
	const bad = (what) => { throw new MalformedError(what, node.offset); };

	// prefixes go in front of Topic, Bundle and bare (optional) records only
	if (node.chain.length && !(type === T.TOPIC || type === T.BUNDLE || isOptional(type) || isMustUnderstand(type)))
		bad(type === T.REPLY ? 'prefix applies to a Reply' : `prefix applies to ${node.name}`);
	// Keyed holds Replies only, besides unknown records
	if (ctx.scope === 'keyed' && type !== T.REPLY && isKnown(type))
		bad(`${node.name} inside Keyed`);

	switch (type) {
	case T.SIGNED: {
		if (n < 96)
			bad('Signed too short');
		if (n - 96 > SIGNED_MAX)
			bad('Signed too large for CRYPTO');
		node.key = node.body.subarray(0, 32);
		node.sig = node.body.subarray(32, 96);
		node.inner = node.body.subarray(96);
		if (ctx.opts.verify) {
			node.verified = !!ctx.opts.verify(node.key, node.sig, signingMessage(node.inner));
			if (!node.verified) {
				node.dropped = 'signature';
				return;
			}
		} else {
			node.verified = null;
		}
		const r = parseHeadedContainer(buf, node, ctx, 96, 'signed', node.key);
		node.children = r.nodes;
		if (r.mustDrop)
			node.dropped = 'must-understand';
		return;
	}
	case T.KEYED: {
		if (ctx.scope === 'signed')
			bad('Keyed inside Signed');
		if (n < 16)
			bad('Keyed too short');
		node.tag = node.body.subarray(0, 16);
		const r = parseHeadedContainer(buf, node, ctx, 16, 'keyed', null);
		node.children = r.nodes;
		if (r.mustDrop)
			node.dropped = 'must-understand';
		return;
	}
	case T.BUNDLE: {
		if (ctx.depth >= ctx.opts.maxDepth)
			bad('records nested too deep');
		const r = parseRecords(buf, node.end - n, node.end, {
			...ctx, chain: node.chain, depth: ctx.depth + 1, direct: T.BUNDLE, top: false,
		});
		if (node.chain.length && !r.nodes.length)
			bad('prefix applies to an empty Bundle');
		node.children = r.nodes;
		if (r.mustDrop)
			node.dropped = 'must-understand';
		return;
	}
	case T.TOPIC:
	case T.REPLY:
		parsePost(buf, node, ctx);
		return;
	case T.FRAGMENT: {
		if (ctx.scope === 'signed')
			bad('Fragment inside Signed');
		if (n < 4)
			bad('Fragment too short');
		const h = u32(node.body, 0);
		if (h & 0x40000000)
			bad('Fragment reserved header bit set');
		node.hlen = h >>> 31 ? 32 : 16;
		node.height = (h >>> 26 & 15) + 1;
		node.K = (h >>> 16 & 1023) + 1;
		node.index = h & 0xFFFF;
		if (n < 4 + (node.height + 1) * node.hlen)
			bad('Fragment too short for its proof and root');
		node.block = node.body;
		return;
	}
	case T.REQUEST_POST:
		node.id = node.body;
		return;
	case T.REQUEST_ROOT: {
		const h = u16(node.body, 0);
		if (h & 0x7C00)
			bad('Request-Root reserved header bits set');
		node.needed = (h & 1023) + 1;
		node.hlen = h >>> 15 ? 32 : 16;
		node.root = node.body.subarray(2);
		return;
	}
	case T.REVOKE_RETIRED:
	case T.REVOKE_COMPROMISED:
		node.reason = type === T.REVOKE_COMPROMISED ? 'compromised' : 'retired';
		// only counts directly inside the Signed record of the key it revokes
		node.effective = ctx.direct === T.SIGNED;
		return;
	}
	if (isCore(type))
		bad(`unknown core type 0x${hex2(type)}`);
	if (isMustUnderstand(type)) {
		node.unknown = true;
		return;
	}
	if (!isKnown(type)) {
		node.unknown = true;
		return;
	}
	// a bare record: logged, only a signed Avatar has an effect
	checkValue(node);
	node.bare = true;
	if (type === T.AVATAR)
		node.signer = ctx.signer;
}

function parseRecords(buf, pos, end, ctx) {
	const nodes = [];
	let mustDrop = false;
	let pending = [];
	const chainMax = ctx.chain.length ? ctx.chain[ctx.chain.length - 1].type : 0;
	while (pos < end) {
		const type = buf[pos];
		if (type === T.END) {
			if (!ctx.top)
				throw new MalformedError('end of payload inside a record', pos);
			break;
		}
		if (type === 0xFF)
			throw new MalformedError('reserved type 0xFF', pos);
		if (isPrefix(type)) {
			if (ctx.scope === 'keyed')
				throw new MalformedError('prefix inside Keyed', pos);
			const p = parsePrefix(buf, pos, end);
			const last = pending.length ? pending[pending.length - 1].type : chainMax;
			if (type <= last)
				throw new MalformedError('prefix order violated', pos);
			pending.push(p);
			pos = p.end;
			continue;
		}
		const node = FIXED.has(type) ? readFixed(buf, pos, end) : readRecord(buf, pos, end);
		node.prefixes = pending;
		node.chain = pending.length ? ctx.chain.concat(pending) : ctx.chain;
		pending = [];
		parseRecord(buf, node, ctx);
		if (node.unknown && isMustUnderstand(node.type)) {
			// at the top level nothing encloses it, so the frame goes
			if (ctx.top)
				throw new MalformedError(`unknown must-understand type 0x${hex2(node.type)}`, node.offset);
			mustDrop = true;
		}
		nodes.push(node);
		pos = node.end;
	}
	if (pending.length)
		throw new MalformedError('prefix with no record after it', pos);
	return { nodes, mustDrop };
}

// Parse a payload into a tree of record nodes. Throws MalformedError when
// the frame has to be dropped. Narrower drops are marked on the node:
// dropped = 'signature' | 'must-understand' | 'empty'.
// Options:
//   verify(key, sig, message) -> boolean, CRYPTO's Ed25519 check; without
//     it Signed records are parsed and marked verified = null
//   maxDepth: limit on nesting of Signed, Keyed and Bundle (default 16)
export function parse(payload, opts = {}) {
	bytesOf(payload, undefined, 'payload');
	const o = { verify: null, maxDepth: 16, ...opts };
	return parseRecords(payload, 0, payload.length, {
		scope: 'plain', signer: null, chain: [], depth: 0, direct: null, top: true, opts: o,
	}).nodes;
}

// Depth-first walk over all nodes, with the path of enclosing nodes
export function* walk(nodes, path = []) {
	for (const node of nodes) {
		yield [node, path];
		if (node.children)
			yield* walk(node.children, [...path, node]);
	}
}

// ------------------------------------------------------------ encoding

export function encodeLength(n) {
	if (!Number.isInteger(n) || n < 0 || n > 255 + 0xFFFFFF)
		throw new RangeError('record length out of range');
	if (n < 255)
		return Uint8Array.of(n);
	const m = n - 255;
	return Uint8Array.of(0xFF, m & 255, m >> 8 & 255, m >> 16 & 255);
}

// A record with a length; chunks are Uint8Arrays or arrays of bytes
export function record(type, ...chunks) {
	if (!Number.isInteger(type) || type < 0x20 || type > 0xFE)
		throw new RangeError('records with a length have types 0x20..0xFE');
	const body = concat(...chunks);
	return concat([type], encodeLength(body.length), body);
}

// Records, then zero padding up to size if given
export function payload(records, size) {
	const out = concat(...records);
	if (size === undefined)
		return out;
	if (out.length > size)
		throw new RangeError(`payload of ${out.length} bytes does not fit ${size}`);
	const padded = new Uint8Array(size);
	padded.set(out);
	return padded;
}

// Text records
const utf8 = new TextEncoder();
export const textUTF8 = (s) => record(T.TEXT_UTF8, utf8.encode(s));
export const textGB18030 = (bytes) => record(T.TEXT_GB18030, bytesOf(bytes, undefined, 'text'));
export const textSCSU = (bytes) => record(T.TEXT_SCSU, bytesOf(bytes, undefined, 'text'));
export function textTable(index, bytes) {
	return record(T.TEXT_TABLE, intBytes(index, 1, 0, 255, 'table index'), bytesOf(bytes, undefined, 'text'));
}

function textHandle(type, text) {
	const rec = typeof text === 'string' ? textUTF8(text) : bytesOf(text, undefined, 'name');
	if (!isText(rec[0]))
		throw new RangeError('a name handle must be a text record');
	return concat([type], rec);
}

// Prefixes; names take a string (UTF-8) or a text record
export const fromCall = (call) => concat([T.FROM_CALL], encodeCall(call));
export const fromName = (text) => textHandle(T.FROM_NAME, text);
export const toKey = (key) => concat([T.TO_KEY], bytesOf(key, 32, 'key'));
export const toCall = (call) => concat([T.TO_CALL], encodeCall(call));
export const toName = (text) => textHandle(T.TO_NAME, text);
export const toGroupName = (text) => textHandle(T.TO_GROUP_NAME, text);
export const toGroupKey = (key) => concat([T.TO_GROUP_KEY], bytesOf(key, 32, 'key'));

// Core records
export function signed(key, sig, ...records) {
	return record(T.SIGNED, bytesOf(key, 32, 'key'), bytesOf(sig, 64, 'signature'), ...records);
}

// sign(message) -> 64-byte signature, e.g. CRYPTO's Ed25519 with BLAKE2b
export function signWith(sign, key, ...records) {
	const inner = concat(...records);
	return signed(key, sign(signingMessage(inner)), inner);
}

export function keyed(secret, ...records) {
	const inner = concat(...records);
	return record(T.KEYED, keyedTag(secret, inner), inner);
}

export const bundle = (...records) => record(T.BUNDLE, ...records);

export function topic(timestamp, subject, ...parts) {
	const s = typeof subject === 'string' ? textUTF8(subject) : bytesOf(subject, undefined, 'subject');
	if (!isText(s[0]))
		throw new RangeError('a Topic subject must be a text record');
	return record(T.TOPIC, le32(timestamp, 'timestamp'), s, ...parts);
}

export function reply(timestamp, parent, ...parts) {
	return record(T.REPLY, le32(timestamp, 'timestamp'), bytesOf(parent, 32, 'parent post ID'), ...parts);
}

export const fragment = (block) => record(T.FRAGMENT, bytesOf(block, undefined, 'HYDRA block'));
export const requestPost = (id) => concat([T.REQUEST_POST], bytesOf(id, 32, 'post ID'));

// needed: blocks still needed (1..1024); root: 16 or 32 bytes
export function requestRoot(needed, root) {
	bytesOf(root, undefined, 'root');
	if (root.length !== 16 && root.length !== 32)
		throw new RangeError('HYDRA root must be 16 or 32 bytes');
	if (!Number.isInteger(needed) || needed < 1 || needed > 1024)
		throw new RangeError('blocks needed must be 1..1024');
	return concat([T.REQUEST_ROOT], le16((needed - 1) | (root.length === 32 ? 0x8000 : 0)), root);
}

export function revoke(reason) {
	const type = { retired: T.REVOKE_RETIRED, compromised: T.REVOKE_COMPROMISED }[reason];
	if (type === undefined)
		throw new RangeError('revoke reason must be "retired" or "compromised"');
	return Uint8Array.of(type);
}

// Optional records
export const mention = (id) => record(T.MENTION, bytesOf(id, 32, 'post ID'));

// lat, lon in 1e-7 degrees; time of the fix in Unix seconds (UTC);
// alt in mm above mean sea level; acc in m, 0 = unknown
export function position({ lat, lon, time, alt, acc }) {
	const chunks = [sle32(lat, 'latitude'), sle32(lon, 'longitude'), le32(time, 'fix time')];
	if (Math.abs(lat) > 900000000 || Math.abs(lon) > 1800000000)
		throw new RangeError('latitude or longitude out of range');
	if (acc !== undefined && alt === undefined)
		throw new RangeError('accuracy needs an altitude');
	if (alt !== undefined)
		chunks.push(sle32(alt, 'altitude'));
	if (acc !== undefined)
		chunks.push(le16(acc, 'accuracy'));
	return record(T.POSITION, ...chunks);
}

export const temperature = (centiCelsius) => record(T.TEMPERATURE, sle16(centiCelsius, 'temperature'));
export const humidity = (centiPercent) => record(T.HUMIDITY, intBytes(centiPercent, 2, 0, 10000, 'humidity'));
export const pressure = (pascal) => record(T.PRESSURE, le32(pascal, 'pressure'));
export const voltage = (millivolt) => record(T.VOLTAGE, le16(millivolt, 'voltage'));

// direction in 0.01 degrees from true north, speeds in 0.01 m/s
export function wind({ direction, speed, gust }) {
	const chunks = [intBytes(direction, 2, 0, 35999, 'wind direction'), le16(speed, 'wind speed')];
	if (gust !== undefined)
		chunks.push(le16(gust, 'gust speed'));
	return record(T.WIND, ...chunks);
}

export const codec2 = (mode, frames) => record(T.CODEC2, intBytes(mode, 1, 0, 255, 'Codec2 mode'), bytesOf(frames, undefined, 'frames'));
export const webp = (bytes) => record(T.WEBP, bytesOf(bytes, undefined, 'WebP'));
export const avatar = (bytes) => record(T.AVATAR, bytesOf(bytes, undefined, 'WebP'));

export function mime(type, name, content) {
	const halves = type.split('/');
	if (halves.length !== 2 || !halves.every((h) => MIME_HALF.test(h)))
		throw new RangeError('invalid MIME type');
	if (!FILE_NAME.test(name) || name.startsWith('.') || name.includes('..'))
		throw new RangeError('invalid MIME file name');
	return record(T.MIME, utf8.encode(type), [0], utf8.encode(name), [0], bytesOf(content, undefined, 'content'));
}
