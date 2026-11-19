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
- Position: the post timestamp is the fix time; a separate fix time may come later as an extension.

## Next step

Done: records.js parses and encodes records (type classes, lengths, prefix chains and the ordering rule, Bundle, posts, value checks, the error table, post IDs, Keyed tags). records_test.mjs covers it with hand-built frames.

Next: the WebAssembly glue for CRYPTO (signing and the `verify` callback), then HYDRA (Fragments, reassembly, Request-Root).
