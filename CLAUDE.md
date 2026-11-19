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

## Open questions from the spec discussion

- Prefix ordering rule: check edge cases through nested Bundles.
- Must-understand record (0xF0–0xFE) directly inside Signed: does "the innermost enclosing record" mean the whole Signed?
- Should relays relay Keyed posts they can't verify? Not specified.
- Position: the post timestamp is the fix time; a separate fix time may come later as an extension.
- SPEC.md sizes look off by one: Signed overhead is type + length + key + sig = 98 bytes, not 97, so `Signed(key, Revoke)` is 101, not 100 (records_test.mjs checks 98 and 101).

## Choices records.js makes where SPEC.md is silent

Each needs confirming in SPEC.md or changing in code:

- A prefix may precede only Topic, a bare Text, Position or sensor record, Bundle, another prefix, or an unknown optional or must-understand record. Anything else after a prefix (Request-*, Fragment, Revoke, Signed, Keyed) drops the frame.
- Mention, Codec2, WebP, Avatar and MIME escape outside a post drop the frame.
- A must-understand record directly in Signed drops the whole Signed. In a Bundle, it drops the Bundle. At the top level nothing encloses it, so only the record itself is ignored. The rest of the container is still parsed, so malformed data after it still drops the frame.
- A 0x00 inside any record (Signed, Keyed, Bundle, post) drops the frame. Only the top level ends at 0x00.
- A post whose only parts are unknown optional records counts as non-empty.
- Keyed allows Topic, Reply, Bundle and prefixes, and nothing else besides unknown records. Keyed inside Keyed drops the frame.
- Revoke outside Signed is still checked for well-formedness, then ignored (`effective: false`).
- A Fragment's reserved header bit 30 set, or a block too short for its proof and root, drops the frame.
- Text in parts and subjects is not checked for valid UTF-8, only in handles, as the error table says.
- An all-zero call sign decodes to the empty string and is accepted. The encoder refuses empty call signs and leading spaces, since neither survives the round trip.

## Next step

Done: records.js parses and encodes records (type classes, lengths, prefix chains and the ordering rule, Bundle, posts, value checks, the error table, post IDs, Keyed tags). records_test.mjs covers it with hand-built frames.

Next: the WebAssembly glue for CRYPTO (signing and the `verify` callback), then HYDRA (Fragments, reassembly, Request-Root).
