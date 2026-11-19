# Rattlechan

A message board that travels as sound. The protocol is in SPEC.md (v0 draft, still changing).

## Rules

- No third-party libraries. Plain JavaScript (ES modules) plus the ROBUSTO, HYDRA, CRYPTO and SCSU WebAssembly modules, copied in as they are.
- Never add encryption or anything that hides content. Signatures and MACs are fine.
- Little-endian everywhere.
- Tabs for indentation.
- SPEC.md is the source of truth: when code changes the protocol, update SPEC.md in the same commit.
- Every module gets a test file `<name>_test.mjs`, run with `node <name>_test.mjs`, no test framework.
- License: 0BSD.

## Commit messages

Match the existing history:

- A short lowercase subject, no trailing period, under about 60 characters, saying what changed. Example: `moved block count computation out of encode function`.
- No body unless the reason is not obvious from the diff.
- No Co-Authored-By, Claude-Session or other trailers, and no links.
- Claude commits as `Claude <noreply@anthropic.com>`. Never use the maintainer's name or email.

## Open questions from the spec discussion

- Keyed bullet: say explicitly that BLAKE2s-128 sets output length 16 in the parameter block and is not a truncated BLAKE2s-256.
- "NO ENCRYPTION. EVER." gives ham rules as the reason; Rattlechan also runs on CB, PMR and other channels. Say the protocol stays legal on the strictest channel it runs on.
- Prefix ordering rule: check edge cases through nested Bundles.
- Must-understand record (0xF0–0xFE) directly inside Signed: does "the innermost enclosing record" mean the whole Signed?
- Should relays relay Keyed posts they can't verify? Not specified.
- Position: the post timestamp is the fix time; a separate fix time may come later as an extension.

## Next step

Record parser and encoder: type classes, lengths (one encoding per length), prefix chains and the ordering rule, Bundle, the parsing and error-handling table. Testable with hand-built frames, no modem needed.
