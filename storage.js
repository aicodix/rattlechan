// Station storage: frames as received, one file each, in two tiers bounded
// by bytes; revocations forever; JSON data and secrets. Files live in a
// backend: the Origin Private File System in browsers, or memory for tests
// and Node.js.
//
// Layout, all names checked by safeName():
//   precious/<kept>_<arrival>_<call sign>_<mode>.bin   frames worth keeping
//   logged/<kept>_<arrival>_<call sign>_<mode>.bin     everything else
//   revocations/<key hex>_<reason>_<arrival>.bin        a Signed(key, Revoke)
//   data/<name>.json                                    settings, trust lists
//   secrets/<name>.json                                 private keys, Keyed secrets
// Times are milliseconds since 1970, 13 digits. Each tier evicts the frame
// with the oldest kept time first; touch() renews it, the arrival time
// stays. The caller decides the tier (SPEC.md, Client policy): precious for
// frames with a post signed by a trusted key, the station's own frames and
// verified Keyed posts, logged for the rest; it moves frames with promote()
// and demote() when trust changes or fragments turn out precious.

export const TIERS = Object.freeze(['precious', 'logged']);
export const DIRS = Object.freeze([...TIERS, 'revocations', 'data', 'secrets']);
export const BUDGET_DEFAULT = 100 * 1024 * 1024;

// at most 100 characters, what a tar header holds for a name
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export const safeName = (name) => typeof name === 'string' && NAME.test(name) && !name.includes('..');

function checkPath(path) {
	const parts = path.split('/');
	if (parts.length !== 2 || !DIRS.includes(parts[0]) || !safeName(parts[1]))
		throw new RangeError(`not a storage path: ${path}`);
	return parts;
}

// ------------------------------------------------------------ backends

// A backend stores files in the four directories:
//   list(dir) -> [{ name, size }], read(path) -> Uint8Array or null,
//   write(path, bytes), remove(path)
export function memoryBackend() {
	const files = new Map();
	return {
		async list(dir) {
			const prefix = dir + '/';
			return [...files].filter(([p]) => p.startsWith(prefix)).map(([p, b]) => ({ name: p.slice(prefix.length), size: b.length }));
		},
		async read(path) {
			checkPath(path);
			const b = files.get(path);
			return b ? b.slice() : null;
		},
		async write(path, bytes) {
			checkPath(path);
			files.set(path, Uint8Array.from(bytes));
		},
		async remove(path) {
			checkPath(path);
			files.delete(path);
		},
	};
}

// The Origin Private File System, under a directory of its own. Asks the
// browser to keep the data even when space runs low.
export async function opfsBackend(root = 'rattlechan') {
	const top = await navigator.storage.getDirectory();
	const base = await top.getDirectoryHandle(root, { create: true });
	const dirs = {};
	for (const d of DIRS)
		dirs[d] = await base.getDirectoryHandle(d, { create: true });
	try {
		await navigator.storage.persist();
	} catch {}
	const file = async (path, create = false) => {
		const [d, name] = checkPath(path);
		try {
			return await dirs[d].getFileHandle(name, { create });
		} catch {
			return null;
		}
	};
	return {
		async list(dir) {
			const out = [];
			for await (const [name, handle] of dirs[dir].entries())
				if (handle.kind === 'file' && safeName(name))
					out.push({ name, size: (await handle.getFile()).size });
			return out;
		},
		async read(path) {
			const h = await file(path);
			return h ? new Uint8Array(await (await h.getFile()).arrayBuffer()) : null;
		},
		async write(path, bytes) {
			const h = await file(path, true);
			const w = await h.createWritable();
			await w.write(bytes);
			await w.close();
		},
		async remove(path) {
			const [d, name] = checkPath(path);
			try {
				await dirs[d].removeEntry(name);
			} catch {}
		},
	};
}

// --------------------------------------------------------------- names

const time = (ms) => {
	if (!Number.isInteger(ms) || ms < 0 || ms > 9999999999999)
		throw new RangeError('time must be milliseconds since 1970');
	return String(ms).padStart(13, '0');
};

// call signs use '-' and '/', which names can't hold: '/' becomes '.'
const callPart = (call) => call ? call.toUpperCase().replace(/\//g, '.') : 'NONE';
const callOf = (part) => part === 'NONE' ? null : part.replace(/\./g, '/');

function frameName(kept, arrival, callSign, mode) {
	if (callSign !== null && !/^[A-Za-z0-9/-]{1,9}$/.test(callSign))
		throw new RangeError('not a call sign');
	if (mode !== null && (!Number.isInteger(mode) || mode < 0 || mode > 255))
		throw new RangeError('mode must be 0..255');
	return `${time(kept)}_${time(arrival)}_${callPart(callSign)}_${mode === null ? 'NONE' : mode}.bin`;
}

export function parseFrameName(name) {
	const m = /^(\d{13})_(\d{13})_([A-Z0-9.-]{1,9}|NONE)_(\d{1,3}|NONE)\.bin$/.exec(name);
	if (!m)
		return null;
	return { name, kept: +m[1], arrival: +m[2], callSign: callOf(m[3]), mode: m[4] === 'NONE' ? null : +m[4] };
}

export function parseRevocationName(name) {
	const m = /^([0-9a-f]{64})_(retired|compromised)_(\d{13})\.bin$/.exec(name);
	return m && { name, key: m[1], reason: m[2], arrival: +m[3] };
}

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');

// --------------------------------------------------------------- store

// The station's store on a backend. now() gives the time in milliseconds,
// replaceable for tests.
export async function openStore(backend, { now = () => Date.now() } = {}) {
	// a frame's name keeps it apart from others arriving in the same millisecond
	let last = 0;
	const tick = () => {
		last = Math.max(now(), last + 1);
		return last;
	};

	const getJSON = async (dir, name) => {
		const b = await backend.read(`${dir}/${name}.json`);
		return b ? JSON.parse(new TextDecoder().decode(b)) : null;
	};
	const putJSON = (dir, name, value) =>
		backend.write(`${dir}/${name}.json`, new TextEncoder().encode(JSON.stringify(value, null, '\t') + '\n'));

	const settings = async () => {
		const stored = await getJSON('data', 'settings') ?? {};
		return { ...stored, budgets: { precious: BUDGET_DEFAULT, logged: BUDGET_DEFAULT, ...stored.budgets } };
	};

	const checkTier = (tier) => {
		if (!TIERS.includes(tier))
			throw new RangeError(`tier must be ${TIERS.join(' or ')}`);
		return tier;
	};

	// name -> frame with its tier, read from the backend once; this store
	// is its only writer
	let index = null;
	const loadIndex = async () => {
		if (!index) {
			index = new Map();
			for (const tier of TIERS)
				for (const { name, size } of await backend.list(tier)) {
					const f = parseFrameName(name);
					if (f)
						index.set(name, { ...f, size, tier });
				}
		}
		return index;
	};

	// the frames of a tier or of both, oldest arrival first
	const frames = async (tier) => [...(await loadIndex()).values()]
		.filter((f) => !tier || f.tier === tier)
		.sort((a, b) => a.arrival - b.arrival || a.kept - b.kept);

	const usage = async (tier) => (await frames(tier)).reduce((n, f) => n + f.size, 0);

	const write = async (tier, name, bytes) => {
		await backend.write(`${tier}/${name}`, bytes);
		(await loadIndex()).set(name, { ...parseFrameName(name), size: bytes.length, tier });
	};

	const removeFrame = async (name) => {
		const f = (await loadIndex()).get(name);
		if (!f)
			return;
		await backend.remove(`${f.tier}/${name}`);
		index.delete(name);
	};

	// remove the frames kept longest ago until each tier fits its budget
	const evict = async () => {
		const { budgets } = await settings();
		const gone = [];
		for (const tier of TIERS) {
			const all = (await frames(tier)).sort((a, b) => a.kept - b.kept);
			let total = all.reduce((n, f) => n + f.size, 0);
			for (const f of all) {
				if (total <= budgets[tier])
					break;
				await removeFrame(f.name);
				total -= f.size;
				gone.push(f.name);
			}
		}
		return gone;
	};

	// Store a frame exactly as received, with what the preamble said, in a
	// tier. Returns its name, or null if the tier keeps nothing; older frames
	// of the tier may be evicted to make room.
	const addFrame = async (bytes, { tier = 'logged', arrival, callSign = null, mode = null } = {}) => {
		if (!(bytes instanceof Uint8Array) || !bytes.length)
			throw new RangeError('a frame must be a non-empty Uint8Array');
		checkTier(tier);
		const t = tick();
		const name = frameName(t, arrival ?? t, callSign, mode);
		await write(tier, name, bytes);
		await evict();
		return (await loadIndex()).has(name) ? name : null;
	};

	const readFrame = async (name) => {
		const f = (await loadIndex()).get(name);
		return f ? backend.read(`${f.tier}/${name}`) : null;
	};

	// Keep a frame as if it had just arrived, for avatars of active keys.
	// Returns its new name.
	const touch = async (name) => {
		const f = (await loadIndex()).get(name);
		const bytes = f && await readFrame(name);
		if (!bytes)
			return null;
		const fresh = frameName(tick(), f.arrival, f.callSign, f.mode);
		await write(f.tier, fresh, bytes);
		await removeFrame(name);
		return fresh;
	};

	// Move a frame to another tier, keeping its name. Returns whether it
	// is there now; the target tier may evict others, or the frame itself.
	const move = async (name, tier) => {
		checkTier(tier);
		const f = (await loadIndex()).get(name);
		if (!f)
			return false;
		if (f.tier !== tier) {
			const bytes = await readFrame(name);
			await removeFrame(name);
			await write(tier, name, bytes);
			await evict();
		}
		return (await loadIndex()).get(name)?.tier === tier;
	};

	// after an import wrote files behind the store's back
	const reload = () => {
		index = null;
		return evict();
	};

	// Keep a revocation forever, outside the budgets: a Signed(key, Revoke)
	// of 99 bytes, only for a key the user trusts and only once its
	// signature verified, both up to the caller, since anyone can make keys
	// and revoke them. Only its earliest arrival per key and reason is kept.
	const addRevocation = async (bytes, arrival = now()) => {
		if (!(bytes instanceof Uint8Array) || bytes.length !== 99 || bytes[0] !== 0x20 || bytes[1] !== 97 || (bytes[98] !== 0x28 && bytes[98] !== 0x29))
			throw new RangeError('a revocation is a Signed record of 99 bytes holding one Revoke');
		const key = hex(bytes.subarray(2, 34));
		const reason = bytes[98] === 0x29 ? 'compromised' : 'retired';
		const known = (await revocations()).find((r) => r.key === key && r.reason === reason);
		if (known)
			return known.name;
		const name = `${key}_${reason}_${time(arrival)}.bin`;
		await backend.write(`revocations/${name}`, bytes);
		return name;
	};

	const revocations = async () => (await backend.list('revocations'))
		.map(({ name }) => parseRevocationName(name))
		.filter(Boolean)
		.sort((a, b) => a.arrival - b.arrival);

	const readRevocation = (name) => backend.read(`revocations/${name}`);

	// Delete everything: frames, revocations, data and secrets. Returns
	// how many files went.
	const clear = async () => {
		let n = 0;
		for (const dir of DIRS)
			for (const { name } of await backend.list(dir)) {
				await backend.remove(`${dir}/${name}`);
				++n;
			}
		index = null;
		return n;
	};

	return {
		backend,
		addFrame, readFrame, frames, touch, removeFrame, usage, evict, reload,
		promote: (name) => move(name, 'precious'),
		demote: (name) => move(name, 'logged'),
		addRevocation, revocations, readRevocation,
		clear,
		settings,
		// changes are merged, budgets too: { budgets: { logged: 0 } } keeps the other
		setSettings: async (changes) => {
			const old = await settings();
			await putJSON('data', 'settings', { ...old, ...changes, budgets: { ...old.budgets, ...changes.budgets } });
			return evict();
		},
		getData: (name) => getJSON('data', name),
		putData: (name, value) => putJSON('data', name, value),
		getSecret: (name) => getJSON('secrets', name),
		putSecret: (name, value) => putJSON('secrets', name, value),
	};
}
