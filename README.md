<p align="center"><img src="icon.svg" alt="A rattlesnake coiled round a board of notes, its rattle raised like an antenna" width="256"></p>

# Rattlechan

A message board that travels as sound. Ham, CB, PMR, a baby phone or a YouTube video: if it carries audio, it carries posts.

Rattlechan carries boards, direct messages, positions and sensor telemetry over the ROBUSTO OFDM modem. Posts are self-contained records, optionally split with [HYDRA](https://github.com/xdsopl/hydra) and signed with [CRYPTO](https://github.com/xdsopl/crypto). Keys are identity; call signs and names are labels.

**Try it: [aicodix.github.io/rattlechan](https://aicodix.github.io/rattlechan/).** Open it once while online; from then on it works offline, and you can add it to your home screen.

## For first responders

Rattlechan is for the day nothing else works. Get it ready while everything still does.

### Before you need it

1. Open [aicodix.github.io/rattlechan](https://aicodix.github.io/rattlechan/) while online, on every phone that may need it.
2. Install it. On Android, in Chrome: Install, in the menu or in the Station tab. On an iPhone or iPad, in Safari: Share, then Add to Home Screen. On iOS this matters most: Safari may delete the data of a web app that isn't on the Home Screen after a week without use. The Station tab shows whether storage is persistent.
3. In Station, under Keys, add a key with your call sign or name. Every post is signed with a key.
4. Export secrets and keep the archive off the phone. Print the revocations of each key and keep them apart from the phone: if the phone is lost, sending a revocation tells everyone to stop trusting that key.
5. Try it with your radio. Hold the phone to the radio, or use a cable, and key the radio with VOX or by holding push-to-talk. In Station, set the output level, and the leading noise for a VOX that needs time to key up; Test plays that noise. Then send a post to a second phone listening on a second radio.

### In the field

* Photo, in Compose, takes a picture and collects it as a post right away, signed with your key, with the subject you typed or the time. Collect does the same for a written post.
* Collected posts wait in the Outbox, even across reloads. Whoever is at the radio sends them all at once with Send all. Take the pictures, then hand the phone over.
* Photos are shrunk to about 30 KiB and lose their metadata and GPS position on the way.
* Compose shows the size and airtime of a post before you send it.
* Listen, in Station, receives. Posts show in Inbox and Boards. The screen stays on while the app is open, as most phones stop the microphone once it goes dark; under the receiver, Station says whether the phone lets it, and why not.
* If the receiver says there is no audio, or the phone was in the background, tap Listen again: it always starts over. Stop stops listening and anything going out.
* Pictures go as they are: PNG, JPEG, GIF or WebP. So do Codec2 (.c2) and Opus (.opus) recordings: Opus plays in the app when you tap Play, Codec2 is saved and played with Codec2's own tools or FFmpeg for now.
* A station that missed part of a long post can still get it: Send again, on the post, sends new pieces of it, and any of them help. This works for anyone's post, so a station in range of both can pass it on.
* Trust the keys of your team in the log, so their posts are kept and their pictures shown.
* Export data now and then.

Everything you send can be read by anyone in range, so leave out what shouldn't be public, such as a patient's name.

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
* [records.js](records.js): record parser and encoder: prefixes, posts, Signed, Keyed, Bundle, post IDs and the error table; Codec2 and Opus told apart by their first bytes
* [records_test.mjs](records_test.mjs): tests with hand-built frames, run with `node records_test.mjs`
* [wasm.js](wasm.js): loads the WebAssembly modules from a URL, a fetch Response, bytes or a compiled module
* [wasm_test.mjs](wasm_test.mjs): tests with a hand-written module, run with `node wasm_test.mjs`
* [crypto.wasm](crypto.wasm): the [CRYPTO](https://github.com/xdsopl/crypto) module, copied as it is from its `docs/crypto.wasm` at commit 2339005
* [crypto.js](crypto.js): glue for crypto.wasm: keys, signing, the `verify` callback for the parser and the two revocations of a key
* [crypto_test.mjs](crypto_test.mjs): tests with CRYPTO's known answers, run with `node crypto_test.mjs`
* [hydra.wasm](hydra.wasm): the [HYDRA](https://github.com/xdsopl/hydra) module, copied as it is from its `docs/hydra.wasm` at commit 87fa55a
* [hydra.js](hydra.js): glue for hydra.wasm: planning, encoding into Fragments, verifying, decoding, the relay check, random block indices, and a reassembler that collects blocks and asks for missing ones with Request-Root
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
* [examples/pictures/](examples/pictures/): small PNG, JPEG, GIF and WebP test pictures, still and animated, made with Pillow
* [examples/audio/](examples/audio/): two seconds of a tone as Codec2 700C (.c2) and as Opus in Ogg (.opus), made with FFmpeg, for the tests
* [station.js](station.js): what the station does with a received frame: parse, check signatures, reassemble Fragments, learn about keys, store in the tier trust puts it in, and replay the stored frames at startup; and new blocks of a decoded post, to send it again
* [station_test.mjs](station_test.mjs): frames through the station into a store in memory, run with `node station_test.mjs`
* [tree.js](tree.js): the BBS tree: signed posts gathered into conversations, on boards, direct or elsewhere, and the ones for the station in its inbox
* [tree_test.mjs](tree_test.mjs): conversations, boards and the inbox from posts through a station, run with `node tree_test.mjs`
* [index.html](index.html), [app.js](app.js), [app.css](app.css), [render.js](render.js): the GUI: a log of everything received and sent, sending signed posts, the station's keys, and the station's settings, receiver and storage; serve the directory with `python3 -m http.server` and open it
* [render_test.mjs](render_test.mjs): what render.js does without a document, such as telling animated WebP apart and identicons, run with `node render_test.mjs`
* [pictures.js](pictures.js): PNG, JPEG, GIF and WebP told by their first bytes, with their size and whether they move, read from the headers without decoding
* [pictures_test.mjs](pictures_test.mjs): the test pictures and hand-made headers, run with `node pictures_test.mjs`
* [sender.js](sender.js): sending: a post as records, addressed or for everyone, with attached files (pictures and audio as they are), in one frame or as Fragments with extra blocks at random indices, only in modes that decode at the chosen SNR, chained into one seamless transmission
* [sender_test.mjs](sender_test.mjs): posts composed, split, chained and decoded again with the real modem and HYDRA, run with `node sender_test.mjs`
* [keys.js](keys.js): the station's own signing keys in the secrets: generated or imported, each with its label, From-Call, From-Name and both revocations
* [keys_test.mjs](keys_test.mjs): keys in a store in memory, their revocations, signing and the secrets archive, run with `node keys_test.mjs`
* [transmitter.js](transmitter.js): plays a transmission out of the default output, through the receiver's audio while listening and a fresh one otherwise, opened right in the tap, as iOS needs
* [receiver.js](receiver.js), [capture_worklet.js](capture_worklet.js), [decoder_worker.js](decoder_worker.js): microphone to AudioWorklet to the ROBUSTO decoder in a worker, and decoding recordings; never waits on the audio system, which can hang on iOS
* [version.js](version.js), [version.mjs](version.mjs): which version runs: a fingerprint of the app's files, shown under About; `node version.mjs` prints it for a checkout, `node version.mjs 67dbec43` finds the commits that have it
* [version_test.mjs](version_test.mjs): the fingerprint, and the checkout's the same as the script's, run with `node version_test.mjs`
* [manifest.webmanifest](manifest.webmanifest), [sw.js](sw.js), [icon.svg](icon.svg), icon-180.png, icon-192.png, icon-512.png: what makes it an installable web app that works offline
* [sw_test.mjs](sw_test.mjs): every file the page and its modules load is in the service worker's list, run with `node sw_test.mjs`

## License

[0BSD](LICENSE)
