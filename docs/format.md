# The swarmwire format — v0 (DRAFT)

Everything here ends up inside links that people share and store. Links must keep working after
the engine has been rewritten three times, so this document changes slowly and deliberately,
and everything in it is pinned by tests in `test/unit/`.

**Status: draft.** Open questions are listed at the bottom; they must be closed before the first
link is shared outside a test.

## 1. Addressing

**A content address is the 32-byte BLAKE3 hash of the content.** Nothing custom, nothing
swarmwire-specific: it is the value `b3sum` prints, and the value iroh and any other BLAKE3 tool
agree on.

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
implemented by `blake3-bao`.

- A sender keeps an **outboard** tree for the content it serves — hashes only, no data copy.
- For a requested byte range, the sender produces a **slice**: the range plus the minimal set of
  tree nodes proving it belongs to the root.
- The receiver verifies each slice against the root **before writing it to disk**. A peer that
  sends one bad byte is caught immediately, not at the end of the transfer.

**Chunk groups.** Standard bao verifies at 1 KiB granularity, which makes the outboard tree
large (~6% of content size). Grouping chunks shrinks it dramatically while keeping the same root
hash:

| Group size | Outboard for 1 GiB | Smallest verifiable unit |
|---|---|---|
| 1 KiB (plain bao) | ~64 MiB | 1 KiB |
| 16 KiB (iroh default) | ~4 MiB | 16 KiB |
| 256 KiB | ~256 KiB | 256 KiB |

Group size is **a per-transfer parameter, not part of the address** — the root is identical
either way. The serving peer advertises its group size in the handshake; the receiver verifies
at that granularity. Permitted values: powers of two from 16 KiB to 1 MiB.

## 3. Links

```
swarmwire://<root-hex>[?s=<size>][&n=<name>][&k=<secret-hex>]
```

| Part | Meaning |
|---|---|
| `root-hex` | 64 lowercase hex characters: the BLAKE3 address |
| `s` | Size hint in bytes. Lets the receiver preallocate and show progress before any peer answers. Unverified until the content is complete. |
| `n` | Filename hint, percent-encoded. Display only — never used as a path without sanitising. |
| `k` | 32-byte private-swarm secret, hex. See below. |

A link with no parameters is valid and sufficient: everything else is an optimisation or a
privacy choice.

## 4. Discovery

The Hyperswarm topic is derived from the address, so holding a link is enough to find peers —
there is no separate topic to join, and no tracker.

```
public:   topic = BLAKE3("swarmwire/v0/discovery" || root)
private:  topic = BLAKE3("swarmwire/v0/discovery" || root || secret)
```

**Public** behaves like a magnet link: every peer holding that content, anywhere, helps —
and anyone who knows the address can discover that you have it.

**Private** puts a random 32-byte secret in the link. Only people you sent the link to can
derive the topic and find you. The cost is that unrelated holders of the same content cannot
help, so a private swarm is only as resilient as the people in it.

`send` defaults to **private**, because the person sharing a file usually does not intend to
announce their holdings to anyone who can guess the hash. `--public` opts into the swarm.

This derivation is the one piece of hyperbeam's design worth copying: one string is both the
rendezvous and the secret.

## 5. Stability rules

**Fixed for v0 — changing any of these invalidates existing links:**

- The address is the plain BLAKE3 hash of the content
- The link scheme, the hex encoding of the root, and the meaning of `s`, `n`, `k`
- The two topic-derivation strings

**Free to change at any time** (negotiated per connection, never stored in a link): chunk group
size, block size, wire messages, scheduling, how outboard trees are cached, the sidecar format
for partial downloads.

Protocol messages carry a version and a capability set in the handshake. Unknown message types
are ignored rather than treated as errors, so new message types never break old peers.

## Open questions

1. **Hex or z32 for the root in links?** Hex is 64 characters and trivially debuggable; z32 is
   52 and is what the Holepunch ecosystem uses elsewhere. Hex is assumed above.
2. **Should `send` default to private?** Assumed yes above. Private is safer but weaker: no
   help from unrelated holders of the same content.
3. **Do we want a short human-sayable code**, hyperbeam-style ("brave-lion-42"), as an
   alternative to a link? It needs a rendezvous that maps the phrase to the address, which is a
   different mechanism from content addressing — probably M3 or later, probably in SwarmFS.
4. **Default chunk group size.** 16 KiB matches iroh and keeps proofs small for small files;
   256 KiB keeps outboards tiny for very large files. A size-dependent default is possible but
   adds a rule to remember.
