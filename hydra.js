// Glue for the HYDRA WebAssembly module (hydra.wasm, copied as it is from
// https://github.com/xdsopl/hydra): erasure coding with Merkle proofs.
// A payload is split into K of N blocks, any K valid blocks give it back,
// and each block travels in a Fragment record.

import { fragment, requestRoot } from './records.js';
import { instantiate } from './wasm.js';

export const PAYLOAD_MAX = 1 << 23;
export const BLOCK_MAX = 8192;
export const K_MAX = 1024;
export const HEIGHT_MAX = 16;

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
const u32 = (b, p) => (b[p] | b[p + 1] << 8 | b[p + 2] << 16 | b[p + 3] << 24) >>> 0;

// What a block's header says, or null if it can't be a HYDRA block
export function blockHeader(block) {
	if (!(block instanceof Uint8Array) || block.length < 4)
		return null;
	const h = u32(block, 0);
	const hlen = h >>> 31 ? 32 : 16;
	const height = (h >>> 26 & 15) + 1;
	if (block.length < 4 + hlen * (height + 1))
		return null;
	return {
		hlen,
		height,
		N: 2 ** height,
		K: (h >>> 16 & 1023) + 1,
		index: h & 0xFFFF,
		params: h >>> 16,
		root: block.subarray(block.length - hlen),
	};
}

// The set a block belongs to, as the Reassembler and the station name it:
// its parameters (K, height, hash flag), its length and its root
export function setKey(block) {
	const head = blockHeader(block);
	return head && `${head.params.toString(16)}:${block.length}:${hex(head.root)}`;
}

// count distinct random block indices of N, none of them in skip (a Set),
// in the order drawn, at most as many as are left (SPEC.md, Fragments:
// random indices keep stations sending one set from repeating each other).
// N is a power of two, so every index is equally likely.
export function randomIndices(N, count, skip = new Set()) {
	const want = Math.max(0, Math.min(count, N - skip.size));
	const out = new Set();
	const r = new Uint32Array(1);
	while (out.size < want) {
		const i = globalThis.crypto.getRandomValues(r)[0] % N;
		if (!skip.has(i))
			out.add(i);
	}
	return [...out];
}

// source as for instantiate() in wasm.js. Without one, hydra.wasm is
// fetched from next to this file, as a browser or PWA does.
export async function loadHydra(source = new URL('./hydra.wasm', import.meta.url)) {
	return wrap(await instantiate(source));
}

function wrap(wasm) {
	// the memory never grows, so these views stay valid
	const buffer = wasm.memory.buffer;
	const messageBuf = new Uint8Array(buffer, wasm.message.value, PAYLOAD_MAX + BLOCK_MAX);
	const blockBuf = new Uint8Array(buffer, wasm.block.value, BLOCK_MAX);
	const blocksBuf = new Uint8Array(buffer, wasm.blocks.value, K_MAX * BLOCK_MAX);

	// the module holds one tree at a time: encoders only work until the
	// next encode, decode or regenerate
	let generation = 0;
	let decoded = null;

	const dflagOf = (hlen) => {
		if (hlen !== 16 && hlen !== 32)
			throw new RangeError('hash length must be 16 or 32');
		return hlen === 32 ? 1 : 0;
	};

	const checkLength = (len) => {
		if (!Number.isInteger(len) || len < 1 || len > PAYLOAD_MAX)
			throw new RangeError(`payload must be 1..${PAYLOAD_MAX} bytes`);
	};

	// K, height and block length for a payload of len bytes in blocks of at
	// most budget bytes, as HYDRA's README plans it: the lowest height with
	// the recommended N, else the one with the largest N / K. null if it
	// doesn't fit.
	const plan = (len, budget, hlen = 16) => {
		checkLength(len);
		const dflag = dflagOf(hlen);
		let best = null;
		for (let height = 1; height <= HEIGHT_MAX; ++height) {
			const K = wasm.needed_blocks(len, budget, height, dflag);
			if (K < 0)
				continue;
			if (wasm.useful_height(K) <= height) {
				best = { K, height };
				break;
			}
			if (!best || 2 ** height / K > 2 ** best.height / best.K)
				best = { K, height };
		}
		if (!best)
			return null;
		const blen = wasm.block_length(len, best.K, best.height, dflag);
		return { K: best.K, height: best.height, N: 2 ** best.height, hlen, blen };
	};

	const encoder = (K, height, hlen, blen) => {
		const mine = generation;
		const block = (index) => {
			if (mine !== generation)
				throw new Error('HYDRA has encoded or decoded something else since');
			if (!Number.isInteger(index) || index < 0 || index >= 2 ** height)
				throw new RangeError(`block index must be 0..${2 ** height - 1}`);
			const n = wasm.encode_block(index);
			if (n !== blen)
				throw new Error('encode_block failed');
			return blockBuf.slice(0, n);
		};
		return { K, height, N: 2 ** height, hlen, blen, block, fragment: (index) => fragment(block(index)) };
	};

	// Encode a payload: plan it for budget unless height is given, then
	// build the tree. Returns an encoder giving any of the N blocks.
	const encode = (payload, { budget = BLOCK_MAX, hlen = 16, height } = {}) => {
		if (!(payload instanceof Uint8Array))
			throw new RangeError('payload must be a Uint8Array');
		checkLength(payload.length);
		const dflag = dflagOf(hlen);
		let p;
		if (height === undefined) {
			p = plan(payload.length, budget, hlen);
		} else {
			const K = wasm.needed_blocks(payload.length, budget, height, dflag);
			p = K < 0 ? null : { K, height, blen: wasm.block_length(payload.length, K, height, dflag) };
		}
		if (!p)
			throw new RangeError(`a payload of ${payload.length} bytes does not fit blocks of ${budget} bytes`);
		++generation;
		decoded = null;
		messageBuf.set(payload);
		const K = wasm.encode_message(payload.length, p.blen, p.height, dflag);
		if (K !== p.K)
			throw new Error('encode_message failed');
		return encoder(K, p.height, hlen, p.blen);
	};

	// HYDRA's own check: header, padding and Merkle proof. Pass it to
	// records.parse() as verifyBlock.
	const verifyBlock = (block) => {
		if (!(block instanceof Uint8Array) || block.length < 4 || block.length > BLOCK_MAX)
			return false;
		blockBuf.set(block);
		return wasm.verify_block(block.length) === 0;
	};

	// Decode K blocks of one root into the payload, zero padding included,
	// or null if they don't decode. Parse the result with reassembled: true.
	const decode = (blocks) => {
		++generation;
		decoded = null;
		const head = blockHeader(blocks[0]);
		if (!head || blocks.length !== head.K || blocks[0].length > BLOCK_MAX)
			return null;
		const blen = blocks[0].length;
		for (let i = 0; i < blocks.length; ++i) {
			if (!(blocks[i] instanceof Uint8Array) || blocks[i].length !== blen)
				return null;
			blocksBuf.set(blocks[i], i * blen);
		}
		const len = wasm.decode_message(blen);
		if (len < 0)
			return null;
		decoded = { mine: generation, K: head.K, height: head.height, hlen: head.hlen, blen };
		return messageBuf.slice(0, len);
	};

	// For relays, right after decode: rebuild the tree from the decoded
	// payload. Returns an encoder for the same N blocks if the rebuilt root
	// matches, or null: then keep nothing and send nothing on.
	const regenerate = () => {
		if (!decoded || decoded.mine !== generation)
			return null;
		const { K, height, hlen, blen } = decoded;
		decoded = null;
		if (wasm.regenerate_tree() !== 0)
			return null;
		return encoder(K, height, hlen, blen);
	};

	return { plan, encode, verifyBlock, decode, regenerate };
}

// Collects blocks by root, header and length, and decodes once K distinct
// valid blocks of one set are there. Memory use is up to the caller:
// forget() sets that won't complete.
// An incomplete set waits at most a week (SPEC.md, Fragments): a block
// arriving later starts a new set, so blocks with colliding roots can't
// mix over a long time
export const SET_LIFETIME = 7 * 24 * 3600 * 1000;

export class Reassembler {
	constructor(hydra) {
		this.hydra = hydra;
		this.sets = new Map();
		this.done = new Set();
	}

	// Add one block (a Fragment's block) arriving at time (milliseconds).
	// Returns null for an invalid block, { key, done: true } for a set
	// decoded before, { key, have, K } while waiting, { key, payload } once
	// decoded (the module then holds it, so a relay can call
	// hydra.regenerate() next), or { key, failed: true } if K valid blocks
	// didn't decode. A waiting set first seen more than SET_LIFETIME before
	// is dropped, and the block starts a new one.
	add(block, time = Date.now()) {
		const head = blockHeader(block);
		if (!head || !this.hydra.verifyBlock(block))
			return null;
		const key = setKey(block);
		if (this.done.has(key))
			return { key, done: true };
		let set = this.sets.get(key);
		if (set && time - set.first > SET_LIFETIME)
			set = null;
		if (!set) {
			set = { K: head.K, root: head.root.slice(), blocks: new Map(), first: time };
			this.sets.set(key, set);
		}
		if (!set.blocks.has(head.index))
			set.blocks.set(head.index, block.slice());
		if (set.blocks.size < set.K)
			return { key, have: set.blocks.size, K: set.K };
		this.sets.delete(key);
		this.done.add(key);
		const payload = this.hydra.decode([...set.blocks.values()]);
		if (!payload)
			return { key, failed: true };
		return { key, payload };
	}

	// Blocks still needed for each set waiting at time; sets past their
	// week are dropped
	missing(time = Date.now()) {
		for (const [key, set] of this.sets)
			if (time - set.first > SET_LIFETIME)
				this.sets.delete(key);
		return [...this.sets].map(([key, set]) => ({ key, K: set.K, needed: set.K - set.blocks.size, root: set.root, first: set.first }));
	}

	// A Request-Root record for each set waiting at time
	requests(time = Date.now()) {
		return this.missing(time).map((m) => requestRoot(m.needed, m.root));
	}

	forget(key) {
		this.sets.delete(key);
		this.done.delete(key);
	}
}
