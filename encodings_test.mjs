// Tests for encodings.js. Run with: node encodings_test.mjs
// Every character each decoder produces from one or two bytes has to
// encode back, and the smallest record has to decode to the same text.

import { readFile } from 'node:fs/promises';
import { encode, textRecords, smallestText } from './encodings.js';
import { loadScsu } from './scsu.js';
import * as R from './records.js';

const { T } = R;
let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

const supported = (label) => {
	try {
		new TextDecoder(label);
		return true;
	} catch {
		return false;
	}
};
const hex = (a) => a && Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
const S = await loadScsu(await readFile(new URL('./scsu.wasm', import.meta.url)));

// ------------------------------------- everything the decoders produce

const t0 = performance.now();
for (const label of [...R.TEXT_TABLE, 'gb18030']) {
	if (!supported(label)) {
		check(`${label} is never used where it can't be decoded`, encode('a', label), null);
		continue;
	}
	if (label === 'UTF-16LE')
		continue;
	const dec = new TextDecoder(label);
	const chars = new Set();
	const take = (bytes) => {
		const s = dec.decode(bytes);
		if (!s.includes('�') && [...s].length === 1)
			chars.add(s);
	};
	for (let a = 0; a < 256; ++a) {
		take(Uint8Array.of(a));
		if (a >= 0x81 && label !== 'gb18030' && !/^(IBM|ISO|KOI|mac|win|x-)/.test(label))
			for (let b = 0x40; b < 0x100; ++b)
				// Node's ICU also reads 0x8E 0xE0..0xE2 as ¢ £ ¬, which
				// WHATWG and so browsers don't: the encoder leaves them out
				if (!(label === 'EUC-JP' && a === 0x8E && b > 0xDF))
					take(Uint8Array.of(a, b));
	}
	const all = [...chars].join('');
	const bytes = encode(all, label);
	check(`${label}: all ${chars.size} characters encode`, bytes !== null, true);
	check(`${label}: and decode back`, bytes && new TextDecoder(label).decode(bytes), all);
}
check('building every encoder takes less than 2 seconds', performance.now() - t0 < 2000, true);

// GB 18030 covers all of Unicode
{
	let bmp = '';
	for (let cp = 0; cp < 0x10000; ++cp)
		if (cp < 0xD800 || cp > 0xDFFF)
			bmp += String.fromCharCode(cp);
	// GB 18030-2022 maps no byte sequence to a few private use characters,
	// such as U+E5E5, which the WHATWG encoder refuses too
	const missing = [...bmp].filter((c) => !encode(c, 'gb18030'));
	check('GB 18030: every BMP character but a few private use ones', missing.length < 32 && missing.every((c) => c >= '\uE000' && c <= '\uF8FF'), true);
	check('GB 18030: U+E5E5 is refused', encode('\uE5E5', 'gb18030'), null);
	check('GB 18030: U+FFFD', hex(encode('\uFFFD', 'gb18030')), '8431a437');
	const rest = bmp.replace(/[\uE000-\uF8FF]/g, '');
	const bytes = encode(rest, 'gb18030');
	check('GB 18030: every other BMP character round trip', bytes && new TextDecoder('gb18030').decode(bytes) === rest, true);
	for (const cp of [0x10000, 0x1F355, 0x20000, 0xF0000, 0x10FFFF]) {
		const s = String.fromCodePoint(cp);
		const b = encode(s, 'gb18030');
		check(`GB 18030: U+${cp.toString(16).toUpperCase()} in four bytes`, b && b.length, 4);
	}
	check('GB 18030: Chinese in two bytes', encode('大家好', 'gb18030').length, 6);
	check('GB 18030: ASCII in one', hex(encode('Hi', 'gb18030')), '4869');
}

// ------------------------------------------------ single encodings

check('windows-1252: €', hex(encode('€', 'windows-1252')), '80');
check('KOI8-R: Привет', hex(encode('Привет', 'KOI8-R')), 'f0d2c9d7c5d4');
check('KOI8-R has no €', encode('€', 'KOI8-R'), null);
check('windows-1252 has no Cyrillic', encode('ж', 'windows-1252'), null);
check('Shift_JIS: half-width katakana in one byte', hex(encode('ｱ', 'Shift_JIS')), 'b1');
check('Shift_JIS: こんにちは', encode('こんにちは', 'Shift_JIS').length, 10);
check('EUC-KR: 안녕', encode('안녕', 'EUC-KR').length, 4);
check('Big5: 你好', encode('你好', 'Big5').length, 4);
check('UTF-16LE: a🍕', hex(encode('a🍕', 'UTF-16LE')), '61003cd855df');
check('UTF-16LE: lone surrogate', encode('a\uD800', 'UTF-16LE'), null);
check('UTF-16LE: U+FEFF stays text', hex(encode('\uFEFFa', 'UTF-16LE')), 'fffe6100');
check('GB 18030: U+FEFF', hex(encode('\uFEFF', 'gb18030')), '84319533');
check('windows-1252: U+FEFF can\'t be there', encode('\uFEFFa', 'windows-1252'), null);
for (const r of textRecords('\uFEFFПривет'))
	check(`U+FEFF survives ${r[0].toString(16)} ${r[0] === 0x42 ? R.TEXT_TABLE[r[2]] : ''}`, R.decodeText(R.parse(r)[0]), '\uFEFFПривет');
check('empty text', hex(encode('', 'windows-1252')), '');

// ------------------------------------------------ picking the smallest

const samples = {
	English: 'Hungry, 73 de DL1ABC',
	German: 'Grüße aus Köln, schöne Straße!',
	Russian: 'Привет всем! Как дела?',
	Greek: 'Καλημέρα σε όλους',
	Hebrew: 'שלום לכולם',
	Thai: 'สวัสดีทุกคน',
	Hindi: 'नमस्ते सबको',
	Japanese: 'みなさん、こんにちは',
	Chinese: '大家好，欢迎收听',
	Korean: '여러분 안녕하세요',
	Emoji: '🍕🍕🍕',
	Mixed: 'DL1ABC: Привет, 大家好, नमस्ते 🙂',
};
const utf8Length = (s) => new TextEncoder().encode(s).length;
for (const [script, text] of Object.entries(samples)) {
	const all = textRecords(text, { scsu: S });
	const best = smallestText(text, { scsu: S });
	check(`${script}: smallest first`, all.every((r) => r.length >= best.length), true);
	check(`${script}: never larger than UTF-8`, best.length <= 2 + utf8Length(text), true);
	for (const r of all) {
		const node = R.parse(r, { scsu: S })[0];
		const name = node.type === T.TEXT_TABLE ? R.TEXT_TABLE[node.table] : node.name;
		check(`${script}: ${name} decodes back`, R.decodeText(node), text);
	}
}
check('English stays UTF-8', smallestText(samples.English, { scsu: S })[0], T.TEXT_UTF8);
check('ties go to UTF-8', smallestText('ab', { scsu: S })[0], T.TEXT_UTF8);
check('emoji are smaller in SCSU', smallestText(samples.Emoji, { scsu: S })[0], T.TEXT_SCSU);
check('Russian is smaller than UTF-8', smallestText(samples.Russian, { scsu: S }).length < utf8Length(samples.Russian), true);
check('Chinese is smaller than UTF-8', smallestText(samples.Chinese, { scsu: S }).length < utf8Length(samples.Chinese), true);
check('without SCSU, Hindi is smaller in UTF-16LE', R.TEXT_TABLE[smallestText(samples.Hindi)[2]], 'UTF-16LE');
check('with SCSU, Hindi is SCSU', smallestText(samples.Hindi, { scsu: S })[0], T.TEXT_SCSU);
check('Russian without SCSU uses the table', smallestText(samples.Russian)[0], T.TEXT_TABLE);

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
