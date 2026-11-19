// BLAKE2s as specified in RFC 7693, with keyed mode, output lengths
// from 1 to 32 bytes and streaming. No dependencies.

const IV = new Uint32Array([
	0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
	0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
]);

const SIGMA = new Uint8Array([
	0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
	14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
	11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
	7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
	9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
	2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
	12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
	13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
	6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
	10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
]);

export class BLAKE2s {
	// outlen: digest length in bytes (1..32), part of the parameter block,
	// so BLAKE2s-128 is not a truncated BLAKE2s-256.
	// key: optional Uint8Array of 0..32 bytes for keyed mode (a MAC).
	constructor(outlen = 32, key = new Uint8Array(0)) {
		if (!Number.isInteger(outlen) || outlen < 1 || outlen > 32)
			throw new RangeError('BLAKE2s output length must be 1..32 bytes');
		if (!(key instanceof Uint8Array) || key.length > 32)
			throw new RangeError('BLAKE2s key must be a Uint8Array of at most 32 bytes');
		this.outlen = outlen;
		this.h = new Uint32Array(IV);
		this.h[0] ^= 0x01010000 ^ (key.length << 8) ^ outlen;
		this.v = new Uint32Array(16);
		this.m = new Uint32Array(16);
		this.buf = new Uint8Array(64);
		this.len = 0; // bytes in buf
		this.t = 0; // bytes compressed so far
		this.done = false;
		if (key.length) {
			this.buf.set(key);
			this.len = 64; // the key block counts as a full block
		}
	}

	compress(last) {
		const v = this.v, m = this.m, h = this.h, b = this.buf;
		for (let i = 0; i < 16; ++i)
			m[i] = b[4 * i] | b[4 * i + 1] << 8 | b[4 * i + 2] << 16 | b[4 * i + 3] << 24;
		for (let i = 0; i < 8; ++i) {
			v[i] = h[i];
			v[i + 8] = IV[i];
		}
		v[12] ^= this.t >>> 0;
		v[13] ^= Math.floor(this.t / 0x100000000) >>> 0;
		if (last)
			v[14] = ~v[14];
		for (let r = 0; r < 10; ++r) {
			const s = r * 16;
			G(v, m, 0, 4, 8, 12, SIGMA[s + 0], SIGMA[s + 1]);
			G(v, m, 1, 5, 9, 13, SIGMA[s + 2], SIGMA[s + 3]);
			G(v, m, 2, 6, 10, 14, SIGMA[s + 4], SIGMA[s + 5]);
			G(v, m, 3, 7, 11, 15, SIGMA[s + 6], SIGMA[s + 7]);
			G(v, m, 0, 5, 10, 15, SIGMA[s + 8], SIGMA[s + 9]);
			G(v, m, 1, 6, 11, 12, SIGMA[s + 10], SIGMA[s + 11]);
			G(v, m, 2, 7, 8, 13, SIGMA[s + 12], SIGMA[s + 13]);
			G(v, m, 3, 4, 9, 14, SIGMA[s + 14], SIGMA[s + 15]);
		}
		for (let i = 0; i < 8; ++i)
			h[i] ^= v[i] ^ v[i + 8];
	}

	update(data) {
		if (this.done)
			throw new Error('BLAKE2s already finalized');
		let pos = 0;
		while (pos < data.length) {
			if (this.len === 64) {
				// only compress a full block once more data follows,
				// so the last block can be flagged in digest()
				this.t += 64;
				this.compress(false);
				this.len = 0;
			}
			const n = Math.min(64 - this.len, data.length - pos);
			this.buf.set(data.subarray(pos, pos + n), this.len);
			this.len += n;
			pos += n;
		}
		return this;
	}

	digest() {
		if (this.done)
			throw new Error('BLAKE2s already finalized');
		this.done = true;
		this.t += this.len;
		this.buf.fill(0, this.len);
		this.compress(true);
		const out = new Uint8Array(this.outlen);
		for (let i = 0; i < this.outlen; ++i)
			out[i] = this.h[i >> 2] >>> (8 * (i & 3));
		return out;
	}
}

function G(v, m, a, b, c, d, x, y) {
	let t;
	v[a] = v[a] + v[b] + m[x];
	t = v[d] ^ v[a]; v[d] = t >>> 16 | t << 16;
	v[c] = v[c] + v[d];
	t = v[b] ^ v[c]; v[b] = t >>> 12 | t << 20;
	v[a] = v[a] + v[b] + m[y];
	t = v[d] ^ v[a]; v[d] = t >>> 8 | t << 24;
	v[c] = v[c] + v[d];
	t = v[b] ^ v[c]; v[b] = t >>> 7 | t << 25;
}

// One-shot helper: blake2s(data), blake2s(data, 16, key)
export function blake2s(data, outlen = 32, key = new Uint8Array(0)) {
	return new BLAKE2s(outlen, key).update(data).digest();
}
