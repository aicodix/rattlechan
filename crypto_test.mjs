// Tests for crypto.js. Run with: node crypto_test.mjs
// Known answers are those of the CRYPTO test page (docs/index.html there).

import { readFile } from 'node:fs/promises';
import { loadCrypto, MESSAGE_MAX } from './crypto.js';
import * as R from './records.js';

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16));
const text = (s) => new TextEncoder().encode(s);
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

const wasmBytes = await readFile(new URL('./crypto.wasm', import.meta.url));
const C = await loadCrypto(wasmBytes);

// ------------------------------------------------------ known answers

const range1000 = Uint8Array.from({ length: 1000 }, (_, i) => i & 255);
const messages = { abc: text('abc'), hello: text('Hello World!'), range1000 };
const keys = [
	['0000000000000000000000000000000000000000000000000000000000000000',
		'19d3d919475deed4696b5d13018151d1af88b2bd3bcff048b45031c1f36d1858', {
			abc: '3a74cf6919898b514adc439b90d4fcc5f1627aa1e7c929efa6a982da932dcce9625fddc18f846ba06c02b4e0bf9f6108bb089c33b129db2bffff7c3ea3295001',
			hello: 'c628c72ade519a5fa3e6fbfdc07c55b2c6e1d7c0f73280fa1e430bb134f48a7a3f24c6f142b47130390813fbcc229ddcfa06041a79395a220e84266071382604',
			range1000: 'd172e2e7b88784313c0e7d0eb579da05951290ce7d0de2c7ae76086ec725f42c1641b7341fec6a37164a3328e29c762f7580fdc0eb3a061a3a97fc51df058209',
		}],
	['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
		'2bc0c96667f2bba066f4b50d860bdd51c4a413b20e3d9ef28c3515a8dc4d1dfc', {
			abc: 'dfa0ebfb3914e5ee4a297f7d001d1176111309cb6132b2a0399aa5114e29996f9cfc36b5fa5b5d53c754f25e910132839ee043b353d2b641d565ed0e487bf106',
			hello: '14f23da3be76500231a24b69d9b9e7cb9bc4ea661b7d303cd2a2764287bab0f73c6c08ec1c8a4f70dc782d92f0d15f2ef0ef6d93733b843739072b8366cb5707',
			range1000: '3c3e8ab99b56ea0ee52c74ab28a807d0092bfe86ab39f0628dc32829f83c989bee3f969686ba8c2151a2b5d232952ce7da84ca21d5ec059ac98768b1e39c4406',
		}],
	['000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
		'f65333fa6303b6a23defd7de2af8aa461cb047ccbf12d4edd29ef3b1eba6706b', {
			abc: 'f22299476253907d3c66224eb8a939676533e5c59d41ffdca043b4ed82c2e317c51e0237699f8c0b2d03078d0776220e34e33bca471afc467c0414d769856c0f',
			hello: 'd9c340931fe94f0a2e2842b34ee1ad4ec5fdffa416dadcc87cdddc4b4d53f8744af19c9f0e2b037d9642d3d24f6c551a1641986d311182d254ecf870c202900f',
			range1000: '73fa92ec3dc818cae84f757a378c4c806ec911acc1cc1bdfaa01df899f1115f12417e102f426ed4b5eda04b02cb20674e02d76013d5f9d7ecf97337af7f08b01',
		}],
	['9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
		'78e65bf30f893d32fc57ef051c341bdede242544fc2a2112f0fa2c7afdebc02f', {
			abc: '51353216c72a99e0144fbad4e8ee193693a3649be21393ffd07776b26a3a60593b005013cde0aacce5fcb895e13af55675bf481e5de27a45bf6f4051d6bb5405',
			hello: '7b7e8b5e5cae1e1943adf313fc3f654e054e1abfbf44aa78c454bcb4dde3ccf0b59f4aa0e1ecb88980c881d6a5140efd513c2ad3208f25f80bf40b37673efd03',
			range1000: '267de83cb371c4dc0bff47276eb0f3bd77f1c8e4b60923981d4f1af05501fc831f1221a83d7e8b62d4a482f6b063d140dbfa4419d0bc7571289ab3165586a903',
		}],
];

for (const [key, pub, sigs] of keys) {
	const k = unhex(key);
	check(`fingerprint of ${key.slice(0, 8)}`, hex(C.fingerprint(k)), pub);
	for (const [name, sig] of Object.entries(sigs)) {
		const what = `${key.slice(0, 8)} ${name}`;
		check(`sign ${what}`, hex(C.sign(k, messages[name])), sig);
		check(`verify ${what}`, C.verify(unhex(pub), unhex(sig), messages[name]), true);
		const flipped = unhex(sig);
		flipped[5] ^= 1;
		check(`verify ${what} with a flipped signature bit`, C.verify(unhex(pub), flipped, messages[name]), false);
		const other = messages[name].slice();
		other[0] ^= 0x80;
		check(`verify ${what} with a flipped message bit`, C.verify(unhex(pub), unhex(sig), other), false);
	}
}

// --------------------------------------------------------- the edges

{
	const k = C.newPrivateKey();
	check('new private key is 32 bytes', k.length, 32);
	check('new private keys differ', hex(k) === hex(C.newPrivateKey()), false);
	const pub = C.fingerprint(k), msg = text('Rattlechan');
	const sig = C.sign(k, msg);
	check('signing is deterministic', hex(C.sign(k, msg)), hex(sig));
	check('random key round trip', C.verify(pub, sig, msg), true);
	check('wrong key', C.verify(C.fingerprint(C.newPrivateKey()), sig, msg), false);
	check('empty message never verifies', C.verify(pub, sig, new Uint8Array(0)), false);
	check('too long a message never verifies', C.verify(pub, sig, new Uint8Array(MESSAGE_MAX + 1)), false);
	check('short signature never verifies', C.verify(pub, sig.subarray(0, 63), msg), false);
	check('short key never verifies', C.verify(pub.subarray(0, 31), sig, msg), false);
	check('a string is not a message', C.verify(pub, sig, 'Rattlechan'), false);
	throws('sign an empty message', () => C.sign(k, new Uint8Array(0)));
	throws('sign too long a message', () => C.sign(k, new Uint8Array(MESSAGE_MAX + 1)));
	throws('private key of 31 bytes', () => C.fingerprint(k.subarray(0, 31)));
	const longest = new Uint8Array(MESSAGE_MAX).fill(7);
	check('longest message', C.verify(pub, C.sign(k, longest), longest), true);
	// S + L is the same scalar, CRYPTO must reject it
	const L = unhex('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010');
	const big = sig.slice();
	let carry = 0;
	for (let i = 0; i < 32; ++i) {
		const s = big[32 + i] + L[i] + carry;
		big[32 + i] = s & 255;
		carry = s >> 8;
	}
	check('non-canonical S is rejected', C.verify(pub, big, msg), false);
	check('small-order key is rejected', C.verify(new Uint8Array(32), sig, msg), false);
}

// ------------------------------------------- loading in other ways

{
	const fromModule = await loadCrypto(new WebAssembly.Module(wasmBytes));
	const fromBuffer = await loadCrypto(wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.length));
	const fromResponse = await loadCrypto(new Response(wasmBytes, { headers: { 'Content-Type': 'application/wasm' } }));
	const wrongType = await loadCrypto(new Response(wasmBytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
	const k = unhex(keys[0][0]);
	for (const [name, c] of Object.entries({ fromModule, fromBuffer, fromResponse, wrongType }))
		check(`load ${name}`, hex(c.fingerprint(k)), keys[0][1]);
	let failedLoad = false;
	try {
		await loadCrypto(new Response('not found', { status: 404 }));
	} catch {
		failedLoad = true;
	}
	check('a 404 does not load', failedLoad, true);
}

// ----------------------------------------------- with records.js

{
	const alice = C.newPrivateKey(), bob = C.newPrivateKey();
	const alicePub = C.fingerprint(alice);
	const post = R.topic(1763380000, 'Signed for real', R.textUTF8('Hello'));
	const frame = R.payload([R.signWith(C.signer(alice), alicePub, R.fromCall('DL1ABC'), post)], 256);
	let p = R.parse(frame, { verify: C.verify });
	check('signWith with signer verifies', p[0].verified, true);
	check('signed post ID', hex(p[0].children[0].id), hex(R.postId(post, alicePub)));
	check('signRecords is the same Signed record', hex(C.signRecords(alice, R.fromCall('DL1ABC'), post)), hex(R.payload([R.signWith(C.signer(alice), alicePub, R.fromCall('DL1ABC'), post)])));

	const forged = frame.slice();
	forged[2 + 96 + 3] ^= 1; // a byte of the call sign inside
	p = R.parse(forged, { verify: C.verify });
	check('changed content fails', p[0].dropped, 'signature');

	const endorsed = R.payload([C.signRecords(bob, C.signRecords(alice, post))]);
	p = R.parse(endorsed, { verify: C.verify });
	check('group endorsement verifies both', p[0].verified + ',' + p[0].children[0].verified, 'true,true');
	check('endorsed post ID uses the author', hex(p[0].children[0].children[0].id), hex(R.postId(post, alicePub)));

	const signedByBob = R.signed(alicePub, C.sign(bob, R.signingMessage(post)), post);
	check('signature by another key fails', R.parse(signedByBob, { verify: C.verify })[0].dropped, 'signature');
	const noContext = R.signed(alicePub, C.sign(alice, post), post);
	check('signature without CONTEXT fails', R.parse(noContext, { verify: C.verify })[0].dropped, 'signature');

	const { retired, compromised } = C.revocations(alice);
	check('revocation is 99 bytes', retired.length + ',' + compromised.length, '99,99');
	p = R.parse(R.payload([retired, compromised]), { verify: C.verify });
	check('retired revocation', [p[0].verified, p[0].children[0].reason, p[0].children[0].effective, hex(p[0].key)].join(), ['true', 'retired', 'true', hex(alicePub)].join());
	check('compromised revocation', [p[1].verified, p[1].children[0].reason, p[1].children[0].effective].join(), 'true,compromised,true');

	const largest = R.payload([C.signRecords(alice, R.record(0x37, new Uint8Array(R.SIGNED_MAX - 5)))]);
	check('largest Signed record verifies', R.parse(largest, { verify: C.verify })[0].verified, true);
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
