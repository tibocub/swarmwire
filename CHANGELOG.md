# Changelog

## 0.1.0

First publication, as `swarmwire-lib`.

- Added `docs/contract.md`: what applications can rely on, supply and must not expect, with
  a test that keeps its export list true.
- Removed the `swarmwire` command from the package (`bin`). The command-line tool is moving to
  its own package, `swarmwire-cli`.
- The package now publishes only `index.js`, `lib/` and the format and contract documents.
