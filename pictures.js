// Pictures: what a file is, by its first bytes, never by the type a post
// claims for it. PNG, JPEG, GIF and WebP, with their size and whether they
// move, read from their headers without decoding them, so a picture too
// large to draw is known before anything is drawn.

import { webpSize } from './records.js';

// The largest picture drawn right away in a thread, each side
export const SHOWN_MAX = 1024;

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
const be16 = (b, p) => b[p] << 8 | b[p + 1];
const be32 = (b, p) => (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0;
const le16 = (b, p) => b[p] | b[p + 1] << 8;

// { type, width, height, animated } or null if b isn't one of the four or
// its size can't be read
export function pictureInfo(b) {
	if (!(b instanceof Uint8Array))
		return null;
	return png(b) ?? jpeg(b) ?? gif(b) ?? webp(b);
}

// a signature, then chunks: length (big-endian), type, data, CRC; IHDR
// first; an acTL chunk before the first IDAT makes it an APNG
function png(b) {
	if (b.length < 33 || be32(b, 0) !== 0x89504E47 || be32(b, 4) !== 0x0D0A1A0A || ascii(b, 12, 16) !== 'IHDR')
		return null;
	const width = be32(b, 16), height = be32(b, 20);
	if (!width || !height)
		return null;
	let animated = false;
	for (let p = 8; p + 8 <= b.length;) {
		const type = ascii(b, p + 4, p + 8);
		if (type === 'acTL')
			animated = true;
		if (type === 'IDAT' || type === 'IEND')
			break;
		p += 12 + be32(b, p);
	}
	return { type: 'image/png', width, height, animated };
}

// SOI, then segments; the frame header (SOF0 to SOF15, not DHT, JPG or
// DAC) has the height and width
function jpeg(b) {
	if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8)
		return null;
	for (let p = 2; p + 9 <= b.length;) {
		if (b[p] !== 0xFF)
			return null;
		const marker = b[p + 1];
		// fill bytes, and markers without a length
		if (marker === 0xFF) {
			++p;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
			p += 2;
			continue;
		}
		if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
			const height = be16(b, p + 5), width = be16(b, p + 7);
			return width && height ? { type: 'image/jpeg', width, height, animated: false } : null;
		}
		if (marker === 0xD9 || marker === 0xDA)
			return null;
		p += 2 + be16(b, p + 2);
	}
	return null;
}

// header, logical screen (width and height little-endian), the global
// colour table, then blocks: more than one image makes it animated
function gif(b) {
	if (b.length < 13 || !/^GIF8[79]a$/.test(ascii(b, 0, 6)))
		return null;
	const width = le16(b, 6), height = le16(b, 8);
	if (!width || !height)
		return null;
	const table = (flags) => flags & 0x80 ? 3 << ((flags & 7) + 1) : 0;
	// sub-blocks up to the empty one
	const skip = (p) => {
		while (p < b.length && b[p])
			p += b[p] + 1;
		return p + 1;
	};
	let images = 0;
	for (let p = 13 + table(b[10]); p < b.length && images < 2;) {
		if (b[p] === 0x21)
			p = skip(p + 2);
		else if (b[p] === 0x2C) {
			++images;
			p = skip(p + 10 + table(b[p + 9]) + 1);
		} else
			break;
	}
	return { type: 'image/gif', width, height, animated: images > 1 };
}

function webp(b) {
	const size = webpSize(b);
	if (!size)
		return null;
	const animated = b.length > 20 && ascii(b, 12, 16) === 'VP8X' && (b[20] & 0x02) !== 0;
	return { type: 'image/webp', ...size, animated };
}

// whether a picture is drawn right away in a thread
export const small = (info) => !!info && info.width <= SHOWN_MAX && info.height <= SHOWN_MAX;
