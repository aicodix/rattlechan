// Tests for render.js. Run with: node render_test.mjs
// The DOM parts run in the browser; here only what needs no document.

import { hex, short, bytes, identiconCells, fileOf } from './render.js';
import * as R from './records.js';
import { blake2s } from './blake2s.js';

let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

check('hex', hex(Uint8Array.of(0, 15, 255)), '000fff');
check('short', short(Uint8Array.of(1, 2, 3, 4, 5)), '01020304');
check('bytes', bytes(1023), '1023 B');
check('KiB', bytes(1536), '1.5 KiB');
check('MiB', bytes(3 * 1048576), '3.0 MiB');

// identicons: mirrored, one colour of 8, all from the key
{
	const key = Uint8Array.from({ length: 32 }, (_, i) => i * 73 + 11 & 255);
	const { colour, cells } = identiconCells(key);
	check('identicon colour', colour, key[0] % 8);
	const set = new Set(cells.map(([x, y]) => `${x},${y}`));
	check('identicon mirrored', cells.every(([x, y]) => set.has(`${4 - x},${y}`)), true);
	check('identicon inside 5x5', cells.every(([x, y]) => x >= 0 && x < 5 && y >= 0 && y < 5), true);
	check('identicon same key, same picture', JSON.stringify(identiconCells(key)), JSON.stringify({ colour, cells }));
	const other = key.slice();
	other[1] ^= 1;
	check('identicon other key, other picture', JSON.stringify(identiconCells(other)) !== JSON.stringify({ colour, cells }), true);
	check('identicon all cells', identiconCells(new Uint8Array(32).fill(255)).cells.length, 25);
	check('identicon no cells', identiconCells(new Uint8Array(32)).cells.length, 0);
}

// files to save: only a MIME escape names itself, the rest by their hash
{
	const part = (rec) => R.parse(R.payload([rec]))[0];
	const c2 = fileOf(part(R.codec2(8, Uint8Array.of(1, 2, 3, 4, 5, 6, 7))));
	check('Codec2: the .c2 header back', hex(c2.data), 'c0dec2000808' + '00' + '01020304050607');
	check('Codec2: named by its hash', c2.name, `${hex(blake2s(c2.data))}.c2`);
	const named = fileOf(part(R.mime('application/pdf', 'log.pdf', Uint8Array.of(37, 80))));
	check('MIME with a name', [named.name, hex(named.data)].join(), 'log.pdf,2550');
	check('MIME without a name', fileOf(part(R.mime('application/pdf', '', Uint8Array.of(37, 80)))).name, `${hex(blake2s(Uint8Array.of(37, 80)))}.pdf`);
	check('MIME of a type without an extension', fileOf(part(R.mime('application/x-msdownload', '', Uint8Array.of(77, 90)))).name.endsWith('.bin'), true);
	const pic = Uint8Array.of(1, 2, 3);
	check('WebP', fileOf(part(R.webp(pic))).name, `${hex(blake2s(pic))}.webp`);
	// an Avatar by its bytes: a PNG signature and IHDR of 128x128
	const png = Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 128, 0, 0, 0, 128, 8, 6, 0, 0, 0, 0, 0, 0, 0);
	check('Avatar, a PNG', fileOf(part(R.avatar(png))).name, `${hex(blake2s(png))}.png`);
	check('Avatar, not a picture', fileOf(part(R.avatar(pic))).name, `${hex(blake2s(pic))}.bin`);
	check('not a file', fileOf(part(R.textUTF8('x'))), null);
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
