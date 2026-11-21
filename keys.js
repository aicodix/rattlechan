// The station's own signing keys, in secrets/keys.json. Each key has a
// label for the user, the From-Call and From-Name its posts carry, and
// both of its revocations, signed when the key arrives (SPEC.md, Client
// policy: printed so others can send them when the key falls silent or is
// lost). Private keys never leave secrets/: exports put them only in the
// secrets archive.

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));

const CALL = /^[A-Z0-9/-]{1,9}$/;

function checkFields({ label, callSign, name }) {
	if (label !== undefined && (typeof label !== 'string' || !label.trim()))
		throw new RangeError('a key needs a label');
	if (callSign !== undefined && callSign !== null && callSign !== '' && !CALL.test(callSign))
		throw new RangeError('a call sign is up to 9 of A-Z, 0-9, - and /');
	if (name !== undefined && name !== null && typeof name !== 'string')
		throw new RangeError('a name is text');
}

// The key ring of a store, with crypto from loadCrypto(). Keys are plain
// objects: { key (fingerprint hex), label, callSign, name, created,
// revocations: { retired, compromised } (hex) }; the private key stays
// inside, reachable only through signer().
export async function openKeys(store, crypto) {
	const load = async () => (await store.getSecret('keys'))?.keys ?? [];
	const save = (keys) => store.putSecret('keys', { keys });
	const visible = (k) => ({ key: k.key, label: k.label, callSign: k.callSign, name: k.name, created: k.created, revocations: { ...k.revocations } });

	const add = async (priv, { label, callSign = null, name = null, created = Date.now() }) => {
		checkFields({ label, callSign, name });
		const keys = await load();
		const key = hex(crypto.fingerprint(priv));
		if (keys.some((k) => k.key === key))
			throw new RangeError('this key is already there');
		const r = crypto.revocations(priv);
		const entry = {
			key, label: label.trim(), callSign: callSign || null, name: name || null, created,
			private: hex(priv),
			revocations: { retired: hex(r.retired), compromised: hex(r.compromised) },
		};
		keys.push(entry);
		await save(keys);
		return visible(entry);
	};

	return {
		// the keys, oldest first, without their private halves
		list: async () => (await load()).map(visible),

		// a new key from the browser's random numbers
		create: (fields) => add(crypto.newPrivateKey(), fields),

		// a private key given as 64 hex characters
		import: (privHex, fields) => {
			const h = String(privHex).trim().toLowerCase().replace(/\s+/g, '');
			if (!/^[0-9a-f]{64}$/.test(h))
				throw new RangeError('a private key is 64 hex characters');
			return add(fromHex(h), fields);
		},

		// change label, call sign or name
		update: async (key, fields) => {
			checkFields(fields);
			const keys = await load();
			const k = keys.find((x) => x.key === key);
			if (!k)
				throw new RangeError('no such key');
			if (fields.label !== undefined)
				k.label = fields.label.trim();
			if (fields.callSign !== undefined)
				k.callSign = fields.callSign || null;
			if (fields.name !== undefined)
				k.name = fields.name || null;
			await save(keys);
			return visible(k);
		},

		remove: async (key) => {
			const keys = await load();
			await save(keys.filter((k) => k.key !== key));
			return keys.length !== (await load()).length;
		},

		// A function that signs records (Uint8Arrays) into one Signed record
		// with the key, for sender.compose()
		signer: async (key) => {
			const k = (await load()).find((x) => x.key === key);
			if (!k)
				throw new RangeError('no such key');
			const priv = fromHex(k.private);
			return (...records) => crypto.signRecords(priv, ...records);
		},
	};
}
