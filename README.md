# swarmwire

**Content-addressed file transfer over Hyperswarm.**

> Transfers directly from one's filesystem to another, no need to duplicate the data in a hyperblob

Give someone a link, they get the bytes — from you, or from anyone else who already has them.
Files are served in place, from wherever they already live on disk. Nothing is copied into a
store, a core, or a cache first.

```
npm i swarmwire-lib hyperswarm
```

One side serves a file and prints a link. The other side hands the link to `download`:

```js
import process from 'process'
import Hyperswarm from 'hyperswarm'
import { Swarmwire } from 'swarmwire-lib'

const [mode, target, out] = process.argv.slice(2)

const swarm = new Hyperswarm()
const node = new Swarmwire({ swarm })

if (mode === 'send') {
  const { link } = await node.serve(target)
  console.log(link) // hand this to the other side; keep running while they fetch
  await new Promise((resolve) => process.once('SIGINT', resolve))
} else if (mode === 'get') {
  await node.download(target, out)
  console.log(out)
}

await node.destroy()
await swarm.destroy()
```

This is `examples/send-get.js` without its `--bootstrap` option, which points both sides at a
private DHT so the test suite needs no internet. It is an ES module, so your project needs
`"type": "module"` or a `.mjs` file.

```
$ node examples/send-get.js send ./holidays.mp4
swarmwire://10db6398a68dff502d002912f54502fdde9ab55fb30bec32861a2f004d874fc8?s=734003200&n=holidays.mp4

$ node examples/send-get.js get 'swarmwire://10db63…' ./holidays.mp4
./holidays.mp4
```

A folder goes the same way, as one link: `serveCollection` and `downloadCollection`.

To host everything a device holds without announcing or opening any of it, give the node a
lookup instead of calling `serve`: `new Swarmwire({ swarm, resolve: (root) => pathOrNull })`.
Files are opened when a peer asks, and served only if they still hash to that root. If your
application already connects its peers, hand swarmwire a network whose `join` does nothing and
it announces nothing. `temporary: true` downloads to `<path>.part` and renames at the end.
See [docs/contract.md](docs/contract.md).
The command-line tool built on this library is moving to its own package,
[`swarmwire-cli`](https://github.com/tibocub/swarmwire-cli) ([npm](https://www.npmjs.com/package/swarmwire-cli)).

> Status: **pre-alpha.** Transfers work end to end, over a real swarm, with resume,
> verification, request timeouts, partial seeding, rarest-first selection and an adaptive
> request window. Behaviour with very many peers is only modelled, not measured. It is enough
> for a command-line tool, and it can serve SwarmFS on demand with no public discovery;
> admission and peer hints are still to come. [docs/roadmap.md](docs/roadmap.md) says where it stands.


## What it is

A library that moves bytes between peers:

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
  up, in SwarmFS. swarmwire only knows roots and bytes.
- **Not a hypercore.** It never writes your content into a core, a blob store or a database.
  (Hypercore/hypergraph are excellent at distributing the *references* — that is SwarmFS's job,
  not this one.)
- **Not BitTorrent-compatible.** It borrows BitTorrent's swarm algorithms, not its wire format.
- **Not a live-stream transport.** Addresses name fixed content. Open-ended streams need an
  append-only log; that is what hypercore is for.


## Runtimes

Node and Bare, with the same test suite passing on both — Bare because that is what mobile
builds run on. See [AGENTS.md](AGENTS.md) for what that costs in practice.


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

| Document                                                         | What's in it                                                                                  |
|------------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| [docs/format.md](docs/format.md)                                 | Addressing, verification, links, topic derivation — the parts that must never change casually |
| [docs/contract.md](docs/contract.md)                             | What applications can rely on, supply and must not expect                                     |
| [docs/roadmap.md](docs/roadmap.md)                               | Vision, milestones, and where things stand                                                    |
| [docs/scaling.md](docs/scaling.md)                               | Piece selection in large swarms, simulated                                                    |
| [docs/research/p2p-landscape.md](docs/research/p2p-landscape.md) | What other P2P systems do, and what is worth taking                                           |
| [AGENTS.md](AGENTS.md)                                           | How to work in this repo                                                                      |


## TODO

### More transfer strategies
i.e: hyperbeam-like super fast sequential write when only one seeder is available to optimize the one to one speed.
This is important because we currenlty only made sure to survive well in a context where 10 000 people start
downloading the same file at the same time, but the swarmwire-cli and android app are going to be used a lot for
simple one to one downloads and in such context it's currently pretty slow (~1-16 MB/s).

### Optimization
No specific idea yet but we all love when things go fast, especially gigabytes of data from one place to another.
stuff to check:
- compression
- compact-encodings
- bigger chunks
- chunk scheduling

### Rethink if swarmwire should be SwarmFS's transport layer
Maybe swarmwire should focus on being the backbone of swarmwire-cli, the android app and maybe even a Desktop app
and simply allow super easy file/data transport with links and QR codes. The current implementation isn't suited
for SwarmFS after a second reflection since seeding a file means writing to a record in the DHT and that need to
be actualized regularly. Keeping one record per file to allow the data to be content-addressed and reachable for
anyone asking for its hash sounds unrealistic and unpractical at large scale.

The one chance there is I can think of right now to still make use of swarmwire in SwarmFS would be to use and
IPFS-like content-addressed DHT resolving only as a bonus mechanism that would only help with availability of
popular files, but since SwarmFS should be the decentralized database that allow people to create shared spaces
and use it to store basically "who shares what" in the form of a tree-shaped filesystem, we could make a system
in the SwarmFS client where instead of constantly seeding everything they have locally, each peer can automatically
seed a file with swarmwire if another peer from the same space is requesting this file. This means instead of keeping
the data hosted permanently and reachable by its hash (like it is when seeded with swarmwire), the list of "who shares
what" would be kept in the hypergraph of the space and the client would make requests to a user from a known space if
he have the hash we're looking for. When receiving the request, the peer would start seeding the file with swarmwire,
which would make it possible for other people that are not part of this space to still find this seeder even without
being part of the space. If see an interresting file in the file-tree of a space but we can't find any connected peer
that have it in our joined spaces, it would then be possible to try to look directly on the DHT for the hash. Also since
a DHT lookup is much cheaper (~3 to 5 times less) than an announce, it could be worth trying look for online peers for
every file and see if it keeps the pace with a lot of file.

### More transfer possibilities
Maybe keeping it very simple and do one thing could be its strengh but maybe it could become


## License

MIT
