// Loading the WebAssembly modules, in browsers (and as a PWA) and in Node.js.

// whether the browser runs 128-bit SIMD, which all the modules use: a module
// whose one function has a v128 local
export const simd = WebAssembly.validate(Uint8Array.of(
	0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00, // magic, version
	0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type: () -> ()
	0x03, 0x02, 0x01, 0x00, // function 0 has type 0
	0x0A, 0x06, 0x01, 0x04, 0x01, 0x01, 0x7B, 0x0B)); // one v128 local

// source: a URL or string (fetched), a fetch Response, bytes (ArrayBuffer or
// typed array) or a compiled WebAssembly.Module. Returns the exports.
export async function instantiate(source) {
	try {
		return await load(source);
	} catch (err) {
		if (!simd && err instanceof WebAssembly.CompileError)
			throw new Error('this browser lacks WebAssembly SIMD');
		throw err;
	}
}

async function load(source) {
	if (typeof source === 'string' || source instanceof URL)
		source = await fetch(source);
	if (source instanceof WebAssembly.Module)
		return (await WebAssembly.instantiate(source)).exports;
	if (typeof Response !== 'undefined' && source instanceof Response) {
		if (!source.ok)
			throw new Error(`loading ${source.url || 'module'} failed: ${source.status} ${source.statusText}`);
		try {
			// needs the server to send application/wasm
			return (await WebAssembly.instantiateStreaming(source.clone())).instance.exports;
		} catch {
			return (await WebAssembly.instantiate(await source.arrayBuffer())).instance.exports;
		}
	}
	return (await WebAssembly.instantiate(source)).instance.exports;
}
