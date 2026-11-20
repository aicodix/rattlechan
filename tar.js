// Tar archives (POSIX ustar) of regular files, written and read in memory.
// Enough for Rattlechan's exports: no links, devices or long names.

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

function field(h, offset, size, text) {
	const b = enc.encode(text);
	if (b.length > size)
		throw new RangeError(`tar field too long: ${text}`);
	h.set(b, offset);
}

const octal = (n, size) => n.toString(8).padStart(size - 1, '0') + '\0';

// files: [{ name, bytes, mtime (seconds, optional) }]; names use '/', at
// most 255 bytes, split into prefix and name as ustar does
export function writeTar(files) {
	const parts = [];
	for (const { name, bytes, mtime = 0 } of files) {
		const full = enc.encode(name);
		let prefix = '', base = name;
		if (full.length > 100) {
			const cut = name.lastIndexOf('/', 155);
			if (cut < 0 || enc.encode(name.slice(cut + 1)).length > 100)
				throw new RangeError(`tar name too long: ${name}`);
			prefix = name.slice(0, cut);
			base = name.slice(cut + 1);
		}
		const h = new Uint8Array(BLOCK);
		field(h, 0, 100, base);
		field(h, 100, 8, '0000644\0');
		field(h, 108, 8, '0000000\0');
		field(h, 116, 8, '0000000\0');
		field(h, 124, 12, octal(bytes.length, 12));
		field(h, 136, 12, octal(mtime, 12));
		h.fill(0x20, 148, 156);
		h[156] = 0x30; // regular file
		field(h, 257, 6, 'ustar\0');
		field(h, 263, 2, '00');
		field(h, 345, 155, prefix);
		let sum = 0;
		for (const b of h)
			sum += b;
		field(h, 148, 8, octal(sum, 7) + ' ');
		parts.push(h, bytes, new Uint8Array((BLOCK - bytes.length % BLOCK) % BLOCK));
	}
	parts.push(new Uint8Array(2 * BLOCK));
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (const p of parts) {
		out.set(p, pos);
		pos += p.length;
	}
	return out;
}

const text = (b) => {
	const z = b.indexOf(0);
	return dec.decode(z < 0 ? b : b.subarray(0, z));
};

// Regular files of a tar archive, [{ name, bytes, mtime }]. Directories are
// skipped; anything else, a bad checksum or a truncated archive throws.
export function readTar(tar) {
	const files = [];
	for (let pos = 0; pos + BLOCK <= tar.length;) {
		const h = tar.subarray(pos, pos + BLOCK);
		if (h.every((b) => b === 0))
			return files;
		let sum = 0;
		for (let i = 0; i < BLOCK; ++i)
			sum += i >= 148 && i < 156 ? 0x20 : h[i];
		if (parseInt(text(h.subarray(148, 156)).trim(), 8) !== sum)
			throw new Error('tar header checksum mismatch');
		const size = parseInt(text(h.subarray(124, 136)).trim() || '0', 8);
		const type = h[156];
		const prefix = text(h.subarray(345, 500));
		const name = (prefix ? prefix + '/' : '') + text(h.subarray(0, 100));
		pos += BLOCK;
		if (pos + size > tar.length)
			throw new Error('tar archive truncated');
		if (type === 0x30 || type === 0)
			files.push({ name, bytes: tar.slice(pos, pos + size), mtime: parseInt(text(h.subarray(136, 148)).trim() || '0', 8) });
		else if (type !== 0x35)
			throw new Error(`tar entry of type ${String.fromCharCode(type)} not supported: ${name}`);
		pos += Math.ceil(size / BLOCK) * BLOCK;
	}
	throw new Error('tar archive without end');
}
