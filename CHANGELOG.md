# Changelog

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
- `docs/contract.md`: peer activity and the file-list reader move from planned to *exists*;
  hints and admission are now planned for feature 003.

## 0.1.0

First publication, as `swarmwire-lib`.

- Added `docs/contract.md`: what applications can rely on, supply and must not expect, with
  a test that keeps its export list true.
- Removed the `swarmwire` command from the package (`bin`). The command-line tool is moving to
  its own package, `swarmwire-cli`.
- The package now publishes only `index.js`, `lib/` and the format and contract documents.
