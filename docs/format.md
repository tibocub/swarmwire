# The swarmwire format — v0

Everything here ends up inside links that people share and store. Links must keep working after
the engine has been rewritten three times, so this document changes slowly and deliberately,
and everything in it is pinned by tests in `test/unit/`.

## 1. Addressing

**A content address is the 32-byte BLAKE3 hash of the content.** Nothing custom, nothing
swarmwire-specific: it is the value `b3sum` prints, and the value any other BLAKE3 tool agrees
on.

Two consequences worth stating plainly:

- **The same bytes always have the same address**, whoever hashed them, with whatever tool, at
  whatever chunk size. Deduplication across peers and across apps is free.
- **The address commits to the content's length.** BLAKE3's tree shape depends on the length, so
  truncation and extension attacks are not possible. (SwarmFS's hand-rolled tree duplicated the
  last node of an odd level, which made `[a,b,c]` and `[a,b,c,c]` collide. Dropping the custom
  tree drops the bug.)

Size and filename are **hints**, never part of the address. A peer may lie about either; the
hash is what is enforced.

## 2. Verification

Ranges are verified with [bao](https://github.com/oconnor663/bao) verified streaming, as
implemented by the pure-JavaScript `blake3-bao`.

- A sender keeps an **outboard** tree for the content it serves — hashes only, no data copy.
- For a requested byte range, the sender produces a **slice**: the range plus the minimal set of
  tree nodes proving it belongs to the root.
- The receiver verifies each slice against the root **before writing it to disk**. A peer that
  sends one bad byte is caught immediately, not at the end of the transfer.

**Chunk groups.** Standard bao verifies at 1 KiB granularity, which makes the outboard tree
large. Grouping chunks shrinks it while keeping the same root hash:

| Group size | Outboard for 1 GiB | Smallest verifiable unit |
|---|---|---|
| 1 KiB (plain bao) | ~64 MiB | 1 KiB |
| **16 KiB (default)** | ~4 MiB | 16 KiB |
| 256 KiB | ~256 KiB | 256 KiB |

**Defaults: 16 KiB verification groups, 64 KiB request blocks.** 16 KiB is what the rest of the
world converged on — BitTorrent v1's request block, BitTorrent v2's leaf block size, and
bao-tree's default — so it is where we start, not where we must stay. Both numbers are
negotiated per transfer and must be re-judged against real measurements once M2's benchmark
exists; very large files may want bigger groups to keep outboards small.

`blake3-bao` calls grouped encoding "Iroh chunk groups" because iroh popularised the technique.
**swarmwire does not depend on iroh, Rust, or any native module.** Keeping the whole stack pure
JavaScript is deliberate: it has to run on Bare for mobile.

## 3. Links

```
swarmwire://<root-hex>[?s=<size>][&n=<name>][&k=<secret-hex>]
```

| Part | Meaning |
|---|---|
| `root-hex` | 64 lowercase hex characters: the BLAKE3 address |
| `s` | Size hint in bytes. Lets the receiver preallocate and show progress before any peer answers. Unverified until the content is complete. |
| `n` | Filename hint, percent-encoded. Display only — never used as a path without sanitising. |
| `k` | 32-byte swarm key, hex. See §4. |
| `t` | What the content is: `c` for a collection (§6). Absent means a plain file. |

A link with no parameters is valid and sufficient: everything else is an optimisation or a
privacy choice.

**Why hex and not z32.** The Holepunch convention (`hypercore-id-encoding`) renders *Hypercore
keys* as z-base-32 for users — 52 characters instead of 64, with visually ambiguous characters
removed. A swarmwire root is not a key, it is a BLAKE3 hash, and the whole world prints those as
hex: a link should be directly comparable to `b3sum <file>` output. Parsers may later accept
z32 on input; swarmwire only ever emits hex.

Unknown query parameters are ignored, so later versions can add hints without breaking today's
parsers.

## 4. Discovery

Content is found through Hyperswarm topics derived by BLAKE3 with domain separation. There are
two modes, and a peer may announce on both at once.

### Content topics — "here is a link"

```
public:   topic = BLAKE3("swarmwire/v0/discovery" || root)
private:  topic = BLAKE3("swarmwire/v0/discovery" || root || swarmKey)
```

Holding the link is enough to find peers: no topic to join, no tracker.

**Public** behaves like a magnet link: every peer holding that content, anywhere, helps — and
anyone who knows the address can discover that you have it. **Private** mixes in a 32-byte
swarm key, so only people holding the link can derive the topic. The cost is that unrelated
holders of the same content cannot help, so a private swarm is only as resilient as the people
in it.

`send` defaults to **private**. Sharing a file should not announce your holdings to anyone who
can guess the hash; `--public` opts into the wider swarm.

### Swarm topics — "here is a group of people"

```
topic = BLAKE3("swarmwire/v0/swarm" || swarmKey)
```

A swarm key identifies a *set of peers*, not a piece of content. Members announce on one topic,
stay connected, and then ask each other for roots over the existing connection.

This exists because the per-content topic does not scale to a shared workspace: a directory of
a thousand files must not mean a thousand DHT announces. Dropping a file into a shared workspace
should make it reachable by that workspace's members immediately, with no per-file setup and no
authorisation step — which is exactly what SwarmFS needs for multi-writer virtual directories.

swarmwire treats a swarm key as an opaque 32 bytes. Where it comes from — a link, a workspace,
a hypergraph context — is SwarmFS's business, not this layer's.

### Passphrases

A swarm key is 32 bytes. When a link cannot be pasted — read aloud, typed from another screen —
it may be *displayed* as a word sequence from a fixed wordlist, hyperbeam-style. That is a
display encoding of the same bytes, never a second kind of secret: words in, bytes out, same
topic. Not in v0.

## 6. Collections

A folder is shared as a **manifest**: a list of the files in it, each named by its address.
The manifest is itself content, so it has an address like anything else — sharing a folder is
sharing one link, and the receiver fetches the manifest first and then the files it names.

```json
{"swarmwire":"collection/v0","files":[{"path":"photos/one.jpg","root":"<hex>","size":70000}]}
```

The encoding is canonical, because the manifest's bytes are its identity and the same folder
must produce the same address on every machine: entries sorted by path, no incidental
whitespace, paths with forward slashes and no `.` segments. A folder packed on Windows and the
same folder packed on Linux have the same address.

**Paths are validated, never repaired.** A manifest arrives from a stranger, and a path is
refused — rather than normalised — if it is absolute, contains `..`, is empty, carries a drive
letter or control characters, or is simply not already canonical. Quietly turning
`/etc/passwd` into `etc/passwd` would write somewhere the sender did not name. Two entries for
the same path are refused too, since which one won would otherwise depend on arrival order.

Collections are immutable, like everything else here: change a file and you have a different
manifest with a different address. Folders that change are SwarmFS's problem, one layer up.

**Discovery:** only the manifest's root is announced. The files are fetched over the
connections that topic already produced, so a folder of a thousand files still costs one
announce.

## 5. Stability rules

**Fixed for v0 — changing any of these invalidates existing links:**

- The address is the plain BLAKE3 hash of the content
- The link scheme, the hex encoding of the root, and the meaning of `s`, `n`, `k`, `t`
- The collection manifest's encoding, including that entries are sorted by path
- The domain-separation strings `swarmwire/v0/discovery` and `swarmwire/v0/swarm`

**Free to change at any time** (negotiated per connection, never stored in a link): chunk group
size, request block size, wire messages, scheduling, how outboard trees are cached, the sidecar
format for partial downloads.

Protocol messages carry a version and a capability set in the handshake. Unknown message types
are ignored rather than treated as errors, so new message types never break old peers.

## Open questions

1. **Which wordlist** for passphrases — BIP39 (2048 words, widely implemented, 24 words for 32
   bytes) or a shorter custom list. Deferred until the feature is actually built.
2. **Should a peer announce partial content on the content topic?** Announcing while still
   downloading helps the swarm, but tells the topic you are interested before you have anything.
   Measure in M2.
3. **Per-size default group size.** A single 16 KiB default is one less rule to remember; a
   size-dependent default keeps outboards small for very large files. Decide with the benchmark.
