// Tests for scsu.js. Run with: node scsu_test.mjs

import { readFile } from 'node:fs/promises';
import { loadScsu } from './scsu.js';
import { smallestText } from './encodings.js';
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

function throws(name, fn) {
	++checks;
	try {
		fn();
		++failed;
		console.log('FAIL', name, 'did not throw');
	} catch {}
}

const S = await loadScsu(await readFile(new URL('./scsu.wasm', import.meta.url)));
const utf8Length = (s) => new TextEncoder().encode(s).length;

// --------------------------------------------------------- round trips

const samples = {
	English: 'Hungry',
	German: 'Grüße aus Köln, schöne Straße!',
	Russian: 'Привет всем! Как дела?',
	Greek: 'Καλημέρα σε όλους',
	Arabic: 'مرحبا بالجميع',
	Hebrew: 'שלום לכולם',
	Hindi: 'नमस्ते सबको',
	Tamil: 'அனைவருக்கும் வணக்கம்',
	Thai: 'สวัสดีทุกคน',
	Japanese: 'みなさん、こんにちは',
	Chinese: '大家好，欢迎收听',
	Korean: '여러분 안녕하세요',
	Emoji: 'Hungry 🍕 73! 📻',
	Mixed: 'DL1ABC: Привет, 大家好, नमस्ते 🙂',
	Private: '\u{F0000}\u{10FFFD}',
};
for (const [script, text] of Object.entries(samples)) {
	const bytes = S.encode(text);
	check(`${script} round trip`, S.decode(bytes), text);
	check(`${script} not larger than 4 × UTF-8`, bytes.length <= 4 * utf8Length(text), true);
}
for (const script of ['Russian', 'Greek', 'Arabic', 'Hebrew', 'Hindi', 'Tamil', 'Thai', 'Japanese', 'Chinese'])
	check(`${script} is smaller in SCSU`, S.encode(samples[script]).length < utf8Length(samples[script]), true);
check('ASCII stays ASCII', String.fromCharCode(...S.encode('Hello, World!')), 'Hello, World!');
check('empty text', S.decode(S.encode('')), '');
check('lone surrogate becomes U+FFFD', S.decode(S.encode('a\uD800b')), 'a�b');

// ---------------------------------------------------- invalid input

check('reserved tag 0x0C', S.decode(Uint8Array.of(0x0C)), null);
check('truncated quote', S.decode(Uint8Array.of(0x0E, 0x04)), null);
check('not a Uint8Array', S.decode([0x41]), null);
check('too long to decode', S.decode(new Uint8Array(R.SCSU_MAX + 1)), null);
throws('too long to encode', () => S.encode('a'.repeat(R.SCSU_MAX + 1)));
const longest = 'ж'.repeat(R.SCSU_MAX / 2);
check('longest text round trip', S.decode(S.encode(longest)), longest);

// -------------------------------------------------- with records.js

{
	const ru = R.textSCSU(S.encode(samples.Russian));
	check('Hindi is smallest in SCSU', smallestText(samples.Hindi, { scsu: S })[0], T.TEXT_SCSU);
	const frame = R.payload([R.fromName(R.textSCSU(S.encode('Сергей'))), R.topic(1763380000, ru, R.textSCSU(S.encode(samples.Hindi)))]);
	const p = R.parse(frame, { scsu: S });
	check('SCSU name handle', R.decodeText(p[0].prefixes[0].handle), 'Сергей');
	check('SCSU subject', R.decodeText(p[0].subject), samples.Russian);
	check('SCSU text part', R.decodeText(p[0].text), samples.Hindi);
	check('decoded later instead', R.decodeText(R.parse(frame)[0].text, S), samples.Hindi);
	const bad = R.payload([R.textSCSU(Uint8Array.of(0x41, 0x0C))]);
	let dropped = false;
	try {
		R.parse(bad, { scsu: S });
	} catch (e) {
		dropped = e instanceof R.MalformedError;
	}
	check('invalid SCSU drops the frame', dropped, true);
	check('without the decoder it is only undecoded', R.decodeText(R.parse(bad)[0]), null);
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
