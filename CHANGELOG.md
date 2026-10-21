# Changelog

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
