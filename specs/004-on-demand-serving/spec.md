# Feature Specification: On-Demand Serving

**Feature Branch**: `004-on-demand-serving`

**Created**: 2026-10-27

**Status**: Implemented (0.6.0)

**Input**: SwarmFS `specs/requests-to-swarmwire.md`, items S2, S3 and S5, plus "no announce per
file" (AGENTS.md rule 6 by construction).

## Why

A SwarmFS device hosts everything it holds: thousands of files. `serve(path)` announces each
file on the DHT and hashes and opens it up front, which does not scale. SwarmFS peers already
meet through one hypergraph space topic, so swarmwire must not join any topic of its own there,
and must find a file only when a peer asks for it.

## User Stories

### US1 - No topic of swarmwire's own (P1)

The application supplies a network whose `join()` goes nowhere and whose `connection` event emits
the streams it chooses. Serving, downloading, folders and list reads all work over those
connections and no topic reaches the DHT.

**Acceptance**: two nodes on one application-owned topic serve and fetch a file, a folder list,
one listed file and a whole folder; afterwards each peer is on that topic only.

### US2 - Serve on demand (P1)

`new Swarmwire({ resolve })`, `resolve(rootHex) → path | null` (sync or async), is called when a
connected peer wants a root nothing is serving. The file is opened and hashed then and served
only if its root matches. Otherwise, or when `resolve` returns null or throws, the answer is
exactly "not held". At most `maxOpen` such files stay open (least recently used closed); nothing
is kept for a root nobody asked for.

**Acceptance**: a resolved file arrives intact and `resolve` is not called before anyone asks; a
changed file, a null and a throwing resolver all answer "not held" with no bytes sent; with
`maxOpen: 2` and three files, never more than two are open, and an evicted one is reopened.

### US3 - Download to a temporary name (P2)

`temporary: true` (node default or per download) writes to `<path>.part`, with the resume record
beside it, and renames to `<path>` once every group is verified. Off by default.

**Acceptance**: mid-transfer and after `stop()` nothing exists at `<path>`; the same `download()`
resumes from the `.part`; at the end `<path>` is byte-identical and no `.part` files remain.

### US4 - A fetch that can end (P2)

A `Download` emits `stalled` as soon as every peer it asked said it holds none of the content,
without waiting for a timeout. `stop()` keeps the resume record (already proved in
`test/swarm/transfer.test.js` and `test/swarm/list.test.js`).

**Acceptance**: two peers that do not hold the content; `stalled` fires with the clock at 0.

## Out of scope

- S1 (run over an application channel, `addPeer`/`removePeer`): the network adapter already
  carries SwarmFS's streams; a channel API is a separate feature.
- S4 (persistent hash cache).
- Admission and peer hints (now planned as 005).
