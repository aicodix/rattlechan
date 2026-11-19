// Glue for the CRYPTO WebAssembly module (crypto.wasm, copied as it is from
// https://github.com/xdsopl/crypto): Ed25519 with BLAKE2b in place of
// SHA-512. Not compatible with RFC 8032 libraries.

import { revoke, signed, signingMessage, concat } from './records.js';
import { instantiate } from './wasm.js';

export const MESSAGE_MAX = 1 << 23;

// source as for instantiate() in wasm.js. Without one, crypto.wasm is
// fetched from next to this file, as a browser or PWA does.
export async function loadCrypto(source = new URL('./crypto.wasm', import.meta.url)) {
	return wrap(await instantiate(source));
}

function wrap(wasm) {
	// the memory never grows, so these views stay valid
	const buffer = wasm.memory.buffer;
	const privateKey = new Uint8Array(buffer, wasm.private_key.value, 32);
	const fingerprintBuf = new Uint8Array(buffer, wasm.fingerprint.value, 32);
	const signatureBuf = new Uint8Array(buffer, wasm.signature.value, 64);
	const messageBuf = new Uint8Array(buffer, wasm.message.value, MESSAGE_MAX);

	const bytes = (x, size, what) => {
		if (!(x instanceof Uint8Array) || (size !== undefined && x.length !== size))
			throw new RangeError(`${what} must be a Uint8Array${size === undefined ? '' : ` of ${size} bytes`}`);
		return x;
	};

	// run fn with the private key loaded, and never leave it in the module
	const withKey = (key, fn) => {
		privateKey.set(bytes(key, 32, 'private key'));
		try {
			return fn();
		} finally {
			privateKey.fill(0);
		}
	};

	// 32 random bytes; CRYPTO has no random number generator
	const newPrivateKey = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

	// public key, the identity of its owner
	const fingerprint = (key) => withKey(key, () => {
		wasm.create_fingerprint();
		return fingerprintBuf.slice();
	});

	// 64-byte signature over message, deterministic
	const sign = (key, message) => {
		bytes(message, undefined, 'message');
		if (message.length < 1 || message.length > MESSAGE_MAX)
			throw new RangeError(`message must be 1..${MESSAGE_MAX} bytes`);
		return withKey(key, () => {
			messageBuf.set(message);
			if (wasm.create_signature(message.length))
				throw new Error('create_signature failed');
			return signatureBuf.slice();
		});
	};

	// the verify callback for records.parse(); false for anything not valid
	const verify = (key, sig, message) => {
		if (!(key instanceof Uint8Array) || key.length !== 32)
			return false;
		if (!(sig instanceof Uint8Array) || sig.length !== 64)
			return false;
		if (!(message instanceof Uint8Array) || message.length < 1 || message.length > MESSAGE_MAX)
			return false;
		fingerprintBuf.set(key);
		signatureBuf.set(sig);
		messageBuf.set(message);
		return wasm.verify_signature(message.length) === 0;
	};

	// the sign(message) function records.signWith() takes
	const signer = (key) => {
		const copy = bytes(key, 32, 'private key').slice();
		return (message) => sign(copy, message);
	};

	// a Signed record holding records, signed with key
	const signRecords = (key, ...records) => {
		const inner = concat(...records);
		return signed(fingerprint(key), sign(key, signingMessage(inner)), inner);
	};

	// both revocations of a key, 99 bytes each, made when the key is created
	const revocations = (key) => ({
		retired: signRecords(key, revoke('retired')),
		compromised: signRecords(key, revoke('compromised')),
	});

	return { newPrivateKey, fingerprint, sign, verify, signer, signRecords, revocations };
}
