// Tests for records.js. Run with: node records_test.mjs
// Frames are built by hand or with the encoder, then parsed back.

import { blake2s } from './blake2s.js';
import * as R from './records.js';

const { T } = R;
const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
const bytes = (...a) => Uint8Array.from(a.flat());
const fill = (n, v) => new Uint8Array(n).fill(v);
let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

function malformed(name, payload, opts) {
	++checks;
	try {
		R.parse(payload, opts);
		++failed;
		console.log('FAIL', name, 'parsed, should be malformed');
	} catch (e) {
		if (!(e instanceof R.MalformedError)) {
			++failed;
			console.log('FAIL', name, 'threw', e);
		}
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

function parses(name, payload, opts) {
	try {
		return R.parse(payload, opts);
	} catch (e) {
		++checks;
		++failed;
		console.log('FAIL', name, e.message);
		return [];
	}
}

// Stand-in for CRYPTO: a deterministic 64-byte "signature" over key and message
const fakeSign = (key) => (msg) => R.concat(blake2s(R.concat(key, msg)), blake2s(R.concat(msg, key)));
const fakeVerify = (key, sig, msg) => hex(sig) === hex(fakeSign(key)(msg));

const alice = fill(32, 0xA1), bob = fill(32, 0xB0), group = fill(32, 0x99);
const parentId = fill(32, 0x77);
const secret = fill(32, 0x5E);

// ------------------------------------------------------------- lengths

for (const [n, want] of [[0, '00'], [254, 'fe'], [255, 'ff000000'], [256, 'ff010000'], [255 + 0xFFFFFF, 'ffffffff']])
	check(`length ${n}`, hex(R.encodeLength(n)), want);
throws('length too big', () => R.encodeLength(256 + 0xFFFFFF));
throws('negative length', () => R.encodeLength(-1));

for (const n of [0, 1, 254, 255, 256, 1000, 70000]) {
	const body = fill(n, 0x41);
	const p = parses(`text of ${n} bytes`, R.payload([R.record(T.TEXT_UTF8, body)]));
	check(`text of ${n} bytes parses back`, p.length === 1 && p[0].body.length, n);
}
malformed('length runs past payload', bytes(0x40, 5, 0x41, 0x41));
malformed('truncated long length', bytes(0x40, 0xFF, 0x00));
malformed('long length runs past payload', bytes(0x40, 0xFF, 0x00, 0x00, 0x00, fill(254, 0x41)));
malformed('missing length', bytes(0x40));

// ---------------------------------------------------------- call signs

check('call "A"', hex(R.encodeCall('A')), '0e0000000000');
check('call "AB"', hex(R.encodeCall('AB')), '3f0200000000');
for (const call of ['DL1ABC', 'DL1ABC-7', 'W1AW/P', 'ABCDEFGHI', 'Z', 'A B'])
	check(`call ${call} round trip`, R.decodeCall(R.encodeCall(call)), call);
check('call signs are case-insensitive', hex(R.encodeCall('dl1abc')), hex(R.encodeCall('DL1ABC')));
throws('call of 10 characters', () => R.encodeCall('ABCDEFGHIJ'));
throws('call with invalid character', () => R.encodeCall('DL1_ABC'));
throws('call with leading space', () => R.encodeCall(' DL1ABC'));
throws('empty call', () => R.encodeCall(''));
malformed('call sign value 40^9', bytes(T.FROM_CALL, 0x00, 0x00, 0x00, 0x28, 0x6B, 0xEE, R.textUTF8('x')));
malformed('call sign with digit 1', bytes(T.FROM_CALL, 1, 0, 0, 0, 0, 0, R.textUTF8('x')));
malformed('empty call sign', bytes(T.FROM_CALL, 0, 0, 0, 0, 0, 0, R.textUTF8('x')));
check('40^9 constant', 40 ** 9, 0xEE6B28000000);
check('call sign value 40^9 - 1', R.decodeCall(bytes(0xFF, 0xFF, 0xFF, 0x27, 0x6B, 0xEE)), 'ZZZZZZZZZ');

// ------------------------------------------------- sizes from the spec

check('From-Call + Temperature is 11 bytes', R.payload([R.fromCall('DL1ABC'), R.temperature(2150)]).length, 11);
check('From-Call + Position is 21 bytes', R.payload([R.fromCall('DL1ABC'), R.position({ lat: 0, lon: 0, time: 0 })]).length, 21);
check('Keyed overhead is 18 bytes', R.keyed(secret).length, 18);
check('Signed overhead is 98 bytes', R.signed(alice, fill(64, 0)).length, 98);
check('Signed(key, Revoke) is 99 bytes', R.signed(alice, fill(64, 0), R.revoke('retired')).length, 99);
check('Request-Post is 33 bytes', R.requestPost(parentId).length, 33);
check('Request-Root is 19 or 35 bytes', R.requestRoot(1, fill(16, 0)).length + ',' + R.requestRoot(1, fill(32, 0)).length, '19,35');

// -------------------------------------------- the spec's prefix example

{
	const post = (s) => R.topic(1763380000, s, R.textUTF8('body'));
	const frame = R.payload([R.signWith(fakeSign(alice), alice,
		R.fromCall('DL1ABC'), R.fromName('Ahmet'),
		R.bundle(
			R.toCall('DL2XYZ'), R.bundle(post('one'), post('two')),
			R.toGroupName('ragchew'), post('three')))], 512);
	const p = parses('prefix example', frame, { verify: fakeVerify });
	const posts = [...R.walk(p)].filter(([n]) => n.type === T.TOPIC).map(([n]) => n);
	check('prefix example has three posts', posts.length, 3);
	const chain = (n) => n.chain.map((x) => x.name + ':' + (typeof x.handle === 'string' ? x.handle : R.decodeText(x.handle))).join(' ');
	check('chain of post one', chain(posts[0]), 'FROM_CALL:DL1ABC FROM_NAME:Ahmet TO_CALL:DL2XYZ');
	check('chain of post two', chain(posts[1]), 'FROM_CALL:DL1ABC FROM_NAME:Ahmet TO_CALL:DL2XYZ');
	check('chain of post three', chain(posts[2]), 'FROM_CALL:DL1ABC FROM_NAME:Ahmet TO_GROUP_NAME:ragchew');
	check('direct prefixes of post three', posts[2].prefixes.length, 1);
	check('signature verified', p[0].verified, true);
	check('subject', R.decodeText(posts[2].subject), 'three');
	check('text', R.decodeText(posts[2].text), 'body');
	check('signer is the author', hex(posts[0].signer), hex(alice));
	check('post ID', hex(posts[0].id), hex(blake2s(R.concat(R.CONTEXT, [1], alice, post('one')))));
}

// ------------------------------------------------------ prefix rules

{
	const t = R.topic(1, 's', R.textUTF8('x'));
	const r = R.reply(1, parentId, R.textUTF8('x'));
	parses('From before To', R.payload([R.fromCall('A'), R.toCall('B'), t]));
	parses('every prefix kind in order', R.payload([R.fromCall('A'), R.fromName('a'), R.toKey(bob), R.toCall('B'),
		R.toName('b'), R.toGroupName('g'), R.toGroupKey(group), t]));
	malformed('To before From', R.payload([R.toCall('B'), R.fromCall('A'), t]));
	malformed('same prefix twice', R.payload([R.fromCall('A'), R.fromCall('B'), t]));
	malformed('same prefix through a Bundle', R.payload([R.fromCall('A'), R.bundle(R.fromCall('B'), t)]));
	malformed('From inside a To Bundle', R.payload([R.toCall('B'), R.bundle(R.fromName('a'), t)]));
	malformed('same prefix through nested Bundles', R.payload([R.toCall('B'), R.bundle(R.bundle(R.toCall('C'), t))]));
	parses('prefixes restart inside Signed', R.payload([R.signed(alice, fill(64, 0), R.fromCall('A'), t)]));
	malformed('prefix at end of payload', R.payload([R.fromCall('A')]));
	malformed('prefix before padding', R.payload([R.fromCall('A')], 20));
	malformed('prefix at end of Bundle', R.payload([R.bundle(t, R.toCall('B'))]));
	malformed('prefix before an empty Bundle', R.payload([R.fromCall('A'), R.bundle()]));
	malformed('inherited prefix in an empty nested Bundle', R.payload([R.fromCall('A'), R.bundle(t, R.bundle())]));
	parses('empty Bundle without prefixes', R.payload([R.bundle(), t]));
	parses('empty nested Bundle without prefixes', R.payload([R.bundle(R.bundle())]));
	malformed('prefix before a Reply', R.payload([R.toCall('B'), r]));
	malformed('prefix before a Reply through a Bundle', R.payload([R.toCall('B'), R.bundle(t, r)]));
	malformed('prefix before Signed', R.payload([R.fromCall('A'), R.signed(alice, fill(64, 0), t)]));
	malformed('prefix before Keyed', R.payload([R.fromCall('A'), R.keyed(secret, t)]));
	malformed('prefix before Request-Post', R.payload([R.toCall('B'), R.requestPost(parentId)]));
	malformed('prefix inside a post', R.payload([R.record(T.TOPIC, [1, 0, 0, 0], R.textUTF8('s'), R.fromCall('A'), R.textUTF8('x'))]));
	parses('prefix before a bare reading', R.payload([R.fromCall('A'), R.temperature(-500)]));
	parses('prefix before a bare text', R.payload([R.toCall('B'), R.textUTF8('Hungry')]));
	parses('prefix before an unknown optional record', R.payload([R.fromCall('A'), R.record(0x37, [1, 2])]));
	malformed('unknown prefix type', R.payload([bytes(0x08, 0), t]));
	malformed('name handle not a text record', R.payload([bytes(T.FROM_NAME), R.temperature(0), t]));
	const badUTF8 = R.record(T.TEXT_UTF8, [0xC3, 0x28]);
	malformed('invalid UTF-8 in a handle', R.payload([R.fromName(badUTF8), t]));
	malformed('invalid UTF-8 in a subject', R.payload([R.topic(1, badUTF8, R.textUTF8('x'))]));
	malformed('invalid UTF-8 in a text part', R.payload([R.reply(1, parentId, badUTF8)]));
	malformed('invalid UTF-8 in a bare text', R.payload([badUTF8]));
	malformed('truncated UTF-8 sequence', R.payload([R.record(T.TEXT_UTF8, [0xE2, 0x82])]));
	parses('invalid UTF-8 bytes are fine in other encodings', R.payload([R.textTable(19, [0xC3, 0x28])]));
	parses('Text-Table name handle', R.payload([R.fromName(R.textTable(19, [0x41, 0xE9])), t]));
	parses('unknown text type in a handle', R.payload([R.fromName(R.record(0x4A, [1, 2, 3])), t]));
	malformed('Text-Table handle without index', R.payload([R.fromName(R.record(T.TEXT_TABLE)), t]));
	malformed('truncated call prefix', bytes(T.FROM_CALL, 1, 2));
	malformed('truncated key prefix', bytes(T.TO_KEY, fill(31, 1)));
}

// ------------------------------------------------------ type classes

{
	const t = R.topic(1, 's', R.textUTF8('x'));
	malformed('reserved type 0xFF', bytes(0xFF, 0));
	malformed('unknown core type', R.payload([R.record(0x2A, [1]), t]));
	const p = parses('unknown optional record', R.payload([R.record(0x37, [1, 2]), t]));
	check('unknown optional record is kept as unknown', p[0].unknown, true);
	check('record after unknown optional', p[1].type, T.TOPIC);
	malformed('end of payload inside Bundle', R.payload([R.bundle(t, [0])]));
	malformed('end of payload inside Signed', R.payload([R.signed(alice, fill(64, 0), [0])]));
	const padded = parses('zero padding', R.payload([t, R.textUTF8('bare')], 100));
	check('zero padding ends the payload', padded.length, 2);
	check('records stop at the first zero', parses('garbage after end', R.concat(t, [0, 0xFF, 0xFF])).length, 1);
	malformed('nested record longer than its container', R.payload([R.record(T.BUNDLE, bytes(0x40, 9, 0x41))]));
	malformed('nesting too deep', R.payload([R.bundle(R.bundle(R.bundle(t)))]), { maxDepth: 2 });
	parses('nesting at the limit', R.payload([R.bundle(R.bundle(t))]), { maxDepth: 2 });
}

// ------------------------------------------------ must-understand records

{
	const t = R.topic(1, 's', R.textUTF8('x'));
	const mu = R.record(0xF0, [1, 2, 3]);
	let p = parses('must-understand part', R.payload([R.record(T.TOPIC, [1, 0, 0, 0], R.textUTF8('s'), R.textUTF8('x'), mu), t]));
	check('must-understand part drops the post', p[0].dropped, 'must-understand');
	check('the next post survives', p[1].dropped, undefined);
	p = parses('must-understand in Bundle', R.payload([R.bundle(t, mu), t]));
	check('must-understand drops the Bundle', p[0].dropped, 'must-understand');
	check('the record after the Bundle survives', p[1].dropped, undefined);
	p = parses('must-understand in Signed', R.payload([R.signed(alice, fill(64, 0), t, mu)]));
	check('must-understand directly in Signed drops the Signed', p[0].dropped, 'must-understand');
	malformed('must-understand at top level drops the frame', R.payload([t, mu]));
	malformed('malformed after must-understand still drops the frame', R.payload([R.bundle(mu, R.record(0x2A))]));
	p = parses('prefix before must-understand', R.payload([R.bundle(R.fromCall('A'), mu)]));
	check('prefix before must-understand drops the Bundle', p[0].dropped, 'must-understand');
}

// ------------------------------------------------------------ posts

{
	const ts = 1763380000;
	let p = parses('topic', R.payload([R.topic(ts, 'Hello', R.textUTF8('World'))]));
	check('timestamp', p[0].timestamp, ts);
	check('unsigned post has no ID', p[0].id, null);
	p = parses('reply', R.payload([R.reply(ts, parentId, R.textUTF8('Hi'))]));
	check('reply parent', hex(p[0].parent), hex(parentId));
	p = parses('empty topic', R.payload([R.topic(ts, 'Nothing')]));
	check('topic without parts is dropped', p[0].dropped, 'empty');
	p = parses('empty reply', R.payload([R.reply(ts, parentId)]));
	check('reply without parts is dropped', p[0].dropped, 'empty');
	p = parses('mention-only post', R.payload([R.reply(ts, parentId, R.mention(fill(32, 1)), R.mention(fill(32, 2)))]));
	check('mention-only post is kept', p[0].dropped, undefined);
	check('two mentions', p[0].mentions.length, 2);
	p = parses('position-only post', R.payload([R.reply(ts, parentId, R.position({ lat: 525200000, lon: 134050000, time: 1763379990, alt: 34000, acc: 5 }))]));
	check('position latitude', p[0].position.lat, 525200000);
	check('position longitude', p[0].position.lon, 134050000);
	check('position altitude', p[0].position.alt, 34000);
	check('position accuracy', p[0].position.acc, 5);
	check('position fix time is its own value', p[0].position.time + ',' + p[0].timestamp, '1763379990,' + ts);
	p = parses('weather post', R.payload([R.reply(ts, parentId, R.temperature(-1234), R.humidity(10000),
		R.pressure(101325), R.wind({ direction: 35999, speed: 512, gust: 900 }), R.voltage(3700))]));
	const v = Object.fromEntries(p[0].parts.map((x) => [x.name, x]));
	check('temperature', v.TEMPERATURE.value, -1234);
	check('humidity', v.HUMIDITY.value, 10000);
	check('pressure', v.PRESSURE.value, 101325);
	check('wind', [v.WIND.direction, v.WIND.speed, v.WIND.gust].join(), '35999,512,900');
	check('voltage', v.VOLTAGE.value, 3700);
	p = parses('unknown optional part', R.payload([R.reply(ts, parentId, R.record(0x60, [1]))]));
	check('post with only an unknown optional part is kept', p[0].dropped, undefined);
	malformed('two text parts', R.payload([R.reply(ts, parentId, R.textUTF8('a'), R.textUTF8('b'))]));
	malformed('two texts of different types', R.payload([R.reply(ts, parentId, R.textUTF8('a'), R.textTable(0, [0x41]))]));
	malformed('same mention twice', R.payload([R.reply(ts, parentId, R.mention(fill(32, 1)), R.mention(fill(32, 1)))]));
	malformed('two positions', R.payload([R.reply(ts, parentId, R.position({ lat: 0, lon: 0, time: 1 }), R.position({ lat: 1, lon: 1, time: 2 }))]));
	malformed('two temperatures', R.payload([R.reply(ts, parentId, R.temperature(1), R.temperature(2))]));
	malformed('topic without subject', R.payload([R.record(T.TOPIC, [1, 0, 0, 0], R.temperature(1))]));
	malformed('topic without timestamp', R.payload([R.record(T.TOPIC, [1, 0])]));
	malformed('reply with short parent', R.payload([R.record(T.REPLY, [1, 0, 0, 0], fill(31, 0))]));
	malformed('core record inside a post', R.payload([R.reply(ts, parentId, R.textUTF8('a'), R.bundle())]));
	p = parses('bare media', R.payload([R.mention(fill(32, 1)), R.fromCall('A'), R.webp(fill(10, 1)),
		R.toCall('B'), R.mime('text/plain', 'a.txt', fill(3, 0x41)), R.codec2(8, fill(7, 0))]));
	check('bare media are kept as bare records', p.map((x) => x.bare).join(), 'true,true,true,true');
	check('prefix before bare WebP', p[1].chain[0].handle, 'A');
	malformed('bare Mention of 31 bytes', R.payload([R.record(T.MENTION, fill(31, 1))]));
	malformed('bare MIME with bad name', R.payload([R.record(T.MIME, [0x61, 0x2F, 0x62, 0, 0x2E, 0])]));
	malformed('Mention of 31 bytes', R.payload([R.reply(ts, parentId, R.record(T.MENTION, fill(31, 1)))]));
}

// --------------------------------------------------- values in range

{
	const bare = (rec) => R.payload([rec]);
	malformed('latitude above 90', bare(R.record(T.POSITION, [0x01, 0xE9, 0xA4, 0x35], fill(8, 0))));
	malformed('longitude below -180', bare(R.record(T.POSITION, [0, 0, 0, 0], [0xFF, 0x2D, 0xB6, 0x94], fill(4, 0))));
	parses('latitude exactly 90', bare(R.position({ lat: 900000000, lon: -1800000000, time: 0xFFFFFFFF })));
	malformed('Position of 10 bytes', bare(R.record(T.POSITION, fill(10, 0))));
	for (const n of [8, 14])
		malformed(`Position of ${n} bytes, the old lengths`, bare(R.record(T.POSITION, fill(n, 0))));
	throws('encode Position without fix time', () => R.position({ lat: 0, lon: 0 }));
	throws('encode negative fix time', () => R.position({ lat: 0, lon: 0, time: -1 }));
	const pos = parses('Position of 16 bytes', bare(R.position({ lat: 1, lon: 2, time: 3, alt: -4 })))[0];
	check('Position of 16 bytes', [pos.lat, pos.lon, pos.time, pos.alt, pos.acc].join(), '1,2,3,-4,');
	malformed('humidity above 100 %', bare(R.record(T.HUMIDITY, [0x11, 0x27])));
	malformed('wind direction 360', bare(R.record(T.WIND, [0xA0, 0x8C, 0, 0])));
	malformed('wind of 5 bytes', bare(R.record(T.WIND, fill(5, 0))));
	malformed('temperature of 3 bytes', bare(R.record(T.TEMPERATURE, fill(3, 0))));
	malformed('pressure of 2 bytes', bare(R.record(T.PRESSURE, fill(2, 0))));
	malformed('voltage of 1 byte', bare(R.record(T.VOLTAGE, [1])));
	throws('encode latitude 91', () => R.position({ lat: 910000000, lon: 0, time: 0 }));
	throws('encode accuracy without altitude', () => R.position({ lat: 0, lon: 0, time: 0, acc: 3 }));
	throws('encode humidity 10001', () => R.humidity(10001));
	throws('encode temperature 327.68', () => R.temperature(32768));
	check('encode temperature -327.68', hex(R.temperature(-32768)), '32020080');
	check('encode latitude -1', hex(R.position({ lat: -1, lon: 0, time: 0x01020304 })), '310cffffffff0000000004030201');
}

// ------------------------------------------------------------ MIME

{
	const post = (rec) => R.payload([R.reply(1, parentId, rec)]);
	const raw = (s) => R.record(T.MIME, Uint8Array.from(s, (c) => c.charCodeAt(0)));
	const p = parses('MIME escape', post(R.mime('application/pdf', 'manual.pdf', fill(5, 0x25))));
	check('MIME type', p[0].parts[0].mime, 'application/pdf');
	check('MIME file name', p[0].parts[0].fileName, 'manual.pdf');
	check('MIME content', p[0].parts[0].content.length, 5);
	parses('MIME with empty name', post(raw('audio/ogg\0\0data')));
	parses('MIME with symbols', post(raw('application/vnd.a+b-c_d$e!f#g&h^i\0x\0')));
	malformed('MIME upper case', post(raw('Text/plain\0a\0')));
	malformed('MIME with parameter', post(raw('text/plain;charset=utf-8\0a\0')));
	malformed('MIME without subtype', post(raw('text\0a\0')));
	malformed('MIME with two slashes', post(raw('a/b/c\0a\0')));
	malformed('MIME half of 128', post(raw('a/' + 'b'.repeat(128) + '\0x\0')));
	parses('MIME half of 127', post(raw('a/' + 'b'.repeat(127) + '\0x\0')));
	malformed('MIME type unterminated', post(raw('text/plain')));
	malformed('MIME name unterminated', post(raw('text/plain\0a.txt')));
	malformed('MIME name starting with dot', post(raw('text/plain\0.hidden\0')));
	malformed('MIME name with ..', post(raw('text/plain\0a..b\0')));
	malformed('MIME name with slash', post(raw('text/plain\0a/b\0')));
	malformed('MIME name upper case', post(raw('text/plain\0A.txt\0')));
	malformed('MIME name of 65', post(raw('text/plain\0' + 'a'.repeat(65) + '\0')));
	parses('MIME name of 64', post(raw('text/plain\0' + 'a'.repeat(64) + '\0')));
	throws('encode bad MIME name', () => R.mime('text/plain', '../etc', fill(1, 0)));
	const c = parses('Codec2', post(R.codec2(8, fill(438, 0x55))));
	check('Codec2 mode', c[0].parts[0].mode, 8);
	malformed('Codec2 without mode', post(R.record(T.CODEC2)));
}

// ------------------------------------------------ Signed and Keyed

{
	const t = R.topic(1, 's', R.textUTF8('x'));
	const good = R.signWith(fakeSign(alice), alice, t);
	const forged = R.signed(alice, fill(64, 0), t);
	let p = parses('Signed without verify', R.payload([forged]));
	check('Signed without CRYPTO is unverified', p[0].verified, null);
	check('Signed without CRYPTO is still parsed', p[0].children.length, 1);
	malformed('bad signature drops the frame', R.payload([forged, good]), { verify: fakeVerify });
	malformed('bad signature after a good one', R.payload([good, forged]), { verify: fakeVerify });
	malformed('bad inner signature under a good one', R.payload([R.signWith(fakeSign(group), group, forged)]), { verify: fakeVerify });
	p = parses('good signature', R.payload([good]), { verify: fakeVerify });
	check('good signature verifies', p[0].verified, true);

	const endorsed = R.signWith(fakeSign(group), group, good);
	p = parses('nested Signed', R.payload([endorsed]), { verify: fakeVerify });
	check('nested Signed: ID uses the innermost signer', hex(p[0].children[0].children[0].id), hex(R.postId(t, alice)));

	const id1 = parses('', R.payload([R.signWith(fakeSign(alice), alice, t)]))[0].children[0].id;
	const id2 = parses('', R.payload([R.signWith(fakeSign(alice), alice, R.bundle(R.toCall('B'), R.bundle(t)))]))[0].children[0].children[0].children[0].id;
	check('bundling and prefixes do not change the ID', hex(id1), hex(id2));
	check('signed and unsigned IDs differ', hex(R.postId(t, alice)) === hex(R.postId(t)), false);

	const sensor = R.reply(1763380000, parentId, R.temperature(2150), R.voltage(3300));
	const k = R.keyed(secret, sensor);
	p = parses('Keyed', R.payload([k]));
	check('Keyed tag verifies', R.verifyKeyed(p[0], secret), true);
	check('Keyed tag fails with another secret', R.verifyKeyed(p[0], fill(32, 1)), false);
	check('Keyed post ID is the unsigned one', hex(p[0].children[0].id), hex(R.postId(sensor)));
	check('Keyed tag is BLAKE2s-128 over CONTEXT, 0x02 and the records', hex(p[0].tag), hex(blake2s(R.concat(R.CONTEXT, [2], sensor), 16, secret)));
	p = parses('Keyed with two Replies', R.payload([R.keyed(secret, sensor, R.reply(2, parentId, R.voltage(3200)))]));
	check('Keyed with two Replies', p[0].children.length, 2);
	parses('unknown optional record in Keyed', R.payload([R.keyed(secret, sensor, R.record(0x37, [1]))]));
	p = parses('must-understand in Keyed', R.payload([R.keyed(secret, sensor, R.record(0xF1, [1]))]));
	check('must-understand in Keyed drops the Keyed', p[0].dropped, 'must-understand');
	malformed('Topic in Keyed', R.payload([R.keyed(secret, t)]));
	malformed('Bundle in Keyed', R.payload([R.keyed(secret, R.bundle(sensor))]));
	malformed('prefix in Keyed', R.payload([R.keyed(secret, R.fromCall('A'), R.record(0x37, [1]))]));
	malformed('Revoke in Keyed', R.payload([R.keyed(secret, R.revoke('retired'))]));
	malformed('Keyed inside Signed', R.payload([R.signed(alice, fill(64, 0), k)]));
	malformed('Signed inside Keyed', R.payload([R.keyed(secret, good)]));
	malformed('Keyed inside Keyed', R.payload([R.keyed(secret, k)]));
	malformed('bare record in Keyed', R.payload([R.keyed(secret, R.temperature(1))]));
	malformed('bare Avatar in Keyed', R.payload([R.keyed(secret, R.avatar(fill(4, 1)))]));
	malformed('request in Keyed', R.payload([R.keyed(secret, R.requestPost(parentId))]));
	malformed('Fragment in Keyed', R.payload([R.keyed(secret, R.fragment(fill(40, 0)))]));
	malformed('Fragment in Signed', R.payload([R.signed(alice, fill(64, 0), R.fragment(fill(40, 0)))]));
	malformed('Signed too short', R.payload([R.record(T.SIGNED, fill(95, 0))]));
	check('Signed limit', R.SIGNED_MAX, 8388594);
	const big = (n) => R.payload([R.signed(alice, fill(64, 0), R.record(0x37, fill(n - 5, 0)))]);
	check('records of the largest Signed', R.parse(big(R.SIGNED_MAX))[0].inner.length, R.SIGNED_MAX);
	malformed('Signed one byte too large', big(R.SIGNED_MAX + 1));
	malformed('Keyed too short', R.payload([R.record(T.KEYED, fill(15, 0))]));
	throws('Keyed secret must be 32 bytes', () => R.keyed(fill(16, 0), sensor));
}

// ------------------------------------------------------------ Avatar

{
	const pic = R.avatar(fill(20, 0x52));
	let p = parses('Avatar directly in Signed', R.payload([R.signed(alice, fill(64, 0), pic)]));
	check('Avatar directly in Signed belongs to the signer', hex(p[0].children[0].signer), hex(alice));
	p = parses('Avatar in a Bundle in Signed', R.payload([R.signed(alice, fill(64, 0), R.bundle(R.textUTF8('hi'), pic))]));
	check('Avatar in a Bundle in Signed belongs to the signer', hex(p[0].children[0].children[1].signer), hex(alice));
	p = parses('Avatar in nested Signed', R.payload([R.signed(group, fill(64, 0), R.signed(alice, fill(64, 0), pic))]));
	check('Avatar in nested Signed belongs to the innermost signer', hex(p[0].children[0].children[0].signer), hex(alice));
	p = parses('Avatar in a signed post', R.payload([R.signed(alice, fill(64, 0), R.reply(1, parentId, pic))]));
	check('Avatar as a post part', p[0].children[0].parts[0].type, T.AVATAR);
	check('signed post with an Avatar is kept', p[0].children[0].dropped, undefined);
	p = parses('unsigned Avatar', R.payload([pic]));
	check('unsigned Avatar has no signer', p[0].signer, null);
	check('unsigned Avatar is only logged', p[0].bare, true);
}

// ------------------------------------------------------------ Revoke

{
	let p = parses('Revoke in Signed', R.payload([R.signed(alice, fill(64, 0), R.revoke('compromised'))]));
	check('Revoke directly in Signed counts', p[0].children[0].effective, true);
	check('Revoke reason', p[0].children[0].reason, 'compromised');
	p = parses('Revoke in Bundle in Signed', R.payload([R.signed(alice, fill(64, 0), R.bundle(R.revoke('retired')))]));
	check('Revoke in a Bundle is ignored', p[0].children[0].children[0].effective, false);
	p = parses('bare Revoke', R.payload([R.revoke('retired')]));
	check('Revoke outside Signed is ignored', p[0].effective, false);
	check('Revoke-Retired is one byte', hex(R.revoke('retired')), '28');
	check('Revoke-Compromised is one byte', hex(R.revoke('compromised')), '29');
	p = parses('Revoke-Retired in Signed', R.payload([R.signed(alice, fill(64, 0), R.revoke('retired'))], 128));
	check('Revoke-Retired reason', p[0].children[0].reason, 'retired');
	check('Revoke-Retired directly in Signed counts', p[0].children[0].effective, true);
	p = parses('Revoke followed by a record', R.payload([R.signed(alice, fill(64, 0), R.revoke('retired'), R.revoke('compromised'), R.textUTF8('bye'))]));
	check('records after a Revoke', p[0].children.map((x) => x.name).join(), 'REVOKE_RETIRED,REVOKE_COMPROMISED,TEXT_UTF8');
	throws('encode unknown reason', () => R.revoke('bored'));
}

// --------------------------------------------- requests and fragments

{
	let p = parses('Request-Post', R.payload([R.requestPost(parentId)]));
	check('Request-Post ID', hex(p[0].id), hex(parentId));
	malformed('Request-Post cut short', bytes(T.REQUEST_POST, fill(31, 1)));
	malformed('Request-Post runs past Bundle', R.payload([R.bundle(bytes(T.REQUEST_POST, fill(16, 1)))]));
	p = parses('Request-Root 16', R.payload([R.requestRoot(1024, fill(16, 3))]));
	check('Request-Root needed', p[0].needed, 1024);
	check('Request-Root hash length', p[0].hlen, 16);
	check('Request-Root has no length byte', hex(R.requestRoot(1, fill(16, 3)).subarray(0, 4)), '27000003');
	p = parses('Request-Root 32', R.payload([R.requestRoot(5, fill(32, 3))]));
	check('Request-Root 32 hash length', p[0].hlen, 32);
	check('Request-Root 32 needed', p[0].needed, 5);
	malformed('Request-Root flag says 32, root is 16', bytes(T.REQUEST_ROOT, 0, 0x80, fill(16, 1)));
	malformed('Request-Root header cut short', bytes(T.REQUEST_ROOT, 0));
	malformed('Request-Root reserved bits', bytes(T.REQUEST_ROOT, 0, 0x04, fill(16, 1)));
	p = parses('records after Request-Root', R.payload([R.requestRoot(3, fill(16, 3)), R.requestRoot(4, fill(32, 4)), R.requestPost(parentId)]));
	check('records after Request-Root', p.map((x) => x.name).join(), 'REQUEST_ROOT,REQUEST_ROOT,REQUEST_POST');
	throws('encode Request-Root needing 0 blocks', () => R.requestRoot(0, fill(16, 0)));
	parses('signed request', R.payload([R.signed(alice, fill(64, 0), R.requestPost(parentId))]));

	// hash flag 0, height 10, K 10, index 513; payload 8, proof 10 × 16, root 16
	const head = (h) => [h & 255, h >> 8 & 255, h >> 16 & 255, h >>> 24];
	const fragBlock = (height, K, index, plen, flag = 0) =>
		R.concat(head((flag << 31 | (height - 1) << 26 | (K - 1) << 16 | index) >>> 0), fill(plen + (height + 1) * (flag ? 32 : 16), 0xAB));
	const block = fragBlock(10, 10, 513, 8);
	p = parses('Fragment', R.payload([R.fragment(block), R.textUTF8('shares the frame')]));
	check('Fragment height', p[0].height, 10);
	check('Fragment N', p[0].N, 1024);
	check('Fragment K', p[0].K, 10);
	check('Fragment index', p[0].index, 513);
	check('Fragment hash length', p[0].hlen, 16);
	check('Fragment root', hex(p[0].root), hex(fill(16, 0xAB)));
	check('Fragment without verifyBlock is unverified', p[0].verified, null);
	check('Fragment shares the frame', p[1].type, T.TEXT_UTF8);
	parses('Fragment in Bundle', R.payload([R.bundle(R.fragment(block))]));
	const reserved = block.slice();
	reserved[3] |= 0x40;
	malformed('Fragment reserved bit', R.payload([R.fragment(reserved)]));
	malformed('Fragment too short for proof', R.payload([R.fragment(block.subarray(0, 4 + 11 * 16))]));
	malformed('Fragment with 3 bytes of payload', R.payload([R.fragment(fragBlock(10, 10, 513, 3))]));
	parses('Fragment with 4 bytes of payload', R.payload([R.fragment(fragBlock(10, 10, 513, 4))]));
	malformed('Fragment with K > N', R.payload([R.fragment(fragBlock(3, 9, 0, 8))]));
	parses('Fragment with K = N', R.payload([R.fragment(fragBlock(3, 8, 7, 8))]));
	malformed('Fragment index N', R.payload([R.fragment(fragBlock(3, 8, 8, 8))]));
	parses('Fragment height 16, index 65535, 32-byte hashes', R.payload([R.fragment(fragBlock(16, 1024, 65535, 8, 1))]));
	parses('Fragment of 8192 bytes', R.payload([R.fragment(fragBlock(1, 1, 0, 8192 - 4 - 32))]));
	malformed('Fragment of 8193 bytes', R.payload([R.fragment(fragBlock(1, 1, 0, 8193 - 4 - 32))]));
	malformed('Fragment in a reassembled payload', R.payload([R.fragment(block)]), { reassembled: true });
	malformed('Fragment in a Bundle in a reassembled payload', R.payload([R.bundle(R.fragment(block))]), { reassembled: true });
	parses('reassembled payload without Fragments', R.payload([R.textUTF8('fine')]), { reassembled: true });
	malformed('Fragment failing verifyBlock', R.payload([R.textUTF8('a'), R.fragment(block)]), { verifyBlock: () => false });
	p = parses('Fragment passing verifyBlock', R.payload([R.fragment(block)]), { verifyBlock: (b) => b.length === block.length });
	check('Fragment passing verifyBlock is verified', p[0].verified, true);
	malformed('prefix before Fragment', R.payload([R.fromCall('A'), R.fragment(block)]));
}

// -------------------------------------------------------------- text

{
	const p = parses('texts', R.payload([R.bundle(R.textUTF8('Grüße'), R.textTable(19, [0x47, 0x72, 0xFC, 0xDF, 0x65]),
		R.textTable(200, [1]), R.textSCSU([0x41]), R.textGB18030([0xC4, 0xE3, 0xBA, 0xC3]))]));
	const t = p[0].children;
	check('UTF-8', R.decodeText(t[0]), 'Grüße');
	for (const s of ['\uFEFF', '\uFEFFHi', 'Hi\uFEFF'])
		check(`UTF-8 keeps U+FEFF in ${JSON.stringify(s)}`, R.decodeText(R.parse(R.textUTF8(s))[0]), s);
	check('windows-1252', R.decodeText(t[1]), 'Grüße');
	check('Text-Table index', t[1].table, 19);
	check('unknown table index', R.decodeText(t[2]), null);
	check('SCSU', R.decodeText(t[3]), 'A');
	check('GB 18030', R.decodeText(t[4]), '你好');
	check('table has 32 entries', R.TEXT_TABLE.length, 32);
	const subject = parses('Text-Table subject', R.payload([R.topic(1, R.textTable(13, [0xF0]), R.textUTF8('x'))]));
	check('KOI8-R subject', R.decodeText(subject[0].subject), 'П');
	// SCSU is always decoded: 0x0C is a reserved tag
	const scsuText = R.textSCSU([0x48, 0x69]);
	const s = R.parse(R.payload([scsuText]));
	check('SCSU decoded by parse', R.decodeText(s[0]), 'Hi');
	const badScsu = R.textSCSU([0x48, 0x0C]);
	malformed('invalid SCSU in a bare text', R.payload([badScsu]));
	malformed('invalid SCSU in a subject', R.payload([R.topic(1, badScsu, R.textUTF8('x'))]));
	malformed('invalid SCSU in a text part', R.payload([R.reply(1, fill(32, 7), badScsu)]));
	malformed('invalid SCSU in a handle', R.payload([R.fromName(badScsu), R.textUTF8('x')]));
	parses('SCSU name handle', R.payload([R.fromName(scsuText), R.textUTF8('x')]));
	check('SCSU limit', R.SCSU_MAX, 1048576);
	parses('SCSU of 2^20 bytes', R.payload([R.textSCSU(fill(R.SCSU_MAX, 0x41))]));
	malformed('SCSU of 2^20 + 1 bytes', R.payload([R.textSCSU(fill(R.SCSU_MAX + 1, 0x41))]));
	malformed('subject not a text record', R.payload([R.topic(1, R.textUTF8('s')).fill(0x32, 6, 7)]));
}

// ----------------------------------------------------- walk and padding

{
	const frame = R.payload([R.bundle(R.textUTF8('a'), R.bundle(R.textUTF8('b'))), R.textUTF8('c')], 64);
	const seen = [...R.walk(R.parse(frame))].map(([n, path]) => n.name + path.length).join(' ');
	check('walk order and depth', seen, 'BUNDLE0 TEXT_UTF81 BUNDLE1 TEXT_UTF82 TEXT_UTF80');
	throws('payload too big for its frame', () => R.payload([fill(10, 1)], 9));
	check('payload padded with zeros', hex(R.payload([R.textUTF8('a')], 5)), '4001610000');
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
