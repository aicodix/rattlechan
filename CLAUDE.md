# Rattlechan

A message board that travels as sound. The protocol is in SPEC.md (v0 draft, still changing).

## Rules

- No third-party libraries. Plain JavaScript (ES modules) plus the ROBUSTO, HYDRA, CRYPTO and SCSU WebAssembly modules, copied in as they are.
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

Done: records.js parses and encodes records (type classes, lengths, prefix chains and the ordering rule, Bundle, posts, value checks, the error table, post IDs, Keyed tags). records_test.mjs covers it with hand-built frames. crypto.js wraps crypto.wasm (copied from CRYPTO's docs/crypto.wasm at 2339005): keys, signing, the `verify` callback for the parser and revocations. crypto_test.mjs checks CRYPTO's known answers. hydra.js wraps hydra.wasm (copied from HYDRA's docs/hydra.wasm at 87fa55a): planning, encoding, `verifyBlock` for the parser, decoding, the relay check, and a Reassembler that collects blocks and makes Request-Root records. robusto.js wraps the four ROBUSTO modules (copied from aicodix/modem's robusto branch, docs/temp/ at 63eb078): `loadEncoder(rate)` picks modes and turns payloads and pings into audio, `loadDecoder(rate)` turns samples into events (sync, meta, ping, frame, error). scsu.js wraps scsu.wasm (copied from SCSU's docs/scsu.wasm at 2f13b28): `encode`, `decode` (pass it to the parser as `scsu`) and `smallestText()`, the smaller of Text-UTF-8 and Text-SCSU. wasm.js loads all modules.

The GUI will be a PWA served from 127.0.0.1:8080 by `python3 -m http.server`, so modules load over fetch; `loadCrypto()`, `loadHydra()`, `loadScsu()`, `loadEncoder(rate)` and `loadDecoder(rate)` without a source fetch their .wasm next to their .js. The page loads the ROBUSTO modules for `AudioContext.sampleRate` (44100 or 48000).

Next: to be decided with the maintainer (encoders for GB 18030 and the Text-Table encodings, storage, the GUI with microphone, speaker and AudioWorklet).
