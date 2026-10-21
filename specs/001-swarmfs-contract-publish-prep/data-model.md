# Data Model: SwarmFS Contract and Publish Prep

No runtime data is added. These are the things the contract and the release talk about.

## Capability entry (a row in the contract's table)

| Field | Meaning |
|---|---|
| name | Short name, e.g. "peer hints" |
| status | `exists` or `planned` |
| feature | For `planned`: the feature that delivers it (e.g. `002-library-changes`) |
| semantics | The rules the application can rely on, one to three sentences |
| test | For `exists`: the test file that proves it |

Rule: a row with `status: exists` MUST name a passing test (SC-002); a `planned` row MUST name a
feature.

## Hint

Information from the application. Kinds: **preferred peers** (public keys), **priorities**
(which content first). Rules: never required; wrong or stale hints cost time at most; a peer hint
changes the order in which already-connected peers are asked and never causes a connection.

## Admission decision

- **Inputs**: the requesting peer's public key, the content root requested, and the folder root it
  was requested through (absent for a plain file).
- **Output**: allow or deny.
- **Rules**: decided per content root; deny on error, on timeout, or when no answer arrives; a deny
  is answered exactly as content that is not held, so it leaks no existence, size or name; with no
  decision installed, content is served as today.

## Peer activity

- **Events**: a peer connected, a peer disconnected.
- **Counts**: connected peers, and how many of them hold the whole content, for one content root.
- **Rules**: direct connections only; a snapshot that may lag; excludes peers not connected.

## Folder file list

For a folder link: the list of `{path, root, size}` entries, readable without downloading any file
content. The application downloads any listed file individually. Not yet public.

## Package release

| Field | Value |
|---|---|
| name | `swarmwire-lib` |
| version | `0.1.0` first |
| files | `index.js`, `lib/`, `docs/format.md`, `docs/contract.md` (+ README, LICENSE, package.json) |
| engines | node >= 20, bare >= 1.16 |
| state | draft, then checked (`check-pack`), then published, then possibly deprecated |
