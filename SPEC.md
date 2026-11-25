# Rattlechan v0 — Draft Spec

2026-11-17 · Ahmet Inan

## NO ENCRYPTION. EVER.

> **Amateur radio rules forbid messages encoded to obscure their meaning. Rattlechan also runs on CB, PMR and other channels, and stays legal on the strictest channel it runs on. It will never encrypt anything, and requests to add encryption will be closed without discussion.**
>
> Every post is readable by anyone in range. Signatures are allowed because they prove who wrote a post without hiding what it says; hashes only name content. Anything that hides content (encryption, encrypted attachments, private codebooks) does not belong on the air or in this protocol.

## Status and principles

This is Rattlechan v0, the first public version of the protocol. Posts travel over the ROBUSTO OFDM modem (8 to 61440 bytes per frame), optionally split by [HYDRA](https://github.com/xdsopl/hydra) and optionally signed with [CRYPTO](https://github.com/xdsopl/crypto).

- **Self-contained.** Nothing is sticky. Every post carries everything needed to show it and compute its ID, so it can be stored, bundled and retransmitted on its own. Avatars and key labels are decoration learned from other posts; a post is complete without them.
- **Optional layers.** Signing (CRYPTO) and splitting (HYDRA) are independent. A minimal client only parses records and computes BLAKE2s, and shows signed posts as unverified.
- **Keys are identity.** A public key is the only unique handle. Call signs get reassigned and names are ambiguous; both are labels.
- **The format allows, the client decides.** Anything that fits the payload is valid. What a station shows, relays or refuses to decode is local policy.
- **Lossy by design.** Stations keep the last frames as received, bounded by bytes, in two tiers so spam can't evict what matters, and rebuild the BBS tree from them at startup.
- **Little-endian everywhere.** No big-endian field anywhere in the protocol.

## Wire basics

A payload is a stream of records, read until a 0x00 byte or the end of the payload. All multi-byte integers are little-endian.

```
payload := record* [0x00 padding…]
record  := prefix | fixed | type length data
length  := u8 0..254              the length itself
         | 0xFF u24               length = 255 + u24 (little-endian)
```

- **One encoding per length.** Lengths below 255 must use the single byte; the long form starts at 255. Anything else is malformed.
- **End of payload.** Type 0x00 has no length and stops parsing. It only appears where the payload is padded: ROBUSTO and HYDRA both pad with zeros, so padding parses as the end. Records are never padded, so a 0x00 inside a record is malformed.
- **Fixed-size core records** carry no length either: Request-Post, Request-Root and the two Revokes. Their size follows from the type, and for Request-Root from its header. Skipping never needs it, since an unknown core type drops the frame.
- **Fixed-size optional records** (0x80–0xBF) carry no length: the type alone gives the size, in eight blocks of eight types, each block with one size: 0x80–0x87 1 byte, 0x88–0x8F 2, 0x90–0x97 4, 0x98–0x9F 6, 0xA0–0xA7 8, 0xA8–0xAF 12, 0xB0–0xB7 16, 0xB8–0xBF 32. A client skips one it doesn't know by that size, so new fixed-size types stay optional. Every record whose content has one fixed size goes here; a type with optional fields becomes separate types instead.
- **Prefixes** carry no length. They consist of a type and a fixed-size handle or a Text record as handle, and apply to exactly the next record.
- **Timestamps** are u32 Unix seconds (valid until 2106).

## Type number space

The class of a type follows from its number alone, so a parser knows what to do with types it has never seen.

| Range | Class | Length | Unknown type |
|---|---|---|---|
| 0x00 | End of payload | none | — |
| 0x01–0x1F | Prefix, must know | none | drop the frame |
| 0x20–0x2F | Core record, must know | yes, unless fixed-size | drop the frame |
| 0x30–0x7F | Optional record | yes | skip it |
| 0x80–0xBF | Optional record, fixed size | none, the block gives it | skip it |
| 0xC0–0xEF | Optional record | yes | skip it |
| 0xF0–0xFE | Must-understand record | yes | drop the innermost enclosing record, or the frame at the top level |
| 0xFF | Reserved | — | drop the frame |

| Type | Name | Contents |
|---|---|---|
| 0x01 | From-Call | call sign, 6 bytes base-40 |
| 0x02 | From-Name | Text record |
| 0x03 | To-Key | public key, 32 bytes |
| 0x04 | To-Call | call sign, 6 bytes base-40 |
| 0x05 | To-Name | Text record |
| 0x06 | To-Group-Name | Text record |
| 0x07 | To-Group-Key | group public key, 32 bytes |
| 0x20 | Signed | key[32] sig[64] records |
| 0x21 | Keyed | tag[16] records |
| 0x22 | Bundle | records |
| 0x23 | Topic | timestamp[4] subject (Text record) parts |
| 0x24 | Reply | timestamp[4] parent post ID[32] parts |
| 0x25 | Fragment | HYDRA block |
| 0x26 | Request-Post | post ID[32], no length |
| 0x27 | Request-Root | header[u16] root[16 or 32], no length |
| 0x28 | Revoke-Retired | nothing, no length |
| 0x29 | Revoke-Compromised | nothing, no length |
| 0x40 | Text-UTF-8 | text |
| 0x41 | Text-GB18030 | text |
| 0x42 | Text-Table | table index[1] text |
| 0x43 | Text-SCSU | text |
| 0x44–0x4F | text range | reserved for more text encodings |
| 0x50 | Audio | Codec2 (.c2) or Opus in Ogg file |
| 0x51 | Picture | PNG, JPEG, GIF or WebP picture or animation |
| 0x52 | Avatar | PNG, JPEG, GIF or WebP picture or animation |
| 0x88 | Temperature | i16, 0.01 °C, no length |
| 0x89 | Humidity | u16, 0.01 % relative, no length |
| 0x8A | Voltage | u16, mV, no length |
| 0x90 | Pressure | u32, Pa, no length |
| 0x91 | Wind | direction[2] speed[2], no length |
| 0x92 | Altitude | i32, mm above mean sea level, no length |
| 0xA8 | Position | lat[4] lon[4] fix time[4], no length |
| 0xB8 | Mention | post ID[32], no length |
| 0xEF | MIME escape | type/subtype and name, each zero-terminated, then content |
| 0xF0… | Replaces, Retract, … | reserved for later |

New features go in the optional range unless old clients would misread the post without them; those go in 0xF0–0xFE. A new prefix or core type is a breaking change. Name handles and Topic subjects must be a record from the text range 0x40–0x4F; a client that doesn't know a text type there parses past it by its length and shows a short hash.

## Prefixes and handles

A prefix applies to exactly the next record, so handles cost only their type and handle, never a length. A chain of prefixes of different kinds describes one person: `From-Call From-Name` is “DL1ABC, named Ahmet”.

```
Signed[ From-Call From-Name Bundle[ To-Call Bundle[ Post Post ]
                                   To-Group-Name Post ] ]
```

- **Ordering rule.** Along a chain, each prefix type must be strictly greater than every prefix enclosing it, ignoring Bundle. This enforces From before To, forbids the same kind twice and makes the bytes canonical.
- **Bundle** (core record 0x22) applies the prefixes before it to all its children. Each child continues the chain from there. A Bundle with prefixes in force, its own or inherited, must have at least one child: an empty one is a prefix with no record after it.
- **Prefixes may precede** Topic, a bare record, Bundle or another prefix, never a request, a Revoke or a Fragment. A Reply takes From prefixes only, never To prefixes, directly or through a Bundle. Signed and Keyed start a fresh scope: prefixes go inside them, never in front.
- **Call signs** are up to 9 characters in ROBUSTO's base-40 alphabet, read as one base-40 number with the first character as the most significant digit, and stored as a 48-bit little-endian integer in 6 bytes. Character values: 0 = space, 1 = unused, 2 = `-`, 3 = `/`, 4–13 = `0`–`9`, 14–39 = `A`–`Z`; lower-case letters get the same values as upper case, so call signs are case-insensitive by construction. There is no padding: the number has as many digits as the call sign has characters. A value of 0 (an empty call sign), 40⁹ or more, or a digit 1, is malformed. SSIDs like DL1ABC-7 fit. The GUI can prefill call signs from the preamble.
- **Names** are a Text record in any of the three text types. Receivers compare them byte for byte and never decode to compare; they show the decoded text if the encoding is supported, otherwise a short hash.
- **Several recipients** are reached through a group handle, never a list of call signs: the member list never goes on the air. Otherwise the message is duplicated.
- **Group handles.** A group name works like a channel; anyone can post. A group key is a key pair for the group; the GUI can show only posts the group key has re-signed, `Signed(group key, Signed(member, …))`.
- **Inbox matching** follows the handle: a key is exact, a call sign is shown with a note that call signs get reassigned, a name is “maybe for you”.
- **No forwarding.** To point someone at a post, write them a post that mentions its hash.

## Core records

Every parser must know these. A post enters the BBS tree only inside Signed; a Keyed post lands only in its owner's inbox; everything else is logged.

- **Signed** (0x20): `key[32] sig[64] records`. Ed25519 by CRYPTO over `CONTEXT ‖ records`. CRYPTO signs at most 2²³ bytes, so the records are at most 2²³ − 14 bytes; a larger Signed record is malformed. Several Signed records can share a payload. Signed may contain Signed (group-key endorsement). Anything else may go inside except Fragments: the reassembled payload is what gets signed. A signed request tells responders who is asking, so they can answer only keys they allow; signing requests is optional. Requests carry no timestamp, so a recorded signed request still verifies when replayed: it only proves who asked at some time, never when. Receivers verify before parsing the inside; a signature that fails is malformed and drops the whole frame, since it usually means corruption. Relays copy it as an opaque block.
- **Keyed** (0x21): `tag[16] records`, the tag being BLAKE2s-128 in keyed mode (output length 16 set in the parameter block, not a truncated BLAKE2s-256) over CONTEXT ‖ 0x02 ‖ records, keyed with a secret only a sensor and its owner know: exactly 32 random bytes generated by the client, never a typed password, so recorded posts can't be used to search for it offline. For devices too small or too thrifty to sign: 18 bytes instead of 98. It proves the content comes from the holder of the secret without hiding anything. Keyed holds Replies only, since a sensor only replies to its owner's Topic, so every protected reading has a timestamp and a post ID and a replay is recognised; no Topics, Bundles, prefixes, bare records, Fragments or requests, and not inside Signed or the other way round. Its post ID is the unsigned one. Only the owner can check that it arrived intact, so it never enters the public BBS tree: stations without the secret log it, like an unsigned post, and relays never relay it, since nobody else can tell whether it is intact. The owner's client finds the secret by the Reply's parent Topic ID (trying the few secrets of sensors sharing a Topic), and a verified post lands in the owner's inbox and the sensor's thread. A tag that matches no secret only means the post isn't from one of the owner's sensors: it is logged, never dropped for that. Each sensor has its own secret; if one is compromised, the owner replaces that secret.
- **Revoke**: two types without content or length, Revoke-Retired (0x28: a silent key, a key no longer used) and Revoke-Compromised (0x29: lost or stolen). Only counts directly inside the Signed record of the key it revokes, `Signed(key, Revoke)`, 99 bytes in all; anywhere else it is logged and ignored. Permanent: there is no un-revoke. Compromised overrides retired, never the other way round, so a thief can't soften the owner's revocation. A revocation names no successor key; moving trust to a new key is always the user's own decision. It works the same for personal and group keys.
- **Bundle** (0x22): records that share the prefixes in front of it.
- Topic (0x23) and Reply (0x24): see Post layout.
- **Fragment** (0x25): one HYDRA block; the record length is the block length. See Fragments.
- **Request-Post** (0x26): full 32-byte post ID, no length byte. Any station holding the post may answer, at whatever size suits it. Short prefixes are never used in requests.
- **Request-Root** (0x27): a u16 header, then a HYDRA root, no length byte. Header bits 0–9: number of blocks still needed minus 1 (1–1024); bits 10–14: reserved, must be 0; bit 15: hash flag as in HYDRA (0 = 16-byte root, 1 = 32-byte root). The record is then exactly 19 or 35 bytes with its type. Responders pick random indices. Answer in the same ROBUSTO family (QPSK/QAM 0–25 or BPSK 26–31) as the request, at the same or a lower index; a station may also ignore it.
- **Bare messages** are optional records outside a Post, such as Text (0x40–0x4F), Position or a sensor reading: a short message without timestamp, e.g. “Hungry” in 12 bytes. A sensor in the wild can send a bare reading, such as From-Call + Temperature in 10 bytes, and a beacon a bare From-Call + Position in 20; a station sending for itself can leave the call sign to the ROBUSTO preamble. Several bare records may share a payload or a Bundle, and their time is the arrival time. Not referenceable, never in the tree; logged, and shown in an inbox when a To prefix matches. Media and Mentions may go bare too, for experiments; the one bare record with an effect is a signed Avatar.

## Post layout

There are two kinds of post: a Topic starts a conversation, on a board or with one person, and always has a subject; a Reply names its parent. Both start with a u32 timestamp, set when the author finished writing it.

```
Topic := timestamp[4] subject:Text part*
Reply := timestamp[4] parent[32] part*
```

- **Fixed positions, no fields.** The subject is a Text record in any text encoding, mandatory in every Topic; replies show the root's subject. The parent is the full 32-byte post ID of the one post a reply answers. A reply with a subject or a Topic with a parent can't be written. Mention (0xB8), an exact link to another post, is the only optional field.
- **Where a post goes.** A Topic goes where its To prefixes send it: a board or a person. A Reply never has a To prefix: it goes where its parent is, and since its ID covers the parent ID, it belongs to exactly one conversation. It may carry From-Call and From-Name, so a key that only replies can still say who it is. Inboxes follow the whole conversation, not only the user's own posts, so a follow-up to the other side's own post still arrives. A station without the parent can fetch it with Request-Post. Where a post could still belong in more than one place, the GUI shows the alternative paths.
- **Parts:** at most one text part. Media parts follow the guideline in Client policy, not a format rule.
- **Empty posts** (no text, media, Mention, Position or sensor reading) are dropped; pings cover that case. A part of unknown type counts, so a post with a new media type still reaches old clients. A post holding only Mentions is valid: picking posts and a recipient is enough to point someone at them. A post may carry several Mentions, each post ID at most once.
- **Position (0xA8):** a WGS 84 point in the de facto binary convention of u-blox, MAVLink and Meshtastic: latitude, then longitude, each a little-endian i32 in units of 10⁻⁷ degrees (about 1 cm), then the fix time, the moment the receiver measured the point, as u32 Unix seconds in UTC: 12 bytes. The fix time belongs to the position and is independent of any post timestamp. A latitude outside ±90° or a longitude outside ±180° is malformed. At most one Position per post. A post holding only a Position is valid: “here I am” needs no text. Clients show it as a map pin and export it as a `geo:` URI (RFC 5870) or GPX.
- **Sensor readings (0x88–0x8A, 0x90–0x92):** common values, each its own fixed-size type, at most one of each per post, measured at the post's timestamp and, if present, its Position. Temperature: i16 in 0.01 °C. Humidity: u16 relative humidity in 0.01 %, 0–10000. Voltage: u16 battery voltage in millivolts (up to 65.5 V), so a station in the wild can report that it is alive and for how long. Pressure: u32 in pascals (101325 at sea level, a few hundred at burst altitude). Wind: direction the wind blows from, u16 in 0.01° clockwise from true north (0–35999), then speed u16 in 0.01 m/s. Altitude: i32 in millimetres above mean sea level (as in MAVLink; enough for balloons), from a GNSS fix or from pressure, so it stands alone or beside a Position. An out-of-range value is malformed. Other sensors get their own types when they are needed, never a generic telemetry container; gusts and the accuracy of a fix are left for later, each a type of its own.
- **File names only on MIME escape.** “Save as” uses the name a MIME escape carries; otherwise, and for every other media type, it names the file by the hex hash of its content plus the extension from the content type. Neither the name nor the type says what a file really contains.

**Text encodings.** UTF-8 is the default. GB 18030 gets its own type because it is the Chinese standard, a superset of GBK and GB 2312, and covers all of Unicode. SCSU (Unicode Technical Standard #6) gets its own type too: about one byte per character for alphabetic scripts, including the Indic and Southeast Asian scripts that have no legacy encoding at all, and about two for CJK, while covering all of Unicode. Text-SCSU content is at most 2²⁰ bytes, and like invalid UTF-8, invalid SCSU (a reserved tag, an undefined window, truncated input, an unpaired surrogate) is malformed; a client without an SCSU decoder can't tell and shows a short hash. Browsers don't decode it, so clients bring a small one, such as the [SCSU module](https://github.com/xdsopl/scsu) (plain JavaScript or 7 KB of WebAssembly; [try it in the browser](https://xdsopl.github.io/scsu/)). Every other encoding goes through the table type: one index byte into a frozen list based on the WHATWG Encoding Standard, which browsers decode with `TextDecoder`. The sender picks whichever encoding is smallest; receivers convert to UTF-8. Decoding follows the WHATWG Encoding Standard, as browsers implement it with `TextDecoder`; other decoders (ICU in Node.js, for example) differ for some encodings and are no reference. Senders need their own encoders, generated at startup by decoding every byte sequence with those decoders, and send only what decodes back to the same text.

**Encoding table (Text-Table index byte).** The WHATWG encodings in their order, without UTF-8 and GB 18030 (own types), GBK (decoded as GB 18030), ISO-8859-8-I (same bytes as ISO-8859-8), ISO-2022-JP (stateful), replacement, x-user-defined and UTF-16BE. New entries are only ever appended.

```
 0 IBM866         8 ISO-8859-10   16 windows-874    24 windows-1257
 1 ISO-8859-2     9 ISO-8859-13   17 windows-1250   25 windows-1258
 2 ISO-8859-3    10 ISO-8859-14   18 windows-1251   26 x-mac-cyrillic
 3 ISO-8859-4    11 ISO-8859-15   19 windows-1252   27 Big5
 4 ISO-8859-5    12 ISO-8859-16   20 windows-1253   28 EUC-JP
 5 ISO-8859-6    13 KOI8-R        21 windows-1254   29 Shift_JIS
 6 ISO-8859-7    14 KOI8-U        22 windows-1255   30 EUC-KR
 7 ISO-8859-8    15 macintosh     23 windows-1256   31 UTF-16LE
```

**Media codes** exist only for small content where a MIME string would weigh too much:

- **Audio** (0x50): an audio file as it is, its format told by its first bytes, never declared, as for Picture:
  - **Codec2**, a .c2 file: the magic C0 DE C2, a major and a minor version byte (any version), the mode byte, a flags byte, then the frames. The mode byte is Codec2's own CODEC2_MODE value (0 = 3200, 1 = 2400, 2 = 1600, 3 = 1400, 4 = 1300, 5 = 1200, 8 = 700C). Each frame fills whole bytes: 700C has 28 bits every 40 ms, stored in 4 bytes, so 5 s is 500 bytes of frames and 507 with the header.
  - **Opus in Ogg**, an .opus file: an Ogg page (capture pattern "OggS", stream structure version 0) whose first packet is the OpusHead (RFC 7845). Its two header pages cost about 100 bytes, and Opus starts at 6 kbit/s, so Codec2 is the one for voice over narrow channels; Opus is the one phones play.
  - Other content is not malformed: clients show it as audio they can't read, to save. Received audio is saved as it came; it plays only when asked for, never by itself.
- **Picture** (0x51): a PNG, JPEG, GIF or WebP picture or animation, its format told by its first bytes, never declared, as for Avatar. Every browser decodes all four, so photos, screenshots and animations go as they are, without a MIME escape's type and name. Other content is not malformed: clients show it as a picture they can't read, to save.
- **Avatar (0x52):** a PNG, JPEG, GIF or WebP picture or animation for the signer's key, sent now and then, not with every post. Its format is told by its first bytes, never declared. It has 16384 to 262144 pixels, as many as 128x128 to 512x512, its longer side at most twice its shorter one (2:1 or 1:2 at most), by the PNG IHDR, the JPEG frame header, the GIF logical screen, the WebP VP8X canvas or VP8L or VP8 frame size, and at most 8192 bytes; all of these are read from the header before anything is decoded. Every browser encodes JPEG and PNG, so a client can make an avatar from any photo without a WebP encoder; clients ignore any other Avatar (logged, never learned, never precious, not malformed) and send none. Honoured anywhere inside Signed, bare, in a Bundle or as a post part, for the innermost signer's key, whose fingerprint identifies the avatar; outside Signed it is only logged, since without a key there is no one to attach it to. The client keeps one avatar per key, the one from the newest post, and draws it beside every post that key signs once the user trusts the key, whole and fitted into its place, never cropped, so any shape within the limits shows as its sender made it; until then, it draws an identicon from the key's fingerprint.
- **MIME escape** (0xEF): everything else, `type/subtype` zero-terminated, then the content. The type is lowercase ASCII as in RFC 6838: type/subtype only, letters, digits and ! # $ & - ^ _ . +, each half at most 127 characters, no parameters. Then a zero-terminated file name, possibly empty: lowercase a–z, digits, ".", "-" and "_", at most 64 characters, not starting with "." and without "..". Anything else in the type or the name is malformed.

5 s of voice at 700C and the post overhead fit in under 650 bytes, signed or not; a small picture, such as the 842-byte example of examples/session.mjs, brings it to about 1.5 KiB.

## Identity, hashing and signatures

All message hashes are BLAKE2s-256: post IDs and Request-Post; Keyed tags are BLAKE2s-128 in keyed mode. BLAKE2b exists only inside CRYPTO's signature scheme. Protocol hashes start with CONTEXT and a tag byte (0x00 unsigned post ID, 0x01 signed post ID, 0x02 Keyed), so a future version can change them and the three never collide. Media files are hashed plain, without context, so the value matches standard BLAKE2s-256 tools; it names files on "Save as".

| Post inside | Post ID | In the tree |
|---|---|---|
| Signed | BLAKE2s-256(CONTEXT ‖ 0x01 ‖ signer key ‖ Post record) | yes |
| Keyed | BLAKE2s-256(CONTEXT ‖ 0x00 ‖ Post record) | no, owner's inbox only |
| neither | none | no, logged only |

- **The ID covers only the Post record** (type, length and content), never the wrappers around it, so bundling, prefixes and resending never change it.
- **Nested signatures:** the ID uses the innermost signer, the author.
- **Never hash a signature** into an ID. CRYPTO rejects non-canonical S, but a signer can still sign the same post twice with different signatures.
- **Signatures** are Ed25519 with BLAKE2b-512 in place of SHA-512, as implemented by CRYPTO; not compatible with RFC 8032 libraries. They cover `CONTEXT ‖ inner bytes` with CONTEXT = the ASCII string "Rattlechan-v0" followed by a zero byte, so a signature made with the same key for another purpose is never valid here.
- **The public key is always sent** with a signature. Allow and deny lists are direct key lookups.
- **HYDRA roots are never IDs.** A root identifies one encoding, not the post.
- **In text,** humans link posts with short hex prefixes, like git hashes; the GUI resolves them and shows candidates when ambiguous. Protocol fields always carry the full 32 bytes.

## Fragments

A Fragment record holds exactly one [HYDRA](https://github.com/xdsopl/hydra) block, and its record length is the block length. HYDRA's README is the reference for the block format; this is what the protocol relies on.

```
block := header[4] payload proof[height × hlen] root[hlen]
header (u32 LE): bit 31 hash flag (16/32 bytes), bit 30 reserved,
                 bits 29–26 height−1, bits 25–16 K−1, bits 15–0 index
```

- **Used for** payloads too big for one frame, or split into short transmissions to respect airtime limits. Smaller posts go as plain records.
- **Sharing frames.** A fragment is only as long as it needs to be (`block_length`); the rest of the frame can carry other records.
- **The reassembled payload** is an ordinary record stream of at most 2²³ bytes; its zero padding parses as the end. It never holds Fragments itself: a Fragment in it is malformed.
- **A week at most.** A set that hasn't decoded waits at most 7 days from the arrival of its first block; a block arriving later starts a new set, and a station stops asking for the old one. Roots are short-lived names: senders use 16-byte roots, and this keeps blocks with colliding roots from mixing over a long time. A set that decoded is untouched: its post or Avatar is protected by its own signature and 32-byte post ID, never by the root, and its frames stay as long as their tier keeps them.
- **Limits:** N = 2^height with height 1–16, so N ≤ 65536; K ≤ 1024, K ≤ N, index < N, and a block is at most 8192 bytes. Senders should use N ≥ 16 × next power of two of K, so independent relays rarely send the same block.
- **Checks before HYDRA:** a block with header bit 30 set, breaking the limits, or shorter than its header, proof, root and 4 bytes of payload, is malformed.
- **HYDRA's check:** a block that fails `verify_block` (a wrong proof, non-zero padding) is malformed too, and drops the frame.
- **Integrity:** every block carries a Merkle proof, so no one can corrupt a message; forged blocks fail or form their own root.
- **Receivers** need any K valid blocks. K blocks with proofs are the complete state.
- **Relays** decode, call `regenerate_tree` and send blocks only if the rebuilt root matches; otherwise they keep and send nothing.
- **Random indices.** Senders send blocks at random indices of the N, the first transmission too, so stations sending one set never follow the same order and rarely repeat each other.
- **Sending a set again,** its author or a relay sends new blocks: random indices the station holds none of, neither received nor sent, never the ones it has. Blocks a listener already has don't help it, while any new block does. The root and the post ID stay the same, so the blocks join sets still waiting; how many to send is up to the sender.
- **Storage:** stations keep the K fragment frames, not a decoded copy. At startup the tree lists fragmented posts and decodes them when opened.

## Parsing and error handling

Malformed data drops the whole frame, since it usually means corruption; unknown but well-formed data is skipped or dropped narrowly.

| Condition | Action |
|---|---|
| Length or fixed-size record runs past its container, long length form below 255 | drop the frame |
| Unknown prefix or core type, or 0xFF | drop the frame |
| Prefix order violated, duplicate field, prefix with no record after it (or only an empty Bundle), any To prefix applying to a Reply (directly or through a Bundle) | drop the frame |
| Invalid UTF-8 in any Text-UTF-8 record, invalid or too long SCSU in any Text-SCSU record, invalid base-40 value, empty call sign | drop the frame |
| 0x00 inside a record | drop the frame |
| Unknown optional type (0x30–0xEF), by its length or, in 0x80–0xBF, by its block's size | skip the record |
| Unknown must-understand type (0xF0–0xFE) | drop the innermost enclosing record, usually the Post; directly in Signed, the whole Signed; at the top level, the frame |
| Signed records larger than 2²³ − 14 bytes | drop the frame |
| Fragment breaking the limits or failing `verify_block`, Fragment inside a reassembled payload | drop the frame |
| Signature check fails | drop the frame |
| Client without CRYPTO | parse Signed contents, show as unverified, keep out of the tree |
| Post without parts | drop the post |
| Timestamp in the future beyond clock drift | keep; show the arrival time with a note |

For fragmented posts, “the frame” means the reassembled payload. Posts from the past are normal (bundling, relays, resends) and are never flagged.

## Client policy

None of this is part of the format; it is what a good client does by default, and every station may choose differently.

| Setting | Who uses it |
|---|---|
| Show posts from untrusted keys (faceless, collapsed or hidden) | every user |
| Relay posts from untrusted keys | relay operators |
| Allow and deny lists of keys, for showing and for relaying | both |
| Max K, max N, max post size, max Signed nesting | the client, from available memory and CPU |

- **Keys:** generated quietly on first start; signing can be turned off.
- **Content guideline:** up to 1 MiB per post, at most one text, up to four heavy parts (pictures, PDFs) or one audio or video; combinations like an animated picture with Codec2 audio are fine. Show the first few parts and collapse the rest.
- **Decoding bombs:** read image dimensions and audio or video length from headers before decoding, and refuse implausible sizes. Pictures larger than 4096 pixels on a side are drawn only after warning the user, with the memory decoding takes: a small file can hold a picture of gigabytes.
- **Downloads:** “Save as” is offered directly only for files in posts signed by a trusted key. For anything else, the user has to go through deliberate extra steps first: two questions, the second naming the file and its size. Names and MIME types prove nothing about a file's content. A content type without a well-known extension saves as .bin, so no type makes a file look like a program.
- **Names and avatars are earned:** a key's From-Call, From-Name and Avatar, learned from its signed Topics, Replies and Avatar posts, are shown on its posts only once the user trusts that key. Until then, the client shows an identicon and a short hash of the key. Throwaway keys work, but stay faceless until someone trusts them. From prefixes are only believed on posts signed by a trusted key: anyone can put someone else's name or call sign there. Unsigned bare records are the exception: their From-Call and From-Name are shown marked as unverified, so simple sensors and experiments work. Readings that need to be trusted are signed.
- **Revocations:** when the client generates a key, it also signs both revocations for it and prints them as two QR codes with hex: “retired”, for family or friends to send when the operator becomes a silent key, and “compromised”, for the operator to send when the key is lost or stolen. Each carries a note asking whoever finds it to scan and send it. A revocation works from the station's own arrival time, never the author's timestamps, which a thief can backdate. Retired: posts that arrived before stay as they are, with name and avatar; later ones are marked as signed by a retired key. Compromised: every post by the key loses trust, name and avatar; posts that arrived before are kept but marked, since nobody can tell which the thief wrote, while those arriving after are no longer precious. A revoked key of the station's own signs nothing new, and a revocation the station sends counts once it went out. Stations keep revocations forever, exempt from the byte budgets, but only verified ones of keys the user trusts: anyone can make throwaway keys and revoke them, so other revocations are ordinary frames in the logged tier. If the user trusts such a key later, its revocation takes effect then, from the arrival of its frame, and the client says so before the user confirms. Relays repeat the kept ones now and then: a station sends them all at once when asked, as many per frame as fit, and otherwise puts them in the zero padding its own frames carry anyway, the one sent longest ago first, so repeating them costs no airtime; a key's retired one goes no more once its compromised one is kept. A new key may sign a Topic claiming to replace an old one; the user confirms that by hand, never automatically.
- **Sensor setup:** the owner creates a signed Topic for the sensor (“Garden weather”) and loads the sensor with that Topic's post ID and a fresh secret. The sensor never makes a Topic and holds no signing key: it only sends Keyed Replies to that Topic, each with its own timestamp, so it needs a clock (RTC or GPS). Everyone sees the signed Topic in the tree; only the owner sees the readings, each marked verified, in their inbox and under that Topic.
- **Storage:** keep the last frames as received, bounded by bytes, not by count, in two tiers with a budget each (100 MiB by default), so a station spamming changing frames only evicts other logged frames. The precious tier holds frames with a post or an Avatar signed by a trusted key, the station's own frames and Keyed posts verified with one of the owner's secrets. The logged tier holds everything else, including posts to the user's key from keys not yet trusted; a budget of 0 keeps none of it. Fragment frames wait in the logged tier and move up together once their payload decodes and turns out precious. Trusting a key moves the frames of its posts up; distrusting it moves them down, unless something else in them is precious. Never re-encode a post from parsed data; forward the stored bytes. Each new post signed by a key pushes the frames holding that key's current Avatar to the front again, so an avatar lives as long as its key keeps posting and fades out once the key falls silent.
- **Sending:** the operator collects posts up to an airtime budget and sends them in one go. The client picks plain records or HYDRA, signing, bundling and the text encoding.
- **Ordering:** sort threads by arrival time; both clocks can be wrong.
- **Direct conversations:** by default, show only Replies signed by the Topic's author or its recipient; anyone may reply, but strangers stay hidden unless the user opens them. Reliable only for To-Key Topics, where both keys are known. For To-Call or To-Name the recipient's key is unknown until they answer, so the client trusts the first key that replies, and a stranger could take that place: start undisturbed conversations with To-Key. This keeps a conversation tidy; it is not privacy, since everyone in range receives every post.
- **Requests** may be ignored, e.g. when they look like spam; a responder may answer only signed requests from trusted keys. Answer the same request at most once in a while (an hour, say), so a replayed request doesn't make the station transmit again.
