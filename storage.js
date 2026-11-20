// Station storage: frames as received, one file each, bounded by bytes;
// revocations forever; JSON data and secrets. Files live in a backend: the
// Origin Private File System in browsers, or memory for tests and Node.js.
//
// Layout, all names checked by safeName():
//   frames/<kept>_<arrival>_<call sign>_<mode>.bin   the frame's bytes
//   revocations/<key hex>_<reason>_<arrival>.bin      a Signed(key, Revoke)
//   data/<name>.json                                  settings, trust lists
//   secrets/<name>.json                               private keys, Keyed secrets
// Times are milliseconds since 1970, 13 digits. Eviction removes the frame
// with the oldest kept time; touch() renews it, the arrival time stays.

export const DIRS = Object.freeze(['frames', 'revocations', 'data', 'secrets']);
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

	const settings = async () => ({ budget: BUDGET_DEFAULT, ...(await getJSON('data', 'settings')) });

	// name -> frame, read from the backend once; this store is its only writer
	let index = null;
	const loadIndex = async () => {
		if (!index) {
			index = new Map();
			for (const { name, size } of await backend.list('frames')) {
				const f = parseFrameName(name);
				if (f)
					index.set(name, { ...f, size });
			}
		}
		return index;
	};

	// all frames, oldest arrival first
	const frames = async () => [...(await loadIndex()).values()]
		.sort((a, b) => a.arrival - b.arrival || a.kept - b.kept);

	const usage = async () => [...(await loadIndex()).values()].reduce((n, f) => n + f.size, 0);

	const write = async (name, bytes) => {
		await backend.write(`frames/${name}`, bytes);
		(await loadIndex()).set(name, { ...parseFrameName(name), size: bytes.length });
	};

	const removeFrame = async (name) => {
		await backend.remove(`frames/${name}`);
		(await loadIndex()).delete(name);
	};

	// remove the frames kept longest ago until they fit the budget
	const evict = async () => {
		const { budget } = await settings();
		const all = [...(await loadIndex()).values()].sort((a, b) => a.kept - b.kept);
		let total = all.reduce((n, f) => n + f.size, 0);
		const gone = [];
		for (const f of all) {
			if (total <= budget)
				break;
			await removeFrame(f.name);
			total -= f.size;
			gone.push(f.name);
		}
		return gone;
	};

	// Store a frame exactly as received, with what the preamble said.
	// Returns its name; older frames may be evicted to make room.
	const addFrame = async (bytes, { arrival, callSign = null, mode = null } = {}) => {
		if (!(bytes instanceof Uint8Array) || !bytes.length)
			throw new RangeError('a frame must be a non-empty Uint8Array');
		const t = tick();
		const name = frameName(t, arrival ?? t, callSign, mode);
		await write(name, bytes);
		await evict();
		return name;
	};

	const readFrame = (name) => backend.read(`frames/${name}`);

	// Keep a frame as if it had just arrived, for avatars of active keys.
	// Returns its new name.
	const touch = async (name) => {
		const f = parseFrameName(name);
		const bytes = f && await readFrame(name);
		if (!bytes)
			return null;
		const fresh = frameName(tick(), f.arrival, f.callSign, f.mode);
		await write(fresh, bytes);
		await removeFrame(name);
		return fresh;
	};

	// after an import wrote files behind the store's back
	const reload = () => {
		index = null;
		return evict();
	};

	// Keep a revocation forever, outside the budget: a Signed(key, Revoke)
	// of 99 bytes. Only its earliest arrival per key and reason is kept.
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

	return {
		backend,
		addFrame, readFrame, frames, touch, removeFrame, usage, evict, reload,
		addRevocation, revocations, readRevocation,
		settings,
		setSettings: async (changes) => {
			await putJSON('data', 'settings', { ...(await settings()), ...changes });
			return evict();
		},
		getData: (name) => getJSON('data', name),
		putData: (name, value) => putJSON('data', name, value),
		getSecret: (name) => getJSON('secrets', name),
		putSecret: (name, value) => putJSON('secrets', name, value),
	};
}
