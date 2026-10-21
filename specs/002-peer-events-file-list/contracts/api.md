# API draft: peer events, counts and the file list

Becomes part of `docs/contract.md` when implemented. Names here are the plan's decision; change them
only before the tasks start.

## On a `Swarmwire` node

`Swarmwire` extends `EventEmitter`.

| Member | Kind | Contract |
|---|---|---|
| `'peer-connected'` | event | `{ id }`, once per distinct peer, after its handshake. |
| `'peer-disconnected'` | event | `{ id }`, once, only for peers that had connected. |
| `peerCount` | getter | number of ready peers; never negative. |
| `counts(link)` | method | `{ peers, seeders, leechers }` for a file or folder link, from what peers have reported. Direct connections only. Zeros for unknown content. Synchronous. |
| `readList(link)` | method | `Listing` for a folder link; rejects for a non-folder link. Fetches nothing but the list, writes nothing, never announces. |
| `downloadFile(link, file, outPath)` | method | `Download` of one `ListedFile` of the folder `link`; not announced on its own. |

## Listing

| Member | Contract |
|---|---|
| awaiting it | resolves to `{ files: [{ path, root, size }], size }` |
| `stop()` | stop waiting; the awaited promise settles |

## Behaviour that existed and changes

- `downloadCollection(link, dir, opts)`: unchanged observable behaviour; internally reads the list
  through the same code as `readList` and downloads each file through `downloadFile`.
- A node that serves content now sends `want` for it to connected peers. Observable only as extra
  small messages and as correct counts.

## Wire

No change. `docs/format.md` gains no message; its handshake sentence is corrected.

## Not in this feature

Admission decisions, peer hints, the random tie-break, and any global (swarm-wide) count.
