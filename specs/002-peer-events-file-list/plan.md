# Implementation Plan: Peer Events, Counts and Folder File List

**Branch**: `002-peer-events-file-list` | **Date**: 2026-10-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-peer-events-file-list/spec.md`

## Summary

Add peer connect and disconnect events, a peer count, seeder and leecher counts (per file and per
folder), a look-only folder file-list reader, and a helper to download one listed file. **No wire
change**: a serving node learns what its peers hold by sending the ordinary `want` for the roots it
serves, which peers already answer with `have`, `holds` or `unavailable`. The list reader fetches the
file list into memory through a new in-memory destination, never touches disk, and joins the topic
without announcing. Whole-folder download is rebuilt on the same reader. `lib/swarmwire.js` is already
841 lines against a guideline of about 300, so the new logic goes into new files and the existing file
only gains thin hooks.

## Technical Context

**Language/Version**: JavaScript (ESM), Node >= 20 and Bare >= 1.16, no build step

**Primary Dependencies**: unchanged. No dependency is added.

**Storage**: none new. The list reader holds the file list in memory.

**Testing**: `brittle`. Counts logic as pure unit tests; events, counts, the list reader, look-only
join and partial download on the deterministic network in `test/swarm/`; one real-swarm check in
`test/net/`. Everything also runs on Bare.

**Target Platform**: Node 20/22 and Bare, Linux and Windows (existing CI matrix)

**Project Type**: library

**Performance Goals**: no regression in `npm run bench` (requests per file, wasted requests, proof
overhead); the extra `want` messages must not change those numbers.

**Constraints**: Bare-safe (no `Buffer`, no `node:` imports, no `AbortController`-style globals);
no wire change (Invariant 5 untouched); a served folder costs one announce, not one per file
(Invariant 6); manifest paths validated, never repaired (Invariant 4).

**Scale/Scope**: counts for up to 64 direct peers (Hyperswarm's default connection cap, believed,
unverified); folders up to tens of thousands of files.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1.*

| Principle | Result |
|---|---|
| I. AGENTS.md authoritative | Pass. Invariant 1 to 4 untouched. Invariant 5: no new message, so nothing to ignore. Invariant 6: wants are sent over existing connections, no extra announce, and the reader announces nothing. Invariant 3 (read in place) unaffected. |
| II. Moves bytes, nothing else | Pass. Counts describe direct connections only and say so; no tracker, no global view. Choosing files stays with the application. |
| III. Hints add options | Pass. No hint is involved. A peer that never answers a `want` is simply uncounted. |
| IV. Test-first, proved on harness | Pass, with new harness work: `join` gains a look-only mode and the test network learns it (research item 6). Every behaviour, including an abrupt disconnect and a duplicate connection, gets a `test/swarm/` test before the code. `npm run bench` is re-run for SC-006. |
| V. A published API is a promise | Pass. New public API is listed in the contract in the same change; the changelog gets a 0.2.0 entry (a new minor, since `downloadCollection` changes internally and the contract rows move). |
| Constraints (Bare, deps, size) | Pass. New logic in new files (`lib/holdings.js`, `lib/listing.js`); `swarmwire.js` only gains calls. |

Post-design re-check: unchanged. One item to watch: `Download` currently assumes a file destination
(research item 5); if making it destination-agnostic grows beyond a small change, stop and revisit
rather than fork it.

## Project Structure

### Documentation (this feature)

```text
specs/002-peer-events-file-list/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── api.md              # public API draft; becomes part of docs/contract.md
└── tasks.md                # /speckit-tasks
```

### Source Code (repository root)

```text
lib/
├── holdings.js             # NEW: per-peer holdings, the watch set, the seeder/leecher counting
├── listing.js              # NEW: Listing (thenable list reader) and MemoryDestination
└── swarmwire.js            # EDIT: EventEmitter, peer events, holdings hooks, wants for served
                            #       roots, readList, downloadFile, downloadCollection on top of them
index.js                    # EDIT: export anything new (Listing if public)
test/
├── helpers/network.js      # EDIT: join(topic, {server, client}) returns a session; client-only pairs do not meet
├── unit/holdings.test.js   # NEW: counting rules, no I/O
├── swarm/peers.test.js     # NEW: events, counts, duplicate connection, abrupt loss
├── swarm/list.test.js      # NEW: list read, nothing on disk, unsafe paths, look-only, subset
└── net/real-swarm.test.js  # EDIT: one check on a real swarm (events and counts)
docs/
├── contract.md             # EDIT: rows planned -> exists, sections 3.3 and 3.5, proofs
└── format.md               # EDIT: correct the handshake sentence (research item 10)
CHANGELOG.md                # EDIT: 0.2.0
```

**Structure Decision**: single library, as today. New behaviour in two new small files.

## Complexity Tracking

No violations to justify.
