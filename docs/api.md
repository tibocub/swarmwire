# API reference

Every option and method of `swarmwire-lib`. What is guaranteed to stay is in
[contract.md](contract.md); the link and wire format is in [format.md](format.md).

## How a transfer works

```
 downloader                                   peer holding the root
     │  join(discoveryTopic(root, secret))          │  (announced the same topic)
     │ ─────────── Hyperswarm connection ─────────▶ │
     │  handshake { version, groupLog }             │
     │  want { root, size }                       ─▶│
     │ ◀─ have { size, groupLog, bitfield }         │  or `unavailable`
     │  request { root, index }  × window         ─▶│
     │ ◀─ data { index, proof, data }               │  or `reject`
     │  verify against root, then write             │
     │ ◀─ holds { index }                           │  as the peer gains groups
```

- Content is split into **groups** of 16 KiB (`groupLog` 4). Each `data` message carries one
  group and the sibling hashes that prove it belongs to the root. Nothing is written before it
  verifies; a peer that sends one bad group is never asked again.
- Groups are chosen **rarest first** among connected peers, ties broken at random, scanning
  from a random place in the file. A download does not proceed in file order.
- Each peer gets a **window** of requests in flight: it starts at 32, grows by one when an answer
  arrives while the window was full, halves on a refusal or timeout, and stays between 4 and 512.
- A request unanswered after `requestTimeout` goes back to the pool; after three such timeouts
  the peer is no longer asked until it answers again.
- A download in progress **serves what it has verified**, with the proofs it received, so peers
  fetching the same file feed each other. A finished download keeps serving from where it landed.
- Progress is appended to `<path>.swarmwire-part` as groups arrive; the same `download()` later
  resumes from it, and it is removed when the file is complete.

## `new Swarmwire(opts)`

| Option | Default | Meaning |
|---|---|---|
| `swarm` | required | A Hyperswarm, or any object with `join(topic, opts)` and a `connection` event. The application creates and destroys it. |
| `groupLog` | `4` | log2 of the 1 KiB chunks per group (4 = 16 KiB). Peers with another value are ignored. |
| `requestTimeout` | `15000` | ms before an unanswered request is given to another peer. |
| `window` | `32` | Requests in flight per peer to start with. Tests that act mid-transfer use `2`. |
| `timers` | system clock | `{ setTimer(ms, fn) → cancel }`. Tests inject a manual clock. |
| `resolve` | `null` | `(rootHex, peer) → path \| null`, may be async. Serves on demand: called when a peer wants a root nothing is serving. See [contract.md §3.6](contract.md#36-serving-on-demand). |
| `allowed` | `null` | `(rootHex, peer) → boolean`, may be async. Asked before a download in progress is served to a peer; a throw is a refusal. Without it, any peer may fetch from it. |
| `maxOpen` | `64` | Files opened through `resolve` kept open at once (least recently used closed first). Each also closes after 5 s without a read. |
| `temporary` | `false` | Download to `<path>.part` and rename into place once verified. |

`peer` is `{ id, publicKey }`: `id` is the remote public key in hex, `publicKey` the key the
swarm gave (or null). It is the same object for the whole connection, and a yes from
`resolve` or `allowed` lasts as long as that connection.

## Methods

| Method | Returns | Notes |
|---|---|---|
| `serve(path, { secret, name })` | `{ root, size, link }` | Hashes the file in place and announces it. Public unless `secret` (64 hex) is given. `path` may be `fd:N`. |
| `serveCollection(dir, { secret, name, files })` | `{ root, size, files, link }` | Serves every file under `dir` plus an in-memory manifest; one announce. `files: [{ path, from }]` replaces the directory walk. Symbolic links are skipped. |
| `download(link, outPath, { announce, destination, temporary })` | `Download` | Starts at once. `announce: false` joins no topic (used for files of a folder). `destination` is an async factory replacing the file at `outPath`. The same root twice returns the same `Download`. |
| `downloadCollection(link, dir, { onfile, onprogress })` | `{ files, bytes }` | List first, then each file in order. |
| `readList(link)` | thenable `{ files, size }` | A folder's list, without fetching files or announcing. `stop()` gives up (resolves `undefined`). |
| `downloadFile(link, file, outPath)` | `Download` | One entry of `readList`, through the folder's peers. |
| `unserve(root)` | `Promise` | Stops serving and leaves the topic. |
| `counts(link)` | `{ peers, seeders, leechers }` | Direct connections only. |
| `peerCount` | number | Peers that completed the handshake. |
| `destroy()` | `Promise` | Stops downloads (resume state kept), unserves, closes files. Leaves the swarm alone. |

Events: `peer-connected`, `peer-disconnected`, each `{ id }`.

## `Download`

Thenable: resolves when complete or stopped, rejects if the destination cannot be written.

| Member | Meaning |
|---|---|
| `ready()` | Resolves once the destination is open and `total` is known. |
| `stop()` | Stops; verified groups and the resume record stay on disk. |
| `have`, `total`, `complete` | Groups held, groups in all, whether done. |
| `received`, `rejected`, `timedOut`, `rejectedByPeers` | Counters for this session. |
| `inflight`, `peersUsed` | Requests outstanding; the set of peer ids that delivered a group. |

| Event | Payload | When |
|---|---|---|
| `progress` | `{ have, total, from }` | A group was verified and written; `from: null` on completion. |
| `rejected` | `{ index, from }` | A group failed verification. |
| `timeout` | `{ index, from, strikes }` | A request went unanswered. |
| `stalled` | `{ have, total }` | No connected peer can supply what is missing. A download never fails for lack of peers. |

## Helpers

| Export | Meaning |
|---|---|
| `rootOf(bytes)` | BLAKE3 root of a `Uint8Array`, hex. |
| `hashFile(path)` | Root of a file, read a group at a time. |
| `formatLink({ root, size, name, secret, type })` / `parseLink(link)` | Links, see [format.md §3](format.md#3-links). |
| `discoveryTopic(root, secret)`, `swarmTopic(swarmKey)` | 32-byte Hyperswarm topics. |
| `encodeManifest(files)`, `decodeManifest(bytes)`, `isSafePath(path)`, `MANIFEST_TYPE` | Folder manifests. |
| `ContentSource`, `MemorySource`, `Destination`, `verifyGroup`, `groupCount`, `groupRange`, `groupLength`, `DEFAULT_GROUP_LOG`, `SCHEME` | Lower-level pieces, exported for tests and advanced use; may change in any 0.x. |
