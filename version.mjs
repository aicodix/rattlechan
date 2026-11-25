// The app's version, as its About section shows it, for a checkout.
//
//   node version.mjs            the fingerprint of the files as they are here
//   node version.mjs 3f9a1c2b   the commits whose files have that fingerprint
//
// Searching only sees the history at hand: a shallow clone has its last few
// commits, `git fetch --depth=200` brings more.

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { running } from './version.js';

const here = new URL('./', import.meta.url);
const git = (...args) => execFileSync('git', args, { cwd: here, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });

const wanted = process.argv[2]?.toLowerCase();
if (!wanted) {
	console.log(await running(async (f) => new Uint8Array(await readFile(new URL(f, here)))));
} else if (!/^[0-9a-f]{8}$/.test(wanted)) {
	console.error('a fingerprint is 8 hex digits, as About shows it');
	process.exit(2);
} else {
	let found = 0, seen = 0;
	for (const line of git('log', '--format=%H %h %cs %s').toString().trim().split('\n')) {
		const [commit, short, date, ...subject] = line.split(' ');
		++seen;
		let fp;
		try {
			fp = await running(async (f) => new Uint8Array(git('show', `${commit}:${f}`)));
		} catch {
			continue;
		}
		if (fp === wanted) {
			console.log(`${short} ${date} ${subject.join(' ')}`);
			++found;
		}
	}
	if (!found) {
		console.error(`no commit of the ${seen} at hand has ${wanted}`);
		process.exit(1);
	}
}
