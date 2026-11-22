// A busy evening on the air as one seamless WAV, to fill the Inbox and
// the Boards: ten stations around the world talk on the board for
// everyone and on the boards "contest", "weather" and "club", answer each
// other several levels deep, and have direct conversations.
//   node examples/busy.mjs [out.wav] [44100|48000]
// To see the Inbox fill, be Petr, OK1ABC: in Station, add a key with the
// private key 0808…08 (64 hex characters, "08" 32 times), then decode the
// WAV. Petr gets a Topic to his fingerprint, one to his call sign, one
// that is maybe for him by name, and is in conversations he posted in. A
// stranger butts into one of his direct conversations, and a Reply to a
// post nobody received ends up elsewhere.
// Everyone but the stranger has an avatar from examples/avatars/, drawn
// with Pillow: the still ones go beside the station's first post, as
// "Include the avatar" does, the animated ones in an Avatar post of their
// own, as a key card's "Send avatar" does. Trust a station to see it.
// All posts are signed and sent as the GUI sends them, chained back to
// back, the long ones in Fragments.

import * as R from '../records.js';
import { loadEncoder } from '../robusto.js';
import { loadCrypto } from '../crypto.js';
import { loadHydra } from '../hydra.js';
import { compose, composeAvatar, split, SECONDS_DEFAULT, SNR_DEFAULT } from '../sender.js';
import { onAir, wav } from './session.mjs';

const opts = { seconds: SECONDS_DEFAULT, snr: SNR_DEFAULT };

// the stations: fixed keys, so the same ones come out every time
export const PEOPLE = Object.freeze({
	anna: { key: 1, call: 'DL1ABC', name: 'Anna', avatar: 'own' },
	jan: { key: 2, call: 'PA3XYZ', name: 'Jan', avatar: 'own' },
	yuki: { key: 3, call: 'JA1ABC', name: 'Yuki', avatar: 'beside' },
	arjun: { key: 4, call: 'VU2ABC', name: 'Arjun', avatar: 'beside' },
	camille: { key: 6, call: 'F4ABC', name: 'Camille', avatar: 'beside' },
	lucia: { key: 7, call: 'EA3XYZ', name: 'Lucía', avatar: 'own' },
	petr: { key: 8, call: 'OK1ABC', name: 'Petr', avatar: 'beside' },
	erik: { key: 11, call: 'SM5ABC', name: 'Erik', avatar: 'own' },
	mia: { key: 12, call: 'VK2ABC', name: 'Mia', avatar: 'beside' },
	tama: { key: 13, call: 'ZL1ABC', name: 'Tama', avatar: 'beside' },
	stranger: { key: 14, call: 'N0BODY', name: null, avatar: null },
});

// The evening: { rate, audio, items }, as session() gives it, plus the
// IDs of the posts by label. file(name) gives the bytes of a file of the
// repository; now is the time in seconds the last post was written.
export async function busy({ file, rate = 48000, now = Math.floor(Date.now() / 1000) }) {
	const E = await loadEncoder(rate, await file(`robusto_encoder_${rate}.wasm`));
	const C = await loadCrypto(await file('crypto.wasm'));
	const H = await loadHydra(await file('hydra.wasm'));
	const keyOf = (p) => new Uint8Array(32).fill(p.key);
	const fingerprint = (p) => C.fingerprint(keyOf(p));
	let t = now - 2 * 3600;

	const avatars = {};
	for (const [who, p] of Object.entries(PEOPLE))
		if (p.avatar)
			avatars[who] = new Uint8Array(await file(`examples/avatars/${who}.webp`));

	const items = [], ids = {};
	const introduced = new Set();
	// a payload on the air, in Fragments if it doesn't fit one frame
	const send = (p, what, payload) => {
		const s = split(payload, { encoder: E, hydra: H, ...opts });
		if (s.frames.length === 1)
			items.push({ callSign: p.call, what, payload });
		else
			s.frames.forEach((f, i) => items.push({ callSign: p.call, what: `${what}: Fragment ${i + 1} of ${s.frames.length}, any ${s.K} enough`, payload: f }));
	};
	// A post by who, signed, the first one of each station with its call
	// sign and name; label names it for the replies. Returns its ID.
	const say = (who, label, { subject, text, parent, to, what }) => {
		const p = PEOPLE[who];
		const first = !introduced.has(who);
		introduced.add(who);
		const sign = (...records) => C.signRecords(keyOf(p), ...records);
		if (first && p.avatar === 'own')
			send(p, `Avatar of ${p.name}`, composeAvatar({ avatar: avatars[who], callSign: p.call, name: p.name, sign }));
		t += 37 + (text.length % 53);
		const payload = compose({
			kind: subject ? 'topic' : 'reply', subject, text, to, timestamp: t,
			parent: parent && (typeof parent === 'string' ? ids[parent] : parent),
			callSign: first ? p.call : null, name: first ? p.name : null,
			avatar: first && p.avatar === 'beside' ? avatars[who] : null, sign,
		});
		const node = R.parse(payload)[0].children.find((n) => n.type === R.T.TOPIC || n.type === R.T.REPLY);
		ids[label] = R.postId(node.raw, fingerprint(p));
		send(p, `${what ?? (subject ? 'Topic' : 'Reply')} ${label}${first && p.avatar === 'beside' ? ' with avatar' : ''}`, payload);
		return ids[label];
	};

	// the board for everyone: band conditions, a lively thread
	say('erik', 'bands', { subject: 'Band conditions tonight?', text: 'Anyone else hearing the long path to VK on 20 m? Signals are coming and going here in Stockholm.' });
	say('mia', 'bands-vk', { parent: 'bands', text: 'G\'day Erik! Yes, I can hear Europe on 20 m right now, about S5 here in Sydney.' });
	say('erik', 'bands-vk-2', { parent: 'bands-vk', text: 'Great, Mia! Your signal is S4 with some QSB. Shall we try a QSO on 14.230?' });
	say('mia', 'bands-vk-3', { parent: 'bands-vk-2', text: 'On my way to 14.230 now.' });
	say('arjun', 'bands-vu', { parent: 'bands', text: 'From Bangalore 15 m is wide open to Japan tonight.' });
	say('yuki', 'bands-ja', { parent: 'bands-vu', text: 'Yes Arjun, I hear you 5/7 in Tokyo. どうもありがとう!' });
	say('camille', 'bands-f', { parent: 'bands', text: 'Rien sur 10 m ici, le soleil dort.' });

	// a first QSO
	say('camille', 'first', { subject: 'Premier QSO avec Rattlechan !', text: 'Mon premier message reçu par un autre station. Merci Lucía pour la patience !' });
	say('lucia', 'first-1', { parent: 'first', text: '¡Enhorabuena, Camille! Tu señal llegó perfecta.' });
	say('anna', 'first-2', { parent: 'first', text: 'Congratulations! Welcome on the board.' });
	say('camille', 'first-3', { parent: 'first-2', text: 'Merci Anna !' });

	// an antenna question that goes deep
	say('lucia', 'swr', { subject: 'SWR 3:1 on 2 m', text: 'My new J-pole shows an SWR of 3:1 at 145 MHz. Where should I start looking?' });
	say('jan', 'swr-1', { parent: 'swr', text: 'Check the feed point first. Is the coax shorted or wet?' });
	say('lucia', 'swr-2', { parent: 'swr-1', text: 'The coax is fine, I measured it with a dummy load.' });
	say('jan', 'swr-3', { parent: 'swr-2', text: 'Then try moving the feed point up or down the matching section a few millimetres at a time.' });
	say('lucia', 'swr-4', { parent: 'swr-3', text: 'Moved it 8 mm up: SWR is 1.8 now.' });
	say('jan', 'swr-5', { parent: 'swr-4', text: 'Getting there. Another 4 mm?' });
	say('lucia', 'swr-6', { parent: 'swr-5', text: '1.2:1! Thank you so much, Jan.' });
	say('petr', 'swr-petr', { parent: 'swr', text: 'Also keep the J-pole away from the metal mast, that changed mine a lot.' });

	// Petr's own Topic: everyone who answers lands in his inbox
	say('petr', 'qrp', { subject: 'QRP from the Krkonoše mountains', text: 'Tomorrow I will be on Sněžka with 5 W and a whip. Listen for OK1ABC on 2 m from 10 UTC.' });
	say('anna', 'qrp-1', { parent: 'qrp', text: 'I will listen from Cologne, good luck!' });
	say('erik', 'qrp-2', { parent: 'qrp', text: 'Take warm clothes, Petr.' });
	say('petr', 'qrp-3', { parent: 'qrp-2', text: 'Already packed, Erik :)' });

	// the contest board
	say('jan', 'contest', { subject: 'VHF contest on Saturday', text: 'Who is joining? I will run from JO31 with 50 W and a 9-element yagi.', to: { group: 'contest' } });
	say('anna', 'contest-1', { parent: 'contest', text: 'Count me in, JO30.' });
	say('lucia', 'contest-2', { parent: 'contest', text: 'Only Sunday morning for me.' });
	say('jan', 'contest-3', { parent: 'contest-2', text: 'Sunday morning is when the good openings are.' });
	say('erik', 'rules', { subject: 'Exchange in the contest', text: 'Is it RST plus serial number plus locator, or only the locator this year?', to: { group: 'contest' } });
	say('jan', 'rules-1', { parent: 'rules', text: 'RST, serial and locator, as always.' });

	// the weather board, readings as text
	say('tama', 'wx', { subject: 'Weather in Auckland', text: 'Clear skies, 14 °C, light wind from the south-west. Good night for meteor scatter.', to: { group: 'weather' } });
	say('mia', 'wx-1', { parent: 'wx', text: 'Rain here in Sydney all day, 19 °C.' });
	say('yuki', 'wx-2', { subject: '東京の天気', text: '今夜は晴れ、気温8度。アンテナの調整日和です。', to: { group: 'weather' } });

	// the club board
	say('anna', 'club', { subject: 'Club meeting on Friday', text: 'We meet at 19:00 in the usual place. Bring your antenna projects!', to: { group: 'club' } });
	say('jan', 'club-1', { parent: 'club', text: 'I will bring the J-pole Lucía and I talked about.' });
	say('petr', 'club-2', { parent: 'club', text: 'Can someone stream it on the repeater for those of us far away?' });
	say('anna', 'club-3', { parent: 'club-2', text: 'Good idea, Petr. We will try.' });

	// direct to Petr's fingerprint, with a stranger butting in
	say('anna', 'qsl', { subject: 'Your QSL card arrived', text: 'Thank you for the beautiful card from Prague, Petr! Mine is on its way.', to: { key: fingerprint(PEOPLE.petr) } });
	say('petr', 'qsl-1', { parent: 'qsl', text: 'Glad it arrived, Anna! Looking forward to yours.' });
	say('stranger', 'qsl-x', { parent: 'qsl', text: 'Can I have a card too?' });
	say('anna', 'qsl-2', { parent: 'qsl-1', text: 'It should be there next week.' });

	// to his call sign, and to his name
	say('jan', 'sked', { subject: 'Sked on 70 cm?', text: 'Can we try 432.200 on Sunday at 08 UTC?', to: { call: 'OK1ABC' } });
	say('mia', 'name', { subject: 'Hello Petr', text: 'Are you the Petr who builds magnetic loops? I would love to see your design.', to: { name: 'Petr' } });

	// a direct conversation between two others: only in their inboxes
	say('yuki', 'tama', { subject: 'Meteor scatter test', text: 'Tama, shall we try JT6M tonight during the Geminids?', to: { key: fingerprint(PEOPLE.tama) } });
	say('tama', 'tama-1', { parent: 'tama', text: 'Yes! 50.230 at 12 UTC.' });

	// a Reply to a post nobody here received: elsewhere
	say('arjun', 'orphan', { parent: new Uint8Array(32).fill(0x42), text: 'Agreed, the new firmware fixed it for me too.' });

	// a long one, in Fragments
	say('arjun', 'long', { subject: 'How I built my first Yagi', text: 'Part one: the boom is a 2 m aluminium square tube, the elements are 6 mm rods. '.repeat(36) + 'More next week, 73!' });

	return { rate, ...onAir(E, items), ids };
}

// run from the command line
if (import.meta.url === `file://${process.argv[1]}`) {
	const { readFile, writeFile } = await import('node:fs/promises');
	const file = (name) => readFile(new URL(`../${name}`, import.meta.url));
	const out = process.argv[2] ?? 'rattlechan-busy.wav';
	const rate = Number(process.argv[3] ?? 48000);
	const s = await busy({ file, rate });
	await writeFile(out, wav(s.audio, s.rate));
	for (const item of s.items)
		console.log(`${(item.start / rate).toFixed(1).padStart(6)} s  ${item.callSign.padEnd(9)} ${String(item.payload.length).padStart(5)} B  ${item.what}`);
	console.log(`${out}: ${(s.audio.length / rate).toFixed(1)} s at ${rate} Hz, ${s.items.length} frames without a gap`);
}
