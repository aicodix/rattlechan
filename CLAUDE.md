# Rattlechan

A message board that travels as sound. The protocol is in SPEC.md (v0 draft, still changing).

## Rules

- No third-party libraries. Plain JavaScript (ES modules) plus the ROBUSTO, HYDRA and CRYPTO WebAssembly modules and the SCSU JavaScript module, copied in as they are.
- Never add encryption or anything that hides content. Signatures and MACs are fine.
- Little-endian everywhere.
- Tabs for indentation.
- SPEC.md is the source of truth: when code changes the protocol, update SPEC.md in the same commit.
- When something is unclear, ask instead of guessing. That includes gaps in SPEC.md: ask before deciding them in code.
- Every module gets a test file `<name>_test.mjs`, run with `node <name>_test.mjs`, no test framework.
- License: 0BSD.

## Commit messages

Match the existing history:

- A short lowercase subject, no trailing period, under about 60 characters, saying what changed. Example: `moved block count computation out of encode function`.
- No body unless the reason is not obvious from the diff.
- No Co-Authored-By, Claude-Session or other trailers, and no links.
- Claude commits as `Claude <noreply@anthropic.com>`. Never use the maintainer's name or email.

## Next step

Done: records.js parses and encodes records (type classes, lengths, prefix chains and the ordering rule, Bundle, posts, value checks, the error table, post IDs, Keyed tags). records_test.mjs covers it with hand-built frames. crypto.js wraps crypto.wasm (copied from CRYPTO's docs/crypto.wasm at 2339005): keys, signing, the `verify` callback for the parser and revocations. crypto_test.mjs checks CRYPTO's known answers. hydra.js wraps hydra.wasm (copied from HYDRA's docs/hydra.wasm at 87fa55a): planning, encoding, `verifyBlock` for the parser, decoding, the relay check, and a Reassembler that collects blocks and makes Request-Root records. robusto.js wraps the four ROBUSTO modules (copied from aicodix/modem's robusto branch, docs/temp/ at 63eb078): `loadEncoder(rate)` picks modes and turns payloads and pings into audio, `loadDecoder(rate)` turns samples into events (sync, meta, ping, frame, error). scsu.js is SCSU's JavaScript module (copied from its module/scsu.js at c50f08c): `encode` and `decode`, used by the parser and by encodings.js, which builds encoders for GB 18030 and the Text-Table encodings from `TextDecoder` and picks the smallest text record with `smallestText(str)`. `TextDecoder` gets `ignoreBOM` for UTF-8 and UTF-16, so a U+FEFF stays text (only there: Node 22 drops a leading 0xFF in windows-1252 with it). Browsers (WHATWG) are the reference decoders; Node's ICU differs for IBM866, KOI8-U, windows-1255, Big5, Shift_JIS and EUC-KR and lacks ISO-8859-16, so encodings_test.html checks the encoders in the browser. wasm.js loads all modules. storage.js keeps the station's files on OPFS (or in memory for Node): precious/ and logged/ hold one file per frame named <kept>_<arrival>_<call sign>_<mode>.bin, each tier with its own byte budget (default 100 MiB) that evicts the oldest kept time first, so spam in the logged tier never evicts precious frames; touch() renews avatars, promote() and demote() move frames between tiers; the caller picks the tier (SPEC.md, Client policy); revocations/ forever, only for trusted keys; data/ and secrets/ as JSON. archive.js exports .tar.gz (tar.js, CompressionStream): data and secrets in separate archives; import only adds what is missing. Exported archives can pre-populate the GUI for testing.

The GUI is a PWA served from 127.0.0.1:8080 by `python3 -m http.server`, so modules load over fetch; `loadCrypto()`, `loadHydra()`, `loadEncoder(rate)` and `loadDecoder(rate)` without a source fetch their .wasm next to their .js. The page loads the ROBUSTO modules for `AudioContext.sampleRate` (44100 or 48000).

For the GUI: Safari grants persistent storage (`navigator.storage.persist()`) only to web apps added to the Home Screen or Dock; for an ordinary website it may delete everything a script stored after 7 days without use. So the GUI shows whether storage is persistent next to usage and quota, suggests installing the app when it isn't, and shows when the last export was made, since exports are the backup either way. The maintainer runs encodings_test.html and storage_test.html in Chrome and Safari; both passed there.

The GUI so far receives: index.html with app.js, render.js and app.css, phone first, with tabs at the bottom (Log and Station; Boards and Inbox come once there is something to put in them). receiver.js runs microphone -> capture_worklet.js -> decoder_worker.js (ROBUSTO off the main thread) and decodes recordings the same way; station.js parses, checks signatures, reassembles Fragments, stores (all in the logged tier until trust lists exist; malformed frames are shown but never stored) and replays the store at startup. The transmitter is keyed by VOX only. sw.js caches network first, so it works offline once opened. Received pictures are only drawn when asked for.

Next: to be decided with the maintainer (sending, keys and trust lists, boards and inbox).
