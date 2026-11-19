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

## License

[0BSD](LICENSE)
