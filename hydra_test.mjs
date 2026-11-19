// Tests for hydra.js. Run with: node hydra_test.mjs
// Planning is checked against the table in HYDRA's README.

import { readFile } from 'node:fs/promises';
import { loadHydra, Reassembler, blockHeader, PAYLOAD_MAX } from './hydra.js';
import * as R from './records.js';

const { T } = R;
const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

function throws(name, fn) {
	++checks;
	try {
		fn();
		++failed;
		console.log('FAIL', name, 'did not throw');
	} catch {}
}

// deterministic xorshift, so failures can be repeated
let seed = 0x12345678;
const random = () => {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	return (seed >>> 0) / 2 ** 32;
};
const randomBytes = (n) => Uint8Array.from({ length: n }, () => random() * 256 | 0);
const pick = (n, k) => {
	const all = [...Array(n).keys()];
	for (let i = 0; i < k; ++i) {
		const j = i + (random() * (n - i) | 0);
		[all[i], all[j]] = [all[j], all[i]];
	}
	return all.slice(0, k);
};

const H = await loadHydra(await readFile(new URL('./hydra.wasm', import.meta.url)));

// ----------------------------------------------------------- planning

// [payload length, budget, hash length, K, N] from HYDRA's README
for (const [len, budget, hlen, K, N] of [
	[50, 128, 16, 2, 32],
	[13884, 256, 16, 512, 8192],
	[112, 256, 32, 2, 32],
	[273788, 512, 16, 1024, 16384],
	[29756, 512, 32, 512, 8192],
	[797564, 1024, 16, 1024, 16384],
	[8138364, 8192, 16, 1024, 16384],
	[7892348, 8192, 32, 1024, 16384],
]) {
	const p = H.plan(len, budget, hlen);
	check(`plan ${len} bytes in ${budget} with ${hlen}-byte hashes`, p && `${p.K} ${p.N}`, `${K} ${N}`);
	check(`plan ${len} bytes in ${budget}: blocks fit the budget`, p && p.blen <= budget, true);
}
check('plan for a payload too big for any height', H.plan(8201853, 8192), null);
check('plan for a tiny payload', H.plan(1, 128).K, 1);
throws('plan an empty payload', () => H.plan(0, 128));
throws('plan with 20-byte hashes', () => H.plan(10, 128, 20));

// ---------------------------------------------- encoding and decoding

const post = R.topic(1763380000, 'A long one', R.textUTF8('x'.repeat(3000)));
const frame = R.payload([R.signed(new Uint8Array(32), new Uint8Array(64), post)]);
{
	const enc = H.encode(frame, { budget: 200 });
	check('encoder blocks fit the budget', enc.blen <= 200, true);
	check('encoder N', enc.N, 2 ** enc.height);
	const block = enc.block(3);
	check('block length', block.length, enc.blen);
	const head = blockHeader(block);
	check('block header', [head.K, head.height, head.index, head.hlen].join(), [enc.K, enc.height, 3, 16].join());
	check('block verifies', H.verifyBlock(block), true);
	check('fragment record holds the block', hex(R.parse(enc.fragment(3))[0].block), hex(block));

	const all = Array.from({ length: enc.N }, (_, i) => enc.block(i));
	check('encoding is deterministic', hex(H.encode(frame, { budget: 200 }).block(3)), hex(block));
	for (let round = 0; round < 5; ++round) {
		const some = pick(enc.N, enc.K).map((i) => all[i]);
		const out = H.decode(some);
		check(`decode ${enc.K} random blocks, round ${round}`, out && hex(out.subarray(0, frame.length)), hex(frame));
		check(`decoded padding is zero, round ${round}`, out && out.subarray(frame.length).every((b) => b === 0), true);
		const p = R.parse(out, { reassembled: true });
		check(`decoded payload parses, round ${round}`, R.decodeText(p[0].children[0].text).length, 3000);
	}
	check('decode too few blocks', H.decode(all.slice(0, enc.K - 1)), null);
	check('decode a repeated index', H.decode([all[0], ...all.slice(0, enc.K - 1)]), null);
	const other = H.encode(randomBytes(frame.length), { budget: 200 });
	const foreign = other.block(1);
	check('fresh encoder works', H.verifyBlock(other.block(0)), true);
	check('decode with a block of another root', H.decode([foreign, ...all.slice(2, enc.K + 1)]), null);
	const flipped = all[5].slice();
	flipped[10] ^= 4;
	check('flipped bit fails verification', H.verifyBlock(flipped), false);
	check('decode with a flipped bit', H.decode(all.slice(0, enc.K - 1).concat([flipped])), null);
	throws('encoder is stale after another encode', () => enc.block(0));
	throws('decoding makes encoders stale too', () => other.block(0));

	// a relay rebuilds the same blocks
	const out = H.decode(pick(enc.N, enc.K).map((i) => all[i]));
	check('relay decodes', out !== null, true);
	const relay = H.regenerate();
	check('regenerate gives an encoder', relay !== null, true);
	check('relay blocks equal the sender\'s', relay && [0, 7, enc.N - 1].every((i) => hex(relay.block(i)) === hex(all[i])), true);
	check('regenerate twice', H.regenerate(), null);
	H.encode(frame, { budget: 200 });
	check('regenerate without decode', H.regenerate(), null);
}

{
	const tiny = H.encode(R.textUTF8('Hungry'), { budget: 100 });
	check('tiny payload needs one block', tiny.K, 1);
	const out = H.decode([tiny.block(1)]);
	check('one block of N gives it back', R.decodeText(R.parse(out, { reassembled: true })[0]), 'Hungry');
	const big = H.encode(frame, { budget: 600, hlen: 32, height: 9 });
	check('chosen height and hash length', [big.height, big.hlen, blockHeader(big.block(0)).hlen].join(), '9,32,32');
	throws('payload too big for the budget', () => H.encode(new Uint8Array(20000), { budget: 64 }));
	throws('payload too big for HYDRA', () => H.encode(new Uint8Array(PAYLOAD_MAX + 1)));
	throws('empty payload', () => H.encode(new Uint8Array(0)));
	throws('block index N', () => tiny.block(tiny.N));
	check('verify a block longer than HYDRA allows', H.verifyBlock(new Uint8Array(8193)), false);
	check('verify nothing', H.verifyBlock(new Uint8Array(0)), false);
}

// ----------------------------------------------- Fragments in frames

{
	const enc = H.encode(frame, { budget: 300 });
	const f = enc.fragment(0);
	let p = R.parse(R.payload([f, R.textUTF8('rides along')]), { verifyBlock: H.verifyBlock });
	check('Fragment verified in a frame', p[0].verified, true);
	check('Fragment shares the frame', R.decodeText(p[1]), 'rides along');
	const bad = f.slice();
	bad[f.length - 1] ^= 1; // a root byte
	throws('Fragment failing HYDRA drops the frame', () => R.parse(R.payload([bad, R.textUTF8('a')]), { verifyBlock: H.verifyBlock }));
	const nested = H.encode(R.payload([f]), { budget: 400 });
	const out = H.decode(Array.from({ length: nested.K }, (_, i) => nested.block(i)));
	throws('Fragment inside a reassembled payload', () => R.parse(out, { reassembled: true }));
}

// -------------------------------------------------------- reassembly

{
	const a = R.payload([R.topic(1, 'first', R.textUTF8('a'.repeat(2000)))]);
	const b = R.payload([R.topic(2, 'second', R.textUTF8('b'.repeat(1500)))]);
	const encA = H.encode(a, { budget: 160 });
	const blocksA = Array.from({ length: encA.N }, (_, i) => encA.block(i));
	const encB = H.encode(b, { budget: 160 });
	const blocksB = Array.from({ length: encB.N }, (_, i) => encB.block(i));
	check('two messages with different K', encA.K === encB.K, false);

	// a lossy channel: random blocks of both, some twice, some damaged
	const R2 = new Reassembler(H);
	const traffic = [];
	for (const i of pick(encA.N, encA.K + 3))
		traffic.push(blocksA[i]);
	for (const i of pick(encB.N, encB.K + 3))
		traffic.push(blocksB[i]);
	traffic.push(blocksA[0], blocksB[0]);
	const damaged = blocksA[1].slice();
	damaged[7] ^= 0x10;
	traffic.push(damaged);
	for (let i = traffic.length - 1; i > 0; --i) {
		const j = random() * (i + 1) | 0;
		[traffic[i], traffic[j]] = [traffic[j], traffic[i]];
	}
	const got = {};
	let invalid = 0, after = 0;
	for (const block of traffic) {
		const r = R2.add(block);
		if (!r)
			++invalid;
		else if (r.done)
			++after;
		else if (r.payload)
			got[R.decodeText(R.parse(r.payload, { reassembled: true })[0].subject)] = true;
	}
	check('damaged block is refused', invalid, 1);
	check('both messages decoded', Object.keys(got).sort().join(), 'first,second');
	check('blocks after decoding are recognised', after > 0, true);
	check('nothing left waiting', R2.missing().length, 0);

	// waiting sets ask for what they miss
	const R3 = new Reassembler(H);
	for (const i of [0, 1, 2])
		R3.add(blocksA[i]);
	const status = R3.add(blocksA[3]);
	check('waiting status', [status.have, status.K].join(), [4, encA.K].join());
	const [m] = R3.missing();
	check('missing blocks', m.needed, encA.K - 4);
	const req = R.parse(R.payload(R3.requests()));
	check('Request-Root for the rest', [req[0].type, req[0].needed, req[0].hlen, hex(req[0].root)].join(),
		[T.REQUEST_ROOT, encA.K - 4, 16, hex(blockHeader(blocksA[0]).root)].join());
	R3.forget(m.key);
	check('forgotten set is gone', R3.missing().length, 0);
}

// ------------------------------------------------------------- limits

{
	// K <= 1024 caps payloads below PAYLOAD_MAX: 8201852 bytes at most, with N = 1024
	check('PAYLOAD_MAX itself does not fit', H.plan(PAYLOAD_MAX, 8192), null);
	const p = H.plan(8201852, 8192);
	check('largest payload HYDRA holds', p && [p.K, p.N].join(), '1024,1024');
	const enc = H.encode(randomBytes(8201852), { budget: 8192 });
	check('largest payload encodes', enc.K, 1024);
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
