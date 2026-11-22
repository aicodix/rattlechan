// Tests for session.mjs. Run with: node examples/session_test.mjs
// The whole session goes through the ROBUSTO decoder and a station in
// memory, at both rates: every frame arrives, the stream has no gap, and
// the station makes of it what the GUI shows.

import { readFile } from 'node:fs/promises';
import { session, wav } from './session.mjs';
import { loadDecoder } from '../robusto.js';
import { loadCrypto } from '../crypto.js';
import { loadHydra } from '../hydra.js';
import { openStation, hex } from '../station.js';
import { memoryBackend, openStore } from '../storage.js';
import * as R from '../records.js';

let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

const file = (name) => readFile(new URL(`../${name}`, import.meta.url));
const C = await loadCrypto(await file('crypto.wasm'));
const H = await loadHydra(await file('hydra.wasm'));
const now = 1763730000;

for (const rate of [48000, 44100]) {
	const s = await session({ file, rate, now });
	const again = await session({ file, rate, now });
	check(`${rate}: the same every time`, hex(wav(again.audio, rate)) === hex(wav(s.audio, rate)), true);

	// no gap: silence only at both ends, each a quarter second. The modem
	// fades a frame in and out within part of a guard interval, rate / 300
	// samples, so the signal starts and ends a few samples later, and dips
	// for that long where one frame meets the next
	const guard = rate / 300;
	const quiet = (i) => Math.abs(s.audio[i]) < 1e-6;
	let first = 0, last = s.audio.length - 1, longest = 0, run = 0;
	while (quiet(first))
		++first;
	while (quiet(last))
		--last;
	for (let i = first; i <= last; ++i) {
		run = quiet(i) ? run + 1 : 0;
		longest = Math.max(longest, run);
	}
	check(`${rate}: a quarter second of silence before`, first >= rate / 4 && first <= rate / 4 + guard, true);
	check(`${rate}: and after`, s.audio.length - 1 - last >= rate / 4 && s.audio.length - 1 - last <= rate / 4 + guard, true);
	check(`${rate}: no gap in between, at most a guard interval`, longest <= guard, true);
	check(`${rate}: frames follow each other`, s.items.every((it, i) => !i || it.start > s.items[i - 1].start), true);

	// everything decodes, in order
	const D = await loadDecoder(rate, await file(`robusto_decoder_${rate}.wasm`));
	const events = [];
	for (let i = 0; i < s.audio.length; i += 4096)
		events.push(...D.feed(s.audio.subarray(i, i + 4096)));
	events.push(...D.flush());
	const got = events.filter((e) => e.type === 'frame' || e.type === 'ping');
	check(`${rate}: every frame and the ping`, got.length, s.items.length);
	check(`${rate}: no errors`, events.filter((e) => e.type === 'error').length, 0);
	check(`${rate}: in order, with their call signs`, got.map((e) => e.callSign).join(), s.items.map((it) => it.callSign).join());
	check(`${rate}: payloads intact`, got.every((e, i) => {
		const sent = s.items[i]?.payload;
		return e.type === 'ping' ? !sent : !!sent && hex(e.payload.subarray(0, sent.length)) === hex(sent) && !e.payload.subarray(sent.length).some((b) => b);
	}), true);

	// what a station makes of it
	const S = await openStation({ store: await openStore(memoryBackend()), crypto: C, hydra: H });
	const entries = [];
	for (const e of got.filter((e) => e.type === 'frame'))
		entries.push(await S.receive(e.payload, { callSign: e.callSign, mode: e.mode }));
	const dropped = entries.filter((e) => e.error).map((e) => e.error.split(' at ')[0]);
	check(`${rate}: forged and malformed dropped`, dropped.join(), 'bad signature,reserved type 0xFF');
	const reassembled = entries.flatMap((e) => e.fragments).filter((f) => f.nodes);
	check(`${rate}: avatar and long post reassembled`, reassembled.length, 2);
	const names = S.seen().map((k) => `${k.callSign} ${k.name ? R.decodeText(k.name) : ''}`.trim()).sort().join(', ');
	check(`${rate}: learned who the keys are`, names, 'DL1ABC Anna, JA1ABC, PA3XYZ Jan, VU2ABC Arjun');
	const anna = S.seen().find((k) => k.callSign === 'DL1ABC');
	check(`${rate}: Anna's avatar`, hex(anna.avatar ?? []), hex(await file('examples/avatar.webp')));
	const to = entries.flatMap((e) => (e.nodes ?? []).flatMap((n) => (n.children ?? [n]).flatMap((c) => c.prefixes ?? []))).filter((p) => p.type >= R.T.TO_KEY).map((p) => p.name);
	check(`${rate}: addressed to a key, a call sign and a board`, to.sort().join(), 'TO_CALL,TO_GROUP_NAME,TO_KEY');
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
