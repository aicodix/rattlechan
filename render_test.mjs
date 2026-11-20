// Tests for render.js. Run with: node render_test.mjs
// The DOM parts run in the browser; here only what needs no document.

import { animatedWebP, hex, short, bytes } from './render.js';

let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
// RIFF size WEBP, then a chunk header and the VP8X flags byte
const webp = (chunk, flags) => Uint8Array.from([...ascii('RIFF'), 30, 0, 0, 0, ...ascii('WEBP'), ...ascii(chunk), 10, 0, 0, 0, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

check('animated WebP', animatedWebP(webp('VP8X', 0x02)), true);
check('animated WebP with alpha', animatedWebP(webp('VP8X', 0x12)), true);
check('extended WebP, not animated', animatedWebP(webp('VP8X', 0x10)), false);
check('simple lossy WebP', animatedWebP(webp('VP8 ', 0x02)), false);
check('lossless WebP', animatedWebP(webp('VP8L', 0x02)), false);
check('not a WebP', animatedWebP(Uint8Array.from(ascii('GIF89a................'))), false);
check('too short', animatedWebP(webp('VP8X', 0x02).subarray(0, 20)), false);

check('hex', hex(Uint8Array.of(0, 15, 255)), '000fff');
check('short', short(Uint8Array.of(1, 2, 3, 4, 5)), '01020304');
check('bytes', bytes(1023), '1023 B');
check('KiB', bytes(1536), '1.5 KiB');
check('MiB', bytes(3 * 1048576), '3.0 MiB');

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
