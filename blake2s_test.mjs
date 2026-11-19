// Tests for blake2s.js. Run with: node blake2s_test.mjs
// Message bytes are i & 255 for i < length, key bytes are 0, 1, 2, ...
// Expected values from an independent BLAKE2s implementation.

import { BLAKE2s, blake2s } from './blake2s.js';

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
const seq = (n) => Uint8Array.from({ length: n }, (_, i) => i & 255);
let failed = 0;
function check(name, got, want) {
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

// RFC 7693, Appendix B
check('RFC 7693 "abc"', hex(blake2s(new TextEncoder().encode('abc'))),
	'508c5e8c327c14e2e1a72ba34eeb452f37458b209ed63a294d999b4c86675982');

// BLAKE2s-128 is not a truncated BLAKE2s-256
check('128 != truncated 256', hex(blake2s(seq(3), 16)) === hex(blake2s(seq(3))).slice(0, 32) ? 'same' : 'different', 'different');

// [outlen, keylen, message length, expected]
const vectors = [
	[32, 0, 0, '69217a3079908094e11121d042354a7c1f55b6482ca1a51e1b250dfd1ed0eef9'],
	[32, 0, 1, 'e34d74dbaf4ff4c6abd871cc220451d2ea2648846c7757fbaac82fe51ad64bea'],
	[32, 0, 3, 'e8f91c6ef232a041452ab0e149070cdd7dd1769e75b3a5921be37876c45c9900'],
	[32, 0, 63, 'e57cb79487dd57902432b250733813bd96a84efce59f650fac26e6696aefafc3'],
	[32, 0, 64, '56f34e8b96557e90c1f24b52d0c89d51086acf1b00f634cf1dde9233b8eaaa3e'],
	[32, 0, 65, '1b53ee94aaf34e4b159d48de352c7f0661d0a40edff95a0b1639b4090e974472'],
	[32, 0, 127, 'f18417b39d617ab1c18fdf91ebd0fc6d5516bb34cf39364037bce81fa04cecb1'],
	[32, 0, 128, '1fa877de67259d19863a2a34bcc6962a2b25fcbf5cbecd7ede8f1fa36688a796'],
	[32, 0, 129, '5bd169e67c82c2c2e98ef7008bdf261f2ddf30b1c00f9e7f275bb3e8a28dc9a2'],
	[32, 0, 255, 'f03f5789d3336b80d002d59fdf918bdb775b00956ed5528e86aa994acb38fe2d'],
	[32, 0, 256, '5fdeb59f681d975f52c8e69c5502e02a12a3afcc5836ba58f42784c439228781'],
	[32, 0, 1000, 'b5f9d7799111edafc9326fbf667be98140b5e20ce5e151793c59125bf654ac18'],
	[32, 1, 0, 'cdcf93dac5437c31bf1e79a8398fbbddd1cef4427428ced165264455a9c48a95'],
	[32, 1, 1, 'fb57ef20436af865a740fc621af8840ef2eef20f6d36d364ccd2a8aa6c88c593'],
	[32, 1, 3, '8fff22b9f6bc5d1f821b877d21e9351db46ebdfb9c3677a5b55f7f50f8cb90a2'],
	[32, 1, 63, '28e6458ded9053682e04d45cd46e2728469ab1699beee82af0d3fc465aec1404'],
	[32, 1, 64, 'efc5e532e4815e7bcc9fc9a685a7b5745cd2cfbc04d37c3442363eb2ca42d0c0'],
	[32, 1, 65, '3ab120e202c7ce80d8e4bd275fcc8cac55198b21840561ff5232c6867b336ec5'],
	[32, 1, 127, 'db338c74eb56874fea232e3087623b1a17652a6805b80a977150dd78759337e1'],
	[32, 1, 128, '1b3f705bac4e4646c49ba9416708cd47b0ad22cb05224bc4a7265b431db16394'],
	[32, 1, 129, '3e5d8a82b97d9e2fb4f91a64fa3d16907f5d2111214aeb5ad6e060538000b0cc'],
	[32, 1, 255, '57570b66f743f05d9ee800ee467e819b671f2466a047fae445bf53f6b0954d28'],
	[32, 1, 256, '03220db51373d4694dfd701a12e9e5287b099f158a190ab22ce596f7843886d9'],
	[32, 1, 1000, 'bb2fa00ed9295f0f9a0e0c99b1505063b6b3c629adb722335266d5771584b93f'],
	[32, 32, 0, '48a8997da407876b3d79c0d92325ad3b89cbb754d86ab71aee047ad345fd2c49'],
	[32, 32, 1, '40d15fee7c328830166ac3f918650f807e7e01e177258cdc0a39b11f598066f1'],
	[32, 32, 3, '1d220dbe2ee134661fdf6d9e74b41704710556f2f6e5a091b227697445dbea6b'],
	[32, 32, 63, 'c65382513f07460da39833cb666c5ed82e61b9e998f4b0c4287cee56c3cc9bcd'],
	[32, 32, 64, '8975b0577fd35566d750b362b0897a26c399136df07bababbde6203ff2954ed4'],
	[32, 32, 65, '21fe0ceb0052be7fb0f004187cacd7de67fa6eb0938d927677f2398c132317a8'],
	[32, 32, 127, 'ddbfea75cc467882eb3483ce5e2e756a4f4701b76b445519e89f22d60fa86e06'],
	[32, 32, 128, '0c311f38c35a4fb90d651c289d486856cd1413df9b0677f53ece2cd9e477c60a'],
	[32, 32, 129, '46a73a8dd3e70f59d3942c01df599def783c9da82fd83222cd662b53dce7dbdf'],
	[32, 32, 255, '3fb735061abc519dfe979e54c1ee5bfad0a9d858b3315bad34bde999efd724dd'],
	[32, 32, 256, '5211d1aefc0025be7f85c06b3e14e0fc645ae12bd41746485ea6d8a364a2eaee'],
	[32, 32, 1000, '5754feae2a6eefffae7d7c689f2405d1ec46c7e48a9c6187e71c5421a757b95d'],
	[16, 0, 0, '64550d6ffe2c0a01a14aba1eade0200c'],
	[16, 0, 1, '9f31f3ec588c6064a8e1f9051aeab90a'],
	[16, 0, 3, 'c41561edb251df8f3c9523524d60a707'],
	[16, 0, 63, '4006430a2d313751a9ece24fccb52de5'],
	[16, 0, 64, 'dc66ca8f03865801b0ffe06ed8a1a90e'],
	[16, 0, 65, '399d3e92ccfcedcdde9bf4c2be14cf8c'],
	[16, 0, 127, '5d3541be0ce9b6d8f9315862ac0198c5'],
	[16, 0, 128, '7a3b3fa888b60095e7b305efcf3c3dbc'],
	[16, 0, 129, 'dd6146fb0f48a29aa4c813fe75d15941'],
	[16, 0, 255, 'b504e782a6ba7a75eca305c265cf3633'],
	[16, 0, 256, 'f34aabb6e38ab8c17272d90d82e9f56d'],
	[16, 0, 1000, '0b94973a96dc199cfbc1ec1e06615c99'],
	[16, 1, 0, '01d7f4cea32638032b156c74aec7e87a'],
	[16, 1, 1, '80b5875420d43af8816136f8a9ad90ce'],
	[16, 1, 3, '2dc274d52c2abc1db926bcb9e565636c'],
	[16, 1, 63, '0d17d154c1c5854e73326d928a1105ce'],
	[16, 1, 64, '2ba2b6488a75dba441264fb7e2aec115'],
	[16, 1, 65, '0fa18e1c3172182230710a4d6bc7b7c4'],
	[16, 1, 127, '6fc6dfe65c7fcc55454870007b6b43b6'],
	[16, 1, 128, '7a98059d4f84767322a894e040e8b284'],
	[16, 1, 129, 'ff5ac60aeb64b7ff754bb16af1543f07'],
	[16, 1, 255, 'a0dc2a83a1ad9a9179db4a0bd4cbaa82'],
	[16, 1, 256, 'd80a8ccd2403ee69c3193d7c3dcefa12'],
	[16, 1, 1000, '689357381c8c63acc1c0de9e5c5f2380'],
	[16, 32, 0, '9536f9b267655743dee97b8a670f9f53'],
	[16, 32, 1, '13bacfb85b48a1223c595f8c1e7e82cb'],
	[16, 32, 3, '1e2a79436a7796a3e9826bfedf07659f'],
	[16, 32, 63, 'ece382a8bd5018f1de5da44b72cea75b'],
	[16, 32, 64, 'f1efa90d2547036841ecd3627fafbc36'],
	[16, 32, 65, '811ff8686d23a435ecbd0bdafcd27b1b'],
	[16, 32, 127, '25887fab1422700d7fa3edc0b20206e2'],
	[16, 32, 128, '8c09f698d03eaf88abf69f8147865ef6'],
	[16, 32, 129, '5c363ae42a5bec26fbc5e996428d9bd7'],
	[16, 32, 255, 'cd075928ab7e6883e697fe7fd3ac43ee'],
	[16, 32, 256, 'd5a40ec316c751a63cd0d91157fa1ebb'],
	[16, 32, 1000, 'f69872b03760f95ddfb897eede223884'],
	[20, 0, 0, '354c9c33f735962418bdacb9479873429c34916f'],
	[20, 0, 1, '63a5f3dba42c1ee9ce4147c1b22e0b61f4c7a17a'],
	[20, 0, 3, '5f70714603428963abe2ea507c1d0a7c3d67a8e4'],
	[20, 0, 63, '3d0034e3e070ced4c8555cc592d019af6155b086'],
	[20, 0, 64, '68c18b80dd398444aa9fd4272ecfa8e71b31ee8a'],
	[20, 0, 65, '20eb8eee0c703a44779298f35f92da38f2b4f0bf'],
	[20, 0, 127, 'b326e5f0e03512e436f31111df9c378dca2b3171'],
	[20, 0, 128, 'fb7b50db11a7a2acecf57aa08636df85eeaac736'],
	[20, 0, 129, '844da1b7c83cef2f35fc1433c5990161e3202c9d'],
	[20, 0, 255, '2163455c5083ae10c0b7e9ca01e57d633e5c9e6e'],
	[20, 0, 256, 'aa569bdc981775f2b36883b79b8d48b19b2d3505'],
	[20, 0, 1000, '7c2903d249c2322fd291fd704a42290e524f7df9'],
	[20, 1, 0, '04c860e9f64bdd5e826b5f167f1cc7db4c7ae1d8'],
	[20, 1, 1, '8a71ff78f882b9eed9bc297204c15f11c2940c5e'],
	[20, 1, 3, '4946852a2020bdfd855e2f2d0a4f86ada43e6e9e'],
	[20, 1, 63, 'ddeb486dffabf28553ff81729a7a6d4e0ce7ac8e'],
	[20, 1, 64, '9e0827581f4e302b28df04f3c7b94cb7c4b6f26a'],
	[20, 1, 65, '12fa74c9fc04bc9a4f3c456450bd7ee7b7fea518'],
	[20, 1, 127, '4439bd7cd5a1147c385346e79829395dd8a0b44c'],
	[20, 1, 128, '6179765fa1755b54196e9f8196b18dfc8aeb5efc'],
	[20, 1, 129, '02c14973a70cff65da48547c986548f42157b657'],
	[20, 1, 255, 'a26c867e66aa26134f12f95b5bdd057cbafe69bf'],
	[20, 1, 256, 'bed2985f728cb166af992d3f9c634f5ade8bce48'],
	[20, 1, 1000, 'f181eaf9de9a8ceb7b615a1ef533a4a12a179449'],
	[20, 32, 0, 'c41184ef12da66770f3a991e9cb2c14896871af7'],
	[20, 32, 1, '1c2bcd9a68ca8c7190296c54fa564aefa23a569c'],
	[20, 32, 3, 'dab00b20ec5fb7db1a075503f0ea3034c632ae23'],
	[20, 32, 63, '55d315d4c160e1765a327e87a65c0e45fe15102f'],
	[20, 32, 64, 'f6d22f26bf98c4657d06282601ad77a5dd05b9e3'],
	[20, 32, 65, '71aedfb599d91a5f8a9eb5f9a4faaa8913ea3e55'],
	[20, 32, 127, '30e20660a838a8f250909c9c39242f3aba70e95a'],
	[20, 32, 128, '9a9f21e73c78aad8bec8ddf655ab27fbc703eda0'],
	[20, 32, 129, 'a185adf48822842ce649adc04ef5f7bdcfc8e36c'],
	[20, 32, 255, '9ba27b121849bb7d2a436e71d081b07ae8a95356'],
	[20, 32, 256, '1dc2b11c0f2da73eac1eb906d373dde427963fd9'],
	[20, 32, 1000, '97fa30fb020a79e2f70fcd9efef507f2f9bbb18e'],
	[1, 0, 0, 'a1'],
	[1, 0, 1, 'b6'],
	[1, 0, 3, '69'],
	[1, 0, 63, 'f8'],
	[1, 0, 64, '9b'],
	[1, 0, 65, 'b1'],
	[1, 0, 127, '0d'],
	[1, 0, 128, '78'],
	[1, 0, 129, 'fa'],
	[1, 0, 255, '5c'],
	[1, 0, 256, '29'],
	[1, 0, 1000, '98'],
	[1, 1, 0, '4b'],
	[1, 1, 1, '95'],
	[1, 1, 3, 'b5'],
	[1, 1, 63, '1c'],
	[1, 1, 64, 'd3'],
	[1, 1, 65, '4d'],
	[1, 1, 127, '33'],
	[1, 1, 128, '01'],
	[1, 1, 129, '9d'],
	[1, 1, 255, '08'],
	[1, 1, 256, '1d'],
	[1, 1, 1000, '0d'],
	[1, 32, 0, '3a'],
	[1, 32, 1, 'fa'],
	[1, 32, 3, 'fd'],
	[1, 32, 63, 'cc'],
	[1, 32, 64, '56'],
	[1, 32, 65, 'c6'],
	[1, 32, 127, 'be'],
	[1, 32, 128, '17'],
	[1, 32, 129, 'ad'],
	[1, 32, 255, '18'],
	[1, 32, 256, '1a'],
	[1, 32, 1000, '51']
];

for (const [outlen, keylen, len, want] of vectors) {
	const msg = seq(len), key = seq(keylen);
	const name = `outlen ${outlen} key ${keylen} len ${len}`;
	check(name, hex(blake2s(msg, outlen, key)), want);
	// same input fed in uneven chunks
	for (const step of [1, 7, 64, 65]) {
		const h = new BLAKE2s(outlen, key);
		for (let i = 0; i < len; i += step)
			h.update(msg.subarray(i, i + step));
		check(`${name} chunks of ${step}`, hex(h.digest()), want);
	}
}

for (const bad of [0, 33])
	try { new BLAKE2s(bad); ++failed; console.log('FAIL outlen', bad, 'accepted'); } catch {}
try { new BLAKE2s(32, seq(33)); ++failed; console.log('FAIL 33-byte key accepted'); } catch {}

console.log(failed ? `${failed} failed` : `all ${vectors.length * 5 + 5} checks passed`);
if (failed)
	process.exit(1);
