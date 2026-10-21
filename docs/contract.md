# swarmwire contract

What an application built on `swarmwire-lib` (SwarmFS, `swarmwire-cli`, anything else) can rely on,
what it can supply, and what swarmwire will never do. Only what is listed here is stable.
Version 0.x: a minor release may change anything marked *exists* if this document and the
changelog say so; anything marked *planned* is a direction, not a promise.

## 1. Summary

swarmwire takes a content root (a plain BLAKE3 hash) and returns verified bytes on disk, from
whichever connected peers hold them. The application owns the network connection, keys, names,
directories, users and permissions. A "folder" in this document is called a *collection* in the
code (`serveCollection`, `downloadCollection`). See `AGENTS.md` for the invariants this contract rests on.

## 2. Capabilities

| Capability | Status | Delivered by | Proof |
|---|---|---|---|
| Serve a file in place, download by link, resume, verify every range | exists | - | `test/swarm/transfer.test.js` |
| Serve and download a folder as one link | exists | - | `test/swarm/collection.test.js` |
| Partial seeding: a download in progress serves what it holds | exists | - | `test/swarm/partial.test.js` |
| Application supplies the network connection (any object with `join(topic, opts)` returning a session with `destroy()`, and a `connection` event; Hyperswarm is one) | exists | - | `test/helpers/network.js`, `test/net/real-swarm.test.js` |
| Peer identity: the remote public key of the connection | exists | - | `test/swarm/transfer.test.js` |
| Peer activity events, peer count, seeder and leecher counts | exists | - | `test/swarm/peers.test.js` |
| Folder file-list reader (look-only, in memory), and downloading one listed file | exists | - | `test/swarm/list.test.js` |
| Download order spread by random choice (no two newcomers ask for the same thing first) | exists | - | `test/swarm/spread.test.js` |
| Peer hints (preferred peers, priorities) | planned | 004 | - |
| Admission decisions | planned | 004 | - |

## 3. Rules the application can rely on

### 3.1 Hints add options, never correctness

A transfer completes correctly when every hint is wrong or stale. A hint cannot stall a transfer.
A **peer hint** only changes which already-connected peers are asked first; swarmwire never dials
a peer because of a hint. The application dials through the connection it owns.

### 3.2 Admission

The application can decide, per peer and per content, whether content is served.

- Decided **per content root**. Each file of a folder is its own root and is decided separately;
  the decision is told which folder root the file was requested through, if any. The folder's own
  file list is content too, with its own root, and is decided like any other root.
- **Deny on failure**: a decision that throws, times out or never answers is a deny. How long a
  decision may take is an option of the admission mechanism, set by the application (its
  default is chosen when the mechanism is built); the contract promises only that running out
  of time is a deny.
- A deny is answered **exactly as content swarmwire does not hold**. A refused peer learns nothing
  about what is held, its size or its name.
- With no decision installed, content is served as it is today.
- A folder where some files are allowed and some denied transfers the allowed ones; the denied
  ones read as absent, and the folder download reports which were unavailable.

### 3.3 Peer activity

`Swarmwire` is an event emitter.

- `peer-connected` and `peer-disconnected`, each with `{ id }` (the remote public key, hex). Each
  fires **once per distinct peer**, and only for a peer that completed the swarmwire handshake: a
  connection that never speaks the protocol is neither announced nor counted. Two connections
  from one key are one peer. A peer that vanishes without closing is reported when its connection
  closes; `peerCount` is already correct when the event fires.
- `peerCount`: connected peers, never negative.
- `counts(link)` returns `{ peers, seeders, leechers }` for a file or folder link, synchronously.
  A **seeder** holds all of it, a **leecher** holds part, and a peer that has said nothing about
  that content is in `peers` only. For a folder, a seeder holds the file list and every listed
  file; a peer holding the list alone is a leecher. Content the node knows nothing about, and a
  folder whose list is not yet known, give zeros, never an error.
- A node that only serves still learns what its peers hold: it asks each connected peer about
  the content it serves, with the ordinary `want` message. No message was added. A peer that does
  not answer is simply uncounted.

**Direct connections only**: a snapshot that may lag, not a count of the swarm. Global counts and
chunk rarity across the network are a tracker's job, not swarmwire's.

### 3.3a Download order

Groups are fetched rarest first, equal rarity broken at random, starting from a random place in
the file. **A download does not proceed in file order**: a file is complete when every group is
held, and nothing is promised about reading it while it downloads. How the choice was made, and
what was measured, is in `docs/scaling.md` in the repository (not part of the package).

### 3.4 Identity

swarmwire knows the remote public key of each connection and nothing else about a peer. Tying a
key to a user or device is the application's job (Principle II).

### 3.5 Choosing files of a folder

`readList(link)` reads a folder's file list without fetching any content: it resolves to
`{ files: [{ path, root, size }], size }`, and `stop()` gives up waiting, like a download. It
writes nothing to disk and only **looks** for peers: it never announces this node as a provider.
A link that is not a folder is refused, and so is a list with an unsafe path (the same paths a
whole-folder download refuses; nothing is repaired). `downloadFile(link, file, outPath)` then
downloads one listed file, using only the folder's link and the list entry, and does not announce
it separately. Which files, and any interface for choosing, belong to the application.

### 3.6 The shared connection

The application creates and destroys the swarm, owns its keypair, and may use the same connections
for other protocols. swarmwire attaches to the `connection` event and leaves the connection alone
when it is destroyed.

## 4. What swarmwire will not do

| Not in swarmwire | Where it lives |
|---|---|
| Names, directories, mutable references | SwarmFS |
| Users, devices, permissions (it only asks, via admission) | Hypergraph, SwarmFS |
| A tracker, global peer counts, global chunk rarity | SwarmFS (coarse, per file), not per chunk |
| Choosing which files of a folder to download | SwarmFS or the CLI |
| Storing content in a core, blob store or database | never |

## 5. Exports

The importable surface of `swarmwire-lib`. A test checks every name below exists.

```exports
Swarmwire
Download
rootOf
formatLink
parseLink
discoveryTopic
swarmTopic
SCHEME
ContentSource
MemorySource
encodeManifest
decodeManifest
isSafePath
MANIFEST_TYPE
Destination
verifyGroup
groupCount
groupRange
groupLength
DEFAULT_GROUP_LOG
```

**Stable** (changes bump the version and are in the changelog): `Swarmwire`
(`serve`, `serveCollection`, `download`, `downloadCollection`, `readList`, `downloadFile`,
`unserve`, `destroy`, `peerCount`, `counts`; events `peer-connected`, `peer-disconnected`),
`Download` (awaitable; events `progress`, `rejected`, `timeout`, `stalled`), `rootOf`,
`formatLink`, `parseLink`, `SCHEME`.

**Exported for tests and advanced use, may change in any 0.x**: everything else.

## 6. Wire format

Described in `docs/format.md`. Changes only deliberately; unknown messages are ignored so old
peers survive new ones.
