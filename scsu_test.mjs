// Tests for scsu.js, the JavaScript SCSU module copied from
// https://github.com/xdsopl/scsu, as Rattlechan uses it.
// Run with: node scsu_test.mjs

import * as S from './scsu.js';
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
for (const s of ['﻿', '﻿Hi', 'Hi﻿', '73 ﻿Привет'])
	check(`U+FEFF stays in ${JSON.stringify(s)}`, S.decode(S.encode(s)), s);

// ---------------------------------------------------- invalid input

check('lone surrogate is not encoded', S.encode('a\uD800b'), null);
check('reserved tag 0x0C', S.decode(Uint8Array.of(0x0C)), null);
check('truncated quote', S.decode(Uint8Array.of(0x0E, 0x04)), null);
const longest = 'ж'.repeat(R.SCSU_MAX / 2);
check('longest Text-SCSU round trip', S.decode(S.encode(longest)), longest);

// -------------------------------------------------- with records.js

{
	const frame = R.payload([R.fromName(R.textSCSU(S.encode('Сергей'))),
		R.topic(1763380000, R.textSCSU(S.encode(samples.Russian)), R.textSCSU(S.encode(samples.Hindi)))]);
	const p = R.parse(frame);
	check('SCSU name handle', R.decodeText(p[0].prefixes[0].handle), 'Сергей');
	check('SCSU subject', R.decodeText(p[0].subject), samples.Russian);
	check('SCSU text part', R.decodeText(p[0].text), samples.Hindi);
	let dropped = false;
	try {
		R.parse(R.payload([R.textSCSU(Uint8Array.of(0x41, 0x0C))]));
	} catch (e) {
		dropped = e instanceof R.MalformedError;
	}
	check('invalid SCSU drops the frame', dropped, true);
	check('a built record is Text-SCSU', R.textSCSU(S.encode('ж'))[0], T.TEXT_SCSU);
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
