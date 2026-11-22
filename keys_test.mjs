// Tests for keys.js. Run with: node keys_test.mjs
// Keys in a store in memory: creating, importing, editing, removing,
// signing, and the revocations made with each key.

import { readFile } from 'node:fs/promises';
import { openKeys } from './keys.js';
import { memoryBackend, openStore } from './storage.js';
import { exportArchive, importArchive } from './archive.js';
import { loadCrypto } from './crypto.js';
import * as R from './records.js';

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

async function rejects(name, fn) {
	++checks;
	try {
		await fn();
		++failed;
		console.log('FAIL', name, 'did not throw');
	} catch {}
}

const C = await loadCrypto(await readFile(new URL('./crypto.wasm', import.meta.url)));
const store = await openStore(memoryBackend());
const K = await openKeys(store, C);

check('no keys yet', (await K.list()).length, 0);
const anna = await K.create({ label: 'Personal', callSign: 'DL1ABC', name: 'Anna' });
check('created: fingerprint', anna.key.length, 64);
check('created: label', anna.label, 'Personal');
check('created: call sign', anna.callSign, 'DL1ABC');
check('created: no private key shown', 'private' in anna, false);
check('stored in secrets', (await store.getSecret('keys')).keys[0].key, anna.key);
check('not in data', await store.getData('keys'), null);

// both revocations: 99 bytes, signed by the key, effective
for (const reason of ['retired', 'compromised']) {
	const bytes = fromHex(anna.revocations[reason]);
	check(`${reason}: 99 bytes`, bytes.length, 99);
	const p = R.parse(bytes, { verify: C.verify });
	check(`${reason}: signed by the key`, hex(p[0].key), anna.key);
	check(`${reason}: verifies`, p[0].verified, true);
	check(`${reason}: effective`, p[0].children[0].effective && p[0].children[0].reason, reason);
	check(`${reason}: the store takes it`, typeof await store.addRevocation(bytes), 'string');
}

// a club key, imported as hex, without a name
const clubPriv = '5a'.repeat(32);
const club = await K.import(` ${clubPriv.toUpperCase().slice(0, 30)} ${clubPriv.slice(30)}\n`, { label: 'Club', callSign: 'DL0XYZ' });
check('imported: fingerprint as CRYPTO computes it', club.key, hex(C.fingerprint(fromHex(clubPriv))));
check('imported: no name', club.name, null);
check('two keys, oldest first', (await K.list()).map((k) => k.label).join(), 'Personal,Club');
await rejects('importing it again', () => K.import(clubPriv, { label: 'Again' }));
await rejects('too short', () => K.import('ab'.repeat(31), { label: 'x' }));
await rejects('not hex', () => K.import('zz'.repeat(32), { label: 'x' }));
await rejects('without label', () => K.create({ label: ' ' }));
await rejects('bad call sign', () => K.create({ label: 'x', callSign: 'dl1abc' }));

// editing
const edited = await K.update(club.key, { label: 'Club station', name: 'Funkclub' });
check('edited label', edited.label, 'Club station');
check('edited name', edited.name, 'Funkclub');
check('call sign kept', edited.callSign, 'DL0XYZ');
check('cleared call sign', (await K.update(club.key, { callSign: '' })).callSign, null);
await rejects('editing an unknown key', () => K.update('00'.repeat(32), { label: 'x' }));

// signing: posts verify under the right key, From prefixes inside
const sign = await K.signer(anna.key);
const signed = R.payload([sign(R.fromCall('DL1ABC'), R.topic(1763700000, 'Hi', R.textUTF8('signed')))]);
const p = R.parse(signed, { verify: C.verify });
check('signed: verifies', p[0].verified, true);
check('signed: by the key', hex(p[0].key), anna.key);
check('signed: From-Call inside', p[0].children[0].prefixes[0].handle, 'DL1ABC');
check('signed: post ID', p[0].children[0].id !== null, true);
await rejects('signing with an unknown key', () => K.signer('00'.repeat(32)));

// keys travel in the secrets archive only
const data = await exportArchive(store.backend);
const secrets = await exportArchive(store.backend, { secrets: true });
const other = await openStore(memoryBackend());
await importArchive(other.backend, data);
check('data archive: no keys', await other.getSecret('keys'), null);
await importArchive(other.backend, secrets);
const K2 = await openKeys(other, C);
check('secrets archive: both keys', (await K2.list()).length, 2);
const sign2 = await K2.signer(anna.key);
check('secrets archive: same signatures', hex(sign2(R.textUTF8('x'))), hex(sign(R.textUTF8('x'))));

// avatars: WebP only, kept as given, exported with the key
const webp = new Uint8Array(await readFile(new URL('./examples/avatar.webp', import.meta.url)));
check('no avatar yet', (await K.list())[0].avatar, null);
await K.update(anna.key, { avatar: webp });
check('avatar kept', hex((await K.list())[0].avatar), hex(webp));
check('label unchanged', (await K.list())[0].label, 'Personal');
await rejects('a PNG as avatar', () => K.update(anna.key, { avatar: Uint8Array.of(1, 2, 3) }));
await rejects('a 192x120 picture as avatar', async () => K.update(anna.key, { avatar: new Uint8Array(await readFile(new URL('./examples/dusk.webp', import.meta.url))) }));
const withAvatar = await openStore(memoryBackend());
await importArchive(withAvatar.backend, await exportArchive(store.backend, { secrets: true }));
check('avatar in the secrets archive', hex((await (await openKeys(withAvatar, C)).list())[0].avatar), hex(webp));
await K.update(anna.key, { avatar: null });
check('avatar removed', (await K.list())[0].avatar, null);

// removing
check('removed', await K.remove(club.key), true);
check('one key left', (await K.list()).map((k) => k.label).join(), 'Personal');
check('removing again', await K.remove(club.key), false);

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
