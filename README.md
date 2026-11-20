# Rattlechan

A message board that travels as sound. Ham, CB, PMR, a baby phone or a YouTube video: if it carries audio, it carries posts.

Rattlechan carries boards, direct messages, positions and sensor telemetry over the ROBUSTO OFDM modem. Posts are self-contained records, optionally split with [HYDRA](https://github.com/xdsopl/hydra) and signed with [CRYPTO](https://github.com/xdsopl/crypto). Keys are identity; call signs and names are labels.

## No encryption. Ever.

Every post is readable by anyone in range. Signatures prove who wrote a post without hiding what it says. Requests to add encryption will be closed without discussion.

## Status

Early. The protocol is a v0 draft in [SPEC.md](SPEC.md) and will change while the client is being written.

## Building blocks

* ROBUSTO, HYDRA, CRYPTO and [SCSU](https://github.com/xdsopl/scsu) as WebAssembly modules
* Everything else in plain JavaScript, without third-party libraries

## Files

* [SPEC.md](SPEC.md): the Rattlechan v0 protocol
* [blake2s.js](blake2s.js): BLAKE2s (RFC 7693) with keyed mode, output lengths 1 to 32 bytes and streaming
* [blake2s_test.mjs](blake2s_test.mjs): tests, run with `node blake2s_test.mjs`
* [records.js](records.js): record parser and encoder: prefixes, posts, Signed, Keyed, Bundle, post IDs and the error table
* [records_test.mjs](records_test.mjs): tests with hand-built frames, run with `node records_test.mjs`
* [wasm.js](wasm.js): loads the WebAssembly modules from a URL, a fetch Response, bytes or a compiled module
* [wasm_test.mjs](wasm_test.mjs): tests with a hand-written module, run with `node wasm_test.mjs`
* [crypto.wasm](crypto.wasm): the [CRYPTO](https://github.com/xdsopl/crypto) module, copied as it is from its `docs/crypto.wasm` at commit 2339005
* [crypto.js](crypto.js): glue for crypto.wasm: keys, signing, the `verify` callback for the parser and the two revocations of a key
* [crypto_test.mjs](crypto_test.mjs): tests with CRYPTO's known answers, run with `node crypto_test.mjs`
* [hydra.wasm](hydra.wasm): the [HYDRA](https://github.com/xdsopl/hydra) module, copied as it is from its `docs/hydra.wasm` at commit 87fa55a
* [hydra.js](hydra.js): glue for hydra.wasm: planning, encoding into Fragments, verifying, decoding, the relay check, and a reassembler that collects blocks and asks for missing ones with Request-Root
* [hydra_test.mjs](hydra_test.mjs): tests with HYDRA's planning table and a lossy channel, run with `node hydra_test.mjs`
* [robusto_encoder_44100.wasm](robusto_encoder_44100.wasm), [robusto_encoder_48000.wasm](robusto_encoder_48000.wasm), [robusto_decoder_44100.wasm](robusto_decoder_44100.wasm), [robusto_decoder_48000.wasm](robusto_decoder_48000.wasm): the ROBUSTO modules from the robusto branch of [aicodix/modem](https://github.com/aicodix/modem/tree/robusto), copied as they are from its `docs/temp/` at commit 63eb078
* [robusto.js](robusto.js): glue for the ROBUSTO modules: picking a mode, encoding frames and pings to audio, and a streaming decoder that turns samples into events
* [scsu.wasm](scsu.wasm): the [SCSU](https://github.com/xdsopl/scsu) module, copied as it is from its `docs/scsu.wasm` at commit 2f13b28
* [scsu.js](scsu.js): glue for scsu.wasm: encoding and decoding SCSU, and the decoder for the parser
* [scsu_test.mjs](scsu_test.mjs): round trips in 15 scripts, invalid input and SCSU in posts, run with `node scsu_test.mjs`
* [encodings.js](encodings.js): encoders for GB 18030 and every Text-Table encoding, built from the browser's `TextDecoder`, and the smallest text record for a string
* [encodings_test.mjs](encodings_test.mjs): every character the decoders produce encodes back, and the smallest record decodes to the same text, run with `node encodings_test.mjs`
* [encodings_test.html](encodings_test.html): the same check in the browser, whose decoders are the reference; open it from `python3 -m http.server`
* [robusto_test.mjs](robusto_test.mjs): encoder to decoder in Node.js, every short mode, pings, noise and odd chunk sizes, run with `node robusto_test.mjs`

## License

[0BSD](LICENSE)
