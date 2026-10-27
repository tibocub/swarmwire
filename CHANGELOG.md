# Changelog

## 0.6.0

- **Serve on demand.** `new Swarmwire({ resolve, maxOpen })`: `resolve(root)` (may be async) maps a
  root nobody is serving to a path when a peer asks for it. The file is opened and hashed then and
  served only if it still has that root; otherwise it is answered as not held. At most `maxOpen`
  (64) such files stay open. A device can host thousands of files without opening or announcing
  any of them.
- **No announce of its own**, documented and proved: given a network whose `join` goes nowhere,
  nothing swarmwire does joins a topic; it talks only to the connections it is handed.
- **Download to `<path>.part`** with `temporary: true` (constructor or per `download`), renamed
  into place once verified. Off by default.
- A download now emits `stalled` as soon as every peer it asked said it does not hold the
  content, instead of only after timeouts.
- A read failing on a source closed meanwhile is answered with a refusal, not an unhandled
  rejection.
- `docs/contract.md`: admission and peer hints are now planned for feature 005.

## 0.5.0

- `serveCollection(null, { name, files: [{ path, from }] })` serves a folder from an explicit list of
  files instead of walking a directory. `from` may be an `fd:N` descriptor, so a folder an Android
  app can only reach file by file can be shared.
(0.4.1 added `fd:N` paths for single files.)

## 0.4.0

- **Serving a large file is no longer slow.** Every proof recomputed the hash of every subtree from
  the leaves, so each group served cost time proportional to the file's size: a 300 MB file
  was served at under 1 MB/s with the sender's processor full. Larger subtrees are now
  remembered, and a proof costs about a dozen hashes. The same 300 MB transfer on one machine
  went from over 90 s to 22 s.
- `downloadCollection(link, dir, { onprogress })` reports `{ bytes, total }` for the whole folder as
  bytes arrive, first with `bytes: 0` once the list is known.
- Not shipped: `npm run bench:sim` gained a `hotswap` strategy and `--slow` peers, and
  `docs/research/p2p-landscape.md` records what other peer-to-peer systems do.

## 0.3.0

- **Downloads no longer proceed roughly in file order.** A download scans for wanted groups from
  a random place in the file and orders equally rare groups at random. A crowd of newcomers therefore spreads a seeder's uploads
  over the whole file instead of all asking for its first groups. Fixed along the way: a peer
  holding only groups beyond the first 256 missing was asked for nothing.
- Per-group availability counts replace a loop over every peer for every candidate group.
- `npm run bench:sim` (not shipped): a seeded model of a large swarm comparing selection
  strategies. `docs/scaling.md` records the numbers and why endgame mode and both kinds of
  super-seeding were not built.
- `docs/contract.md`: download order added; hints and admission are now planned for feature 004.

## 0.2.0

- `Swarmwire` is now an event emitter: `peer-connected` and `peer-disconnected`, each `{ id }`,
  fired once per distinct peer that completed the handshake. New `peerCount` and
  `counts(link)`, which gives `{ peers, seeders, leechers }` for a file or folder over direct
  connections. A node that only serves now learns what its peers hold (it sends the ordinary
  `want`; no wire change).
- New `readList(link)`: a folder's files, sizes and total without fetching any content, held in
  memory, looking for peers without announcing. New `downloadFile(link, file, outPath)` to
  fetch one listed file.
- `downloadCollection` now reads the list through `readList`'s code. It behaves as before.
- Fixed: a peer's old connection closing no longer removes the peer when a newer connection
  from the same key replaced it.
- Fixed: stopping a download, or unserving content, now leaves only its own announce session.
  It used to leave the whole topic, which also dropped other users of it.
- `docs/contract.md`: peer activity and the file-list reader move from planned to *exists*;
  hints and admission are now planned for feature 003.

## 0.1.0

First publication, as `swarmwire-lib`.

- Added `docs/contract.md`: what applications can rely on, supply and must not expect, with
  a test that keeps its export list true.
- Removed the `swarmwire` command from the package (`bin`). The command-line tool is moving to
  its own package, `swarmwire-cli`.
- The package now publishes only `index.js`, `lib/` and the format and contract documents.
