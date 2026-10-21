# Data Model: Peer Events, Counts and Folder File List

Nothing is persisted. Everything lives in memory for the life of a `Swarmwire` node.

## Peer (extended)

| Field | Meaning |
|---|---|
| id | hex public key; one entry per distinct id |
| channel | the channel this entry belongs to; a close of any other channel is ignored |
| ready | true once the remote's `handshake` arrived; only ready peers are reported or counted |
| wants | roots the peer asked about (existing) |
| holdings | `Map<rootHex, Holding>` |

Transitions: connected (not ready) -> ready (handshake; emits `peer-connected`) -> gone (close of its
own channel; emits `peer-disconnected` only if it was ready; its holdings are dropped).

## Holding

`{ size, bits, count }`: the bitfield a peer reported for one root, and how many bits are set.

- Set by `have` (replaces), grown by `holds` (set one bit; `count` rises only if the bit was clear),
  deleted by `unavailable`.
- Complete when `count` equals the group count for `size`. Incomplete but `count > 0` is partial.
  `count == 0` after a `have` counts as nothing held.

## Counts

`{ peers, seeders, leechers }`, all non-negative integers, computed on demand.

- `peers`: number of ready peers.
- file root: seeders = peers with a complete Holding; leechers = peers with a partial one.
- folder link: seeders = peers complete on the manifest and every listed file; leechers = peers with
  any non-empty Holding on the manifest or a listed file who are not seeders.
- Unknown root, or folder whose list is not known yet: `seeders` and `leechers` are 0.
- Invariant: `seeders + leechers <= peers`.

## Folder file list

`{ files: ListedFile[], size }` where `size` is the sum of the files' sizes.

**ListedFile**: `{ path, root, size }`, exactly the manifest entry: `path` relative and canonical
(validated by `decodeManifest`), `root` 64 lowercase hex, `size` a non-negative integer. A listed
file plus the folder link is enough for `downloadFile`.

## Watch set

Roots the node sends `want` for on its own account (served roots; a served or read folder's manifest
and file roots). Skipped for roots with an active `Download`.

## Listing

A thenable with `stop()`, like `Download`. States: waiting (no peer has the list) -> done (resolves to
the folder file list) | failed (not a folder link; stopped). Bytes that do not match the address
are refused and the Listing keeps waiting for another peer; a list that matches but is unsafe or
too large fails the read. `stop()` resolves it to `undefined`.
