# Research: Peer Events, Counts and Folder File List

Checked against the repository on 2026-10-21 unless marked unverified.

## 1. How a serving node learns what peers hold (FR-004b)

- **Finding**: a peer only receives another's holdings if it sent `want`. In `_onWant` the answerer
  replies `have` (with a bitfield) or `unavailable`, and records `peer.wants` so `_announceHolds`
  later pushes `holds` to exactly those peers. A node that only serves never sends `want`, so it
  never hears from its receivers.
- **Decision**: no new message. A node sends `want` for every root it serves (and, for folders, the
  manifest and each file root) to each connected peer and to each peer that connects later. Peers
  answer with what they already send today.
- **Rationale**: zero wire change means no version question, no old-peer behaviour to test, and
  nothing to document in `docs/format.md`. An old peer behaves identically because `want` is its
  existing message.
- **Alternatives**: a new `status` message (rejected: needs a protocol decision, and protomux
  identifies messages by position so it must be appended to `ORDER`; unknown-message handling in
  protomux was not verified); piggy-backing on `handshake` (rejected: it is sent once, before any
  content is held).
- **Cost**: one `want` per watched root per peer, roughly 40 bytes. A 10,000-file folder served to
  64 peers is about 25 MB of `want` traffic on connect. Acceptable now; marked as a shortcut in the
  code (`shortcut: wants for every file of a served folder; watch lazily if folders grow past ~10k`).
- **Side effect**: each answerer adds the sender to `peer.wants` and then sends a `holds` per group it
  verifies. About 40 bytes per group per watching peer.

## 2. What counts as a peer, and the events (FR-001 to FR-003)

- **Finding**: `_onPeer` registers a peer when a connection opens, before the remote has said
  anything. `onhandshake` is a no-op. A connection to something that does not speak swarmwire would
  still be in `this.peers`.
- **Decision**: a peer is *ready* when its `handshake` arrives. `peer-connected` is emitted then,
  `peerCount` counts ready peers, and `peer-disconnected` is emitted on close only for peers that
  were ready. `Swarmwire` becomes an `EventEmitter`, as `Download` already is.
- **Event names and payload**: `peer-connected` and `peer-disconnected`, each `{ id }` where `id` is
  the hex public key, the same id used everywhere else.
- **Alternatives**: callbacks passed to the constructor (rejected: two consumers cannot both
  listen); emitting on raw connection (rejected: violates FR-002).

## 3. A latent bug the duplicate-connection edge case exposes

- **Finding**: `_onPeerGone(id)` deletes `this.peers[id]` unconditionally. If a second connection with
  the same key replaces the first in the map, the first's close then deletes the live entry. Hyperswarm
  deduplicates connections to the same key by closing one, so this is reachable.
- **Decision**: remember the channel each peer entry belongs to; on close, delete only if the closing
  channel is the registered one; otherwise ignore. Counts are of distinct ids by construction (the
  map is keyed by id). Test: two connections with one id, close the first, the peer remains and no
  disconnect is emitted.
- **Unverified**: whether the harness can open two connections between the same pair. If not, the
  test drives `_onPeer` with two duplex pairs directly.

## 4. Where holdings live and how counts are computed (FR-004 to FR-007)

- **Decision**: new `lib/holdings.js`. Per peer, per root: `{ size, bits, count }`, set from `have`,
  grown by `holds`, deleted by `unavailable` and when the peer leaves. A file is **complete** for a
  peer when `count` equals the group count for `size`. `Download` keeps its own bitfields untouched;
  the node records every `have` and `holds` in addition.
- **Rules (pure, unit-tested)**:
  - file: seeders are peers with a complete holding; leechers are peers with a non-empty holding that
    is not complete; everyone else is in neither.
  - folder: seeders hold the manifest and every listed file completely; leechers hold anything of the
    folder but are not seeders; a peer holding only the manifest is a leecher (clarification).
  - `peers` is `peerCount`.
- **Where the folder list comes from**: a cache `lists: manifestRoot -> entries`, filled by
  `serveCollection`, `readList` and `downloadCollection`. Counts for a folder whose list is not known
  return zeros, no error (edge case).
- **Memory**: a bitfield is `groups / 8` bytes per peer per root: 8 KB per GiB. 64 peers on a 100 GiB
  folder is about 50 MB. Marked as a shortcut (`shortcut: full bitfields per peer; keep a count plus
  a sparse set if folders reach terabytes`).
- **Duplicate memory** for roots under download (the `Download` also holds them): accepted, tiny.

## 5. The list reader: memory, not disk (FR-008 to FR-011a, FR-014)

- **Finding**: `_fetchManifest` downloads the manifest to a scratch file and reads it back.
  `Download` is coupled to `Destination`: it calls `Destination.open(path)`, reads `.tree`, `.finish()`,
  `.close()`, and `_adopt(root, path, tree)` to keep serving from disk. The manifest limit is 64 MiB
  (`MAX_MANIFEST_BYTES`).
- **Decision**: a `MemoryDestination` in `lib/listing.js` implementing the same surface (`has`,
  `missing`, `bitfield`, `put` with verification, `proof`, `readGroup`, `finish`, `close`, `tree`,
  `complete`), and `Download` takes an optional destination factory and an `adopt: false` flag. The
  reader is a `Listing`: a thenable like `Download`, with `stop()`, resolving to
  `{ files, size }`.
- **Why a thenable with `stop()` and not an abort signal**: `Download` already works that way, and
  `AbortController` availability on Bare was not verified.
- **Validation**: the bytes go through `decodeManifest`, which already refuses absolute, parent,
  drive-letter, control-character, duplicate and non-canonical paths and oversized manifests.
- **A bad list**: bytes that do not match the root fail verification inside the destination, so a
  lying peer gains nothing and another peer supplies the list (`_liars`, per `Download`). Bytes that
  *do* match the root but fail `decodeManifest` (an unsafe path) are the folder's real content, so no
  other peer can have a different list: the read **rejects**, exactly as `downloadCollection` always
  has. (Corrected during implementation; the first draft said it would keep waiting.)
- **Risk**: if giving `Download` a pluggable destination turns out to be more than a small change,
  fall back to a scratch file in the OS temp directory and relax FR-008 to "writes nothing next to the
  destination". That is a spec change and needs the user's decision, so it is not the plan.
- **`downloadCollection`**: keeps announcing on the folder's topic while it downloads (so a folder
  downloader still seeds), and reads the list through the same internal function as `readList`; only
  the public `readList` is look-only.

## 6. Look-only join (FR-011a)

- **Finding**: every `join` in the library is `join(topic)`. Hyperswarm's `join` accepts
  `{ client, server }`. *Unverified against the installed version's source*; the first task checks
  `node_modules/hyperswarm`.
- **Decision**: the reader calls `swarm.join(topic, { server: false, client: true })`. The test
  network's `TestPeer.join(topic, { server = true, client = true } = {})` records the mode, and
  `_discover` only connects a pair that share a topic where at least one side is a server for it.
- **Leaving**: Hyperswarm's `join` returns a per-caller session (`discovery.session(opts)`); `session.destroy()` leaves only that session, while `swarm.leave(topic)` destroys the discovery for every session on the topic. The reader keeps its session and destroys it, and never calls `swarm.leave`. No reference counting is needed. (`Download.stop` used to call `swarm.leave?.(topic)`, which dropped other sessions on that topic too. Fixed in the same release: the node now keeps each announce session and ends only its own.) The harness's `join` returns the same kind of session handle.
- **Test of "does not appear as a provider"**: a third peer doing a lookup on the topic finds only the
  real server, not the reader (FR-011a, scenario 5).

## 7. Counts for a downloading node

- **Finding**: a `Download` asks peers for the file it is fetching, so it hears `have` and `holds`
  for that root. For a folder download it only asks about the current file.
- **Decision**: once the list is known, the node sends `want` for every listed file root in addition
  (watch), using the same mechanism as for serving. Roots with an active `Download` are skipped
  because the `Download` already sent that `want`.

## 8. Downloading chosen files (FR-012, FR-013)

- **Decision**: `node.downloadFile(folderLink, file, outPath)` builds the existing
  `{ root, size, secret, name }` link object from the folder link and a listed file, and calls
  `download(..., { announce: false })`. No new mechanism. FR-013 holds because nothing requests an
  unchosen file's groups; the test asserts it by counting `request` frames per root on the harness.

## 9. Benchmarks

- **Decision**: run `npm run bench` before the first change and after the last, and compare requests,
  wasted requests and proof overhead (SC-006). The added `want` and `holds` traffic is outside those
  counters, but the check proves it.

## 10. Documentation drift found

- `docs/format.md` says handshakes carry "a version and a capability set". The code's handshake
  carries `version` and `groupLog` only. Correct the sentence in this change rather than describe a
  capability set that does not exist.
- `AGENTS.md` says the wire has six messages; `wire.js` has eight. Not changed here beyond what the
  feature touches; flagged for the owner.

## 11. Version

- **Decision**: 0.2.0. New public API and a changed `downloadCollection` internals warrant a minor
  under 0.x (releasing.md rule).

## Verified (T003, 2026-10-21)

- **Look-only join**: `node_modules/hyperswarm/lib/peer-discovery.js` `session({ server, client })`; a
  discovery announces only while `_serverSessions > 0`, so `{ server: false, client: true }` looks
  up without announcing. `session.destroy()` drops only that session.
- **Harness duplicates**: `TestNetwork._discover` skips a pair that already has `_connections`, so
  the harness cannot open two connections between one pair. The duplicate-connection test drives
  `node._onPeer` with a second stream directly.
- **`_liars`**: a per-`Download` set, filled in `Download._onData` when `destination.put` rejects a
  group (`lib/swarmwire.js`). The list reader inherits it by being a `Download`.
- **Baseline** (before any change): `npm test` 41/41 tests, 99/99 asserts; `npm run bench` ran clean.
  Output kept in the session scratchpad (`baseline-test.txt`, `baseline-bench.txt`).
- `bao.countSetBits(bitfield, numBits)` exists and is reused for the holdings count.

## Implementation notes (2026-10-21)

- **`holds` needs a base**: a peer that first answered `unavailable` and then began downloading only
  ever sends `holds`. `Holdings.grow` builds an empty holding from the size the node already knows
  (the root it serves or watches), otherwise a serving node would never see that peer progress.
- **Bench**: the `ticks` columns of `npm run bench` measure time to network idle, which now includes
  the trailing `want`/`holds` frames. Time to *completion* is within 0.4% of the baseline (checked
  with a temporary copy of the bench); only the pinned window=1 case moves (+2.3%), because the test
  network charges every frame at least one tick and each group now also sends a small `holds`.
  Requests, wasted requests and proof overhead are identical.
- **Shared list read**: two callers asking for the same folder's list at once share one `Listing`,
  and so share `stop()`.
- **A file download of a folder's own list root** (`download(folderLink)`) at the same time as a
  `readList` of it is refused by the reader: both cannot own the root's `Download`.
