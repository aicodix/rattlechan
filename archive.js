// Export and import of a station's storage as .tar.gz files. The data
// archive holds frames, revocations and data; the secrets archive holds
// only the secrets (private keys, Keyed secrets), so data can be shared
// without them. An import adds what isn't there yet and keeps the rest.

import { DIRS, safeName } from './storage.js';
import { writeTar, readTar } from './tar.js';

const ROOT = 'rattlechan';

async function pipe(bytes, stream) {
	const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
	return new Uint8Array(await out.arrayBuffer());
}

export const gzip = (bytes) => pipe(bytes, new CompressionStream('gzip'));
export const gunzip = (bytes) => pipe(bytes, new DecompressionStream('gzip'));

// The .tar.gz of a backend: secrets: false for frames, revocations and
// data, true for the secrets alone
export async function exportArchive(backend, { secrets = false } = {}) {
	const dirs = secrets ? ['secrets'] : DIRS.filter((d) => d !== 'secrets');
	const files = [];
	const mtime = Math.floor(Date.now() / 1000);
	for (const dir of dirs)
		for (const { name } of (await backend.list(dir)).sort((a, b) => a.name < b.name ? -1 : 1)) {
			const bytes = await backend.read(`${dir}/${name}`);
			if (bytes)
				files.push({ name: `${ROOT}/${dir}/${name}`, bytes, mtime });
		}
	return gzip(writeTar(files));
}

// Add the files of a .tar.gz to a backend. Only rattlechan/<dir>/<name>
// with a known directory and a safe name is taken; existing files stay.
// Returns { added, kept, skipped } with the paths of each. Call the store's
// reload() afterwards.
export async function importArchive(backend, archive) {
	const files = readTar(await gunzip(archive));
	const result = { added: [], kept: [], skipped: [] };
	for (const { name, bytes } of files) {
		const parts = name.split('/');
		if (parts.length !== 3 || parts[0] !== ROOT || !DIRS.includes(parts[1]) || !safeName(parts[2])) {
			result.skipped.push(name);
			continue;
		}
		const path = `${parts[1]}/${parts[2]}`;
		if (await backend.read(path)) {
			result.kept.push(path);
			continue;
		}
		await backend.write(path, bytes);
		result.added.push(path);
	}
	return result;
}
