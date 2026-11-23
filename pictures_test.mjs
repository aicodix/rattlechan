// Tests for pictures.js. Run with: node pictures_test.mjs
// The pictures in examples/pictures/ were made with Pillow: a still and a
// moving PNG (APNG), a baseline and a progressive JPEG, a still and a
// moving GIF, and a PNG 2000 pixels wide.

import { readFile } from 'node:fs/promises';
import { pictureInfo, small, SHOWN_MAX } from './pictures.js';

let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

const file = async (name) => new Uint8Array(await readFile(new URL(name, import.meta.url)));
const info = async (name) => JSON.stringify(pictureInfo(await file(name)));
const want = (type, width, height, animated) => JSON.stringify({ type, width, height, animated });

check('still PNG', await info('examples/pictures/still.png'), want('image/png', 40, 30, false));
check('moving PNG', await info('examples/pictures/moving.png'), want('image/png', 40, 30, true));
check('JPEG', await info('examples/pictures/photo.jpg'), want('image/jpeg', 64, 48, false));
check('progressive JPEG', await info('examples/pictures/progressive.jpg'), want('image/jpeg', 64, 48, false));
check('still GIF', await info('examples/pictures/still.gif'), want('image/gif', 32, 32, false));
check('moving GIF', await info('examples/pictures/moving.gif'), want('image/gif', 32, 32, true));
check('wide PNG', await info('examples/pictures/wide.png'), want('image/png', 2000, 40, false));
check('still WebP', await info('examples/dusk.webp'), want('image/webp', 192, 120, false));
check('moving WebP', JSON.parse(await info('examples/avatars/anna.webp')).animated, true);

// by its bytes, never by a name or a claimed type
check('text is no picture', pictureInfo(new TextEncoder().encode('%PDF-1.4 not a picture')), null);
check('empty', pictureInfo(new Uint8Array(0)), null);
check('not bytes', pictureInfo('GIF89a'), null);
const png = await file('examples/pictures/still.png');
check('a PNG cut short', pictureInfo(png.subarray(0, 20)), null);
const zero = png.slice();
zero.fill(0, 16, 24);
check('a PNG without a size', pictureInfo(zero), null);
check('a JPEG cut before its frame header', pictureInfo((await file('examples/pictures/photo.jpg')).subarray(0, 12)), null);

// drawn right away up to SHOWN_MAX on each side
check('limit', SHOWN_MAX, 1024);
check('small', small({ width: 1024, height: 1024 }), true);
check('too wide', small({ width: 1025, height: 10 }), false);
check('too tall', small({ width: 10, height: 1025 }), false);
check('unknown', small(null), false);

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
