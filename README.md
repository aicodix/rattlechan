<p align="center"><img src="icon.svg" alt="A rattlesnake coiled round a board of notes, its rattle raised like an antenna" width="256"></p>

# Rattlechan

A message board that travels as sound. Ham, CB, PMR, a baby phone or a YouTube video: if it carries audio, it carries posts.

Rattlechan carries boards, direct messages, positions and sensor telemetry over the ROBUSTO OFDM modem. Posts are self-contained records, optionally split with [HYDRA](https://github.com/xdsopl/hydra) and signed with [CRYPTO](https://github.com/xdsopl/crypto). Keys are identity; call signs and names are labels.

## No encryption. Ever.

Every post is readable by anyone in range. Signatures prove who wrote a post without hiding what it says. Requests to add encryption will be closed without discussion.

## Status

Early. The protocol is a v0 draft in [SPEC.md](SPEC.md) and will change while the client is being written.

## Building blocks

* ROBUSTO, HYDRA and CRYPTO as WebAssembly modules, [SCSU](https://github.com/xdsopl/scsu) as a JavaScript module
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
* [robusto_encoder_44100.wasm](robusto_encoder_44100.wasm), [robusto_encoder_48000.wasm](robusto_encoder_48000.wasm), [robusto_decoder_44100.wasm](robusto_decoder_44100.wasm), [robusto_decoder_48000.wasm](robusto_decoder_48000.wasm): the ROBUSTO modules from the robusto branch of [aicodix/modem](https://github.com/aicodix/modem/tree/robusto), copied as they are from its `docs/temp/`: the decoders at commit a469d2e, the encoders at a4affe8
* [robusto.js](robusto.js): glue for the ROBUSTO modules: picking a mode, encoding frames and pings to audio, and a streaming decoder that turns samples into events
* [scsu.js](scsu.js): the [SCSU](https://github.com/xdsopl/scsu) JavaScript module, copied as it is from its `module/scsu.js` at commit c50f08c
* [scsu_test.mjs](scsu_test.mjs): round trips in 15 scripts, U+FEFF, invalid input and SCSU in posts, run with `node scsu_test.mjs`
* [encodings.js](encodings.js): encoders for GB 18030 and every Text-Table encoding, built from the browser's `TextDecoder`, and the smallest text record for a string
* [encodings_test.mjs](encodings_test.mjs): every character the decoders produce encodes back, and the smallest record decodes to the same text, run with `node encodings_test.mjs`
* [encodings_test.html](encodings_test.html): the same check in the browser, whose decoders are the reference; open it from `python3 -m http.server`
* [storage.js](storage.js): the station's storage on the Origin Private File System, or in memory: frames as received, one file each, in a precious and a logged tier with a byte budget each; revocations forever; data and secrets as JSON; deleting it all
* [storage_test.mjs](storage_test.mjs): the store in memory, run with `node storage_test.mjs`
* [storage_test.html](storage_test.html): the store on OPFS, export and import in the browser; open it from `python3 -m http.server`
* [tar.js](tar.js): writing and reading tar archives (ustar) in memory
* [tar_test.mjs](tar_test.mjs): round trips and a cross-check with the system's tar, run with `node tar_test.mjs`
* [archive.js](archive.js): export of the storage as .tar.gz, data and secrets in separate archives, and import that adds what is missing
* [archive_test.mjs](archive_test.mjs): export, import, merging and hostile archives, run with `node archive_test.mjs`
* [robusto_test.mjs](robusto_test.mjs): encoder to decoder in Node.js, every short mode, pings, noise and odd chunk sizes, run with `node robusto_test.mjs`
* [examples/session.mjs](examples/session.mjs): an evening on the air as one seamless WAV to try the GUI without a radio, with stations posting, replying, addressing each other, a picture, an avatar and Fragments; run `node examples/session.mjs out.wav` and play it or decode it in the Station tab. [dusk.webp](examples/dusk.webp) and [avatar.webp](examples/avatar.webp) are its pictures
* [examples/session_test.mjs](examples/session_test.mjs): the whole session through the decoder and a station, at both rates, run with `node examples/session_test.mjs`
* [examples/busy.mjs](examples/busy.mjs): a busy evening of ten stations as one seamless WAV, to fill the Inbox and the Boards: threads several levels deep on the board for everyone and on "contest", "weather" and "club", and direct conversations; import the private key 0808…08 ("08" 32 times) as Petr, OK1ABC, to see his inbox
* [examples/busy_test.mjs](examples/busy_test.mjs): the busy evening through the decoder, a station and the tree, seen as Petr, run with `node examples/busy_test.mjs`
* [examples/avatars/](examples/avatars/): the avatars of the busy evening, 128x128 WebP drawn with Pillow, four of them animated
* [station.js](station.js): what the station does with a received frame: parse, check signatures, reassemble Fragments, learn about keys, store in the tier trust puts it in, and replay the stored frames at startup
* [station_test.mjs](station_test.mjs): frames through the station into a store in memory, run with `node station_test.mjs`
* [tree.js](tree.js): the BBS tree: signed posts gathered into conversations, on boards, direct or elsewhere, and the ones for the station in its inbox
* [tree_test.mjs](tree_test.mjs): conversations, boards and the inbox from posts through a station, run with `node tree_test.mjs`
* [index.html](index.html), [app.js](app.js), [app.css](app.css), [render.js](render.js): the GUI: a log of everything received and sent, sending signed posts, the station's keys, and the station's settings, receiver and storage; serve the directory with `python3 -m http.server` and open it
* [render_test.mjs](render_test.mjs): what render.js does without a document, such as telling animated WebP apart and identicons, run with `node render_test.mjs`
* [sender.js](sender.js): sending: a post as records, addressed or for everyone, in one frame or as Fragments with extra blocks, only in modes that decode at the chosen SNR, chained into one seamless transmission
* [sender_test.mjs](sender_test.mjs): posts composed, split, chained and decoded again with the real modem and HYDRA, run with `node sender_test.mjs`
* [keys.js](keys.js): the station's own signing keys in the secrets: generated or imported, each with its label, From-Call, From-Name and both revocations
* [keys_test.mjs](keys_test.mjs): keys in a store in memory, their revocations, signing and the secrets archive, run with `node keys_test.mjs`
* [transmitter.js](transmitter.js): plays a transmission out of the default output
* [receiver.js](receiver.js), [capture_worklet.js](capture_worklet.js), [decoder_worker.js](decoder_worker.js): microphone to AudioWorklet to the ROBUSTO decoder in a worker, and decoding recordings
* [manifest.webmanifest](manifest.webmanifest), [sw.js](sw.js), [icon.svg](icon.svg), icon-180.png, icon-192.png, icon-512.png: what makes it an installable web app that works offline

## License

[0BSD](LICENSE)
