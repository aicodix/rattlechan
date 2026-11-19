// Tests for wasm.js. Run with: node wasm_test.mjs
// Uses a hand-written module exporting f() returning 42.

import { instantiate } from './wasm.js';

let checks = 0, failed = 0;

function check(name, got, want) {
	++checks;
	if (got !== want) {
		++failed;
		console.log('FAIL', name, '\n  got ', got, '\n  want', want);
	}
}

const bytes = Uint8Array.of(
	0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00, // magic, version
	0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7F, // type: () -> i32
	0x03, 0x02, 0x01, 0x00, // function 0 has type 0
	0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, // export "f" = function 0
	0x0A, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2A, 0x0B); // i32.const 42

const sources = {
	bytes,
	ArrayBuffer: bytes.buffer.slice(0),
	Module: new WebAssembly.Module(bytes),
	Response: new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } }),
	'Response with the wrong type': new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }),
};
for (const [name, source] of Object.entries(sources))
	check(`load from ${name}`, (await instantiate(source)).f(), 42);

for (const [name, source] of Object.entries({
	'a 404': new Response('not found', { status: 404 }),
	'no module': Uint8Array.of(1, 2, 3),
})) {
	let threw = false;
	try {
		await instantiate(source);
	} catch {
		threw = true;
	}
	check(`${name} does not load`, threw, true);
}

console.log(failed ? `${failed} of ${checks} checks failed` : `all ${checks} checks passed`);
if (failed)
	process.exit(1);
