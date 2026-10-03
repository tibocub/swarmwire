# swarmwire

**Content-addressed file transfer over Hyperswarm.**

> Transfers directly from one's filesystem to another, no need to duplicate the data in a hyperblob

Give someone a link, they get the bytes — from you, or from anyone else who already has them.
Files are served in place, from wherever they already live on disk. Nothing is copied into a
store, a core, or a cache first.

```
$ swarmwire send ./holidays.mp4
swarmwire://10db6398a68dff502d002912f54502fdde9ab55fb30bec32861a2f004d874fc8?s=734003200&n=holidays.mp4&k=…
serving ./holidays.mp4 (700.0 MiB)
keep this running; ctrl-c to stop

$ swarmwire get 'swarmwire://10db63…74fc8?s=734003200&n=holidays.mp4&k=…'
fetching 10db6398a68dff50... into holidays.mp4
44800/44800 groups (100%)
```

> Status: **pre-alpha.** Transfers work end to end, over a real swarm, with resume and
> verification. Multi-peer scheduling is still naive and there are no request timeouts yet —
> see [docs/roadmap.md](docs/roadmap.md) for what M2 adds.

## What it is

A library (with a thin CLI) that moves bytes between peers:

- **Content-addressed.** A file's address is its BLAKE3 hash — the same value `b3sum` prints.
  You ask for content, never for a peer, so any peer holding it can answer.
- **Verified in transit.** Every received range is checked against the root hash before it
  touches the destination file, using [bao](https://github.com/oconnor663/bao) verified
  streaming. A lying peer is caught on its first bad range, not at the end of the download.
- **Served in place.** A shared file is read from its existing path. There is no import step,
  no second copy, no storage layer that owns your data.
- **Swarm-shaped.** Many peers per transfer, partial seeders included, like BitTorrent —
  but with Hyperswarm's DHT and holepunching instead of trackers.

## What it is not

- **Not a filesystem.** Names, directories, mutation, sharing and permissions live one layer
  up, in [SwarmFS](../SwarmFS). swarmwire only knows roots and bytes.
- **Not a hypercore.** It never writes your content into a core, a blob store or a database.
  (Hypercore/hypergraph are excellent at distributing the *references* — that is SwarmFS's job,
  not this one.)
- **Not BitTorrent-compatible.** It borrows BitTorrent's swarm algorithms, not its wire format.
- **Not a live-stream transport.** Addresses name fixed content. Open-ended streams need an
  append-only log; that is what hypercore is for.

## Layering

```
  SwarmFS            virtual filesystem: names, directories, multi-writer, permissions
     │               (hypergraph/hypercore hold the references)
     ▼
  swarmwire          roots → bytes: discovery, verified transfer, in-place serving
     │
     ▼
  Hyperswarm         DHT discovery, holepunching, encrypted streams
```

The dependency runs one way. swarmwire must never import SwarmFS, hypergraph or hypercore.
Anything that needs a name, a directory or a user belongs upstairs. See
[`ECOSYSTEM.md`](../hypergraph/ECOSYSTEM.md) for how the wider family fits together.

## Documentation

| Document                           | What's in it                                                                                  |
|------------------------------------|-----------------------------------------------------------------------------------------------|
| [docs/format.md](docs/format.md)   | Addressing, verification, links, topic derivation — the parts that must never change casually |
| [docs/roadmap.md](docs/roadmap.md) | Vision and milestones                                                                         |
| [AGENTS.md](AGENTS.md)             | How to work in this repo                                                                      |

## License

MIT
