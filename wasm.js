// Loading the WebAssembly modules, in browsers (and as a PWA) and in Node.js.

// source: a URL or string (fetched), a fetch Response, bytes (ArrayBuffer or
// typed array) or a compiled WebAssembly.Module. Returns the exports.
export async function instantiate(source) {
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
