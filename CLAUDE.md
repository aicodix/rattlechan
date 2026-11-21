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

## GUI

- Colors only through the variables in app.css, so every view works in light and dark, whether it follows the system or is forced.
- Never a flashing element. Nothing moves by itself: animated pictures and avatars show their first frame and play only while the mouse is over them or, on a touch screen, while a finger is on their message. Warnings latch for seconds instead of blinking. Under `prefers-reduced-motion` there are no transitions at all.

## Commit messages

Match the existing history:

- A short lowercase subject, no trailing period, under about 60 characters, saying what changed. Example: `moved block count computation out of encode function`.
- No body unless the reason is not obvious from the diff.
- No Co-Authored-By, Claude-Session or other trailers, and no links.
- Claude commits as `Claude <noreply@anthropic.com>`. Never use the maintainer's name or email.

## State of the work

### Modules

- records.js parses and encodes records: type classes, lengths, prefix chains and the ordering rule, Bundle, posts, value checks, the error table, post IDs, Keyed tags. A bad signature drops the frame; a Reply takes From prefixes but never To prefixes.
- crypto.js wraps crypto.wasm (CRYPTO's docs/crypto.wasm at 2339005): keys, signing, the `verify` callback for the parser, revocations.
- hydra.js wraps hydra.wasm (HYDRA's docs/hydra.wasm at 87fa55a): planning, encoding, `verifyBlock`, decoding, the relay check, and a Reassembler that makes Request-Root records.
- robusto.js wraps the four ROBUSTO modules (aicodix/modem's robusto branch, docs/temp/ at 63eb078): `loadEncoder(rate)` picks modes and turns payloads and pings into audio, `loadDecoder(rate)` turns samples into events (sync, meta, ping, frame, error).
- scsu.js is SCSU's JavaScript module (its module/scsu.js at c50f08c). encodings.js builds encoders for GB 18030 and the Text-Table encodings from `TextDecoder` and picks the smallest text record with `smallestText(str)`. `TextDecoder` gets `ignoreBOM` only for UTF-8 and UTF-16, so U+FEFF stays text (Node 22 drops a leading 0xFF in windows-1252 with it). Browsers (WHATWG) are the reference decoders; Node's ICU differs for IBM866, KOI8-U, windows-1255, Big5, Shift_JIS and EUC-KR and lacks ISO-8859-16, so encodings_test.html checks the encoders in the browser.
- wasm.js loads all modules, from a URL next to their .js by default.
- storage.js keeps the station's files on OPFS, or in memory for Node: precious/ and logged/ hold one file per frame named <kept>_<arrival>_<call sign>_<mode>.bin, each tier with its own byte budget (default 100 MiB) evicting the oldest kept time first; touch() renews avatars, promote() and demote() move frames, clear() deletes everything; revocations/ forever, only for trusted keys; data/ and secrets/ as JSON.
- archive.js exports .tar.gz (tar.js, CompressionStream), data and secrets in separate archives; import only adds what is missing. Exported archives can pre-populate the GUI for testing.
- station.js parses received frames, checks signatures, reassembles Fragments and stores them; malformed frames, a bad signature included, are shown but never stored. It keeps the trust list in data/trust.json and the station's own frames by BLAKE2s hash in data/own.json, learns each key's call sign, name and newest avatar from its verified signed posts and Avatars, puts frames with a post or Avatar under a trusted key's verified signature (or reassembling to one) and own frames in the precious tier and the rest in the logged tier, moves frames when trust changes, renews a key's avatar frame on each new post, lists the keys seen (`seen()`) and replays the store at startup.
- sender.js composes topics (to everyone, or To-Call, To-Key, To-Name or To-Group-Name), replies and bare messages, texts in their smallest encoding, optionally with From-Call and From-Name, inside one Signed record when given a sign function. Frames only use modes whose SNR threshold (the modem README's thresholds, SNR = -awgn level, in THRESHOLDS) is at most the setting within the seconds per frame; split() puts a post that doesn't fit into Fragments with extra blocks (at least one, at most N), secondsFor() gives the one longer frame instead, and chain() puts all frames back to back, every one but the first without its leading noise symbol, which only opens VOX and squelches.
- keys.js keeps the station's keys in secrets/keys.json, each with a label, From-Call, From-Name and both revocations signed when it arrives: generated, imported as 64 hex characters, or from a secrets archive.
- receiver.js runs microphone -> capture_worklet.js -> decoder_worker.js (ROBUSTO off the main thread) and decodes recordings the same way; transmitter.js plays audio out of the default output.
- render.js turns parsed records and station entries into DOM, received content only ever as text.

Every module has its <name>_test.mjs; the browser halves are encodings_test.html and storage_test.html, which the maintainer ran in Chrome and Safari.

### GUI

- A PWA served from 127.0.0.1:8080 by `python3 -m http.server`, phone first, with tabs at the bottom: Log, Send and Station. Boards and Inbox come once there is something to put in them. sw.js caches network first, so it works offline once opened.
- The page loads the ROBUSTO modules for `AudioContext.sampleRate` (44100 or 48000), otherwise asks for 48000.
- Log: every frame received and sent, newest first, with the parsed records. Malformed frames show as dropped. An identicon (mirrored 5x5 grid, colours --id-0..7) sits beside every verified signature, or the avatar with call sign and name once the key is trusted. Trust asks first, showing the whole fingerprint; Untrust is one tap; own keys say "your key" and show the call sign and name from the key list. From prefixes are marked unverified unless signed by a trusted key. To-Key chips show the recipient's identicon and, once trusted or own, its call sign and name. Pictures are drawn right away under a trusted key's signature, otherwise only when asked for. Posts with an ID have a Reply button, so only signed or Keyed ones.
- Send: signed posts only; unsigned ones are for sensors and experiments outside the GUI. "Sign as" picks a key, and Send stays disabled without one. "Include …" adds the key's From-Call and From-Name, off by default and again after each sent post, for an operator who hasn't posted in a long time. Topic or Reply; a Topic goes to everyone, or under "To" to a call sign, a key (suggested from the keys seen, or pasted as hex), a name or a board, each with a hint on how reliable it is, and the address resets after each sent post. A post that doesn't fit offers one longer frame or Fragments at the current seconds, in one seamless transmission keyed by VOX. Receiving ignores the decoder's reports while sending and 1.5 s after, but keeps the microphone and decoder running (restarting the microphone takes seconds in Safari) and the level meter moving.
- Station: Receiver first (Listen, input, level meter, decoding a recording); Your station (the preamble's call sign, seconds per frame 5, SNR threshold 10 dB, extra blocks 25%); Keys (add, edit, print revocations as hex, remove by typing DELETE; held keys count as trusted); Storage (persistence, usage and quota, budgets, export, import, last export); Appearance (System, Light, Dark, per device); Danger Zone (delete everything but the appearance by typing DELETE).
- Safari grants persistent storage only to web apps added to the Home Screen or Dock and may otherwise delete stored data after 7 days without use, so the Station tab shows whether storage is persistent, suggests installing the app, and shows when the last export was made.

## Open items

- [ ] The ROBUSTO decoder processes the end of one frame and the preamble of the next in the same sample when frames follow each other without a gap, as in a chain. The module then reports the next frame's call sign, mode and payload length with the finished frame: in a seamless example session of 21 frames from several stations, at both rates, 6 got the wrong call sign and 5 the wrong mode and payload. Chains from the GUI hide it, as their frames share call sign and length, but two stations back to back don't. It needs a fix in aicodix/modem (Decoder::feed() in decoder.hh, for example not running preamble() in a sample whose events already hold frame_end) and new modules copied here. Then examples/session.mjs, the seamless session with its test, can go in.
- [ ] QR codes for the printed revocations (qr.js, no third-party library; a 99-byte revocation fits version 6).
- [ ] Sending a revocation pasted as hex, or scanned from its QR code.
- [ ] Revocations of trusted keys: keep them forever and mark retired or compromised keys and their posts.
- [ ] The station's own avatar.
- [ ] Inbox and Boards tabs: posts to the station's call sign, names and keys; boards by group name; direct conversations showing only Replies by the two keys.
- [ ] Maybe an output level setting: the modem plays at full scale.
