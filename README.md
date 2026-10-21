# swarmwire

**Content-addressed file transfer over Hyperswarm.**

> Transfers directly from one's filesystem to another, no need to duplicate the data in a hyperblob

Give someone a link, they get the bytes — from you, or from anyone else who already has them.
Files are served in place, from wherever they already live on disk. Nothing is copied into a
store, a core, or a cache first.

```
npm i swarmwire-lib
```

One side serves a file and prints a link. The other side hands the link to `download`. (This is
`examples/send-get.js`; in the repository it imports `../index.js` instead of `swarmwire-lib`. It is
an ES module, so your project needs `"type": "module"` or a `.mjs` file.)

```js
/**
 * Send a file to someone, or get one.
 *
 *   node examples/send-get.js send ./holidays.mp4
 *   node examples/send-get.js get 'swarmwire://…' ./holidays.mp4
 *
 * `--bootstrap host:port` points both sides at a private DHT; leave it out for the real one.
 */

import process from 'process'
import Hyperswarm from 'hyperswarm'
import DHT from 'hyperdht'

import { Swarmwire } from 'swarmwire-lib'

const args = process.argv.slice(2)
const flag = args.indexOf('--bootstrap')
const bootstrap = flag === -1 ? null : args.splice(flag, 2)[1]
const [mode, target, out] = args

const swarm = bootstrap ? privateSwarm(bootstrap) : new Hyperswarm()
const node = new Swarmwire({ swarm })

if (mode === 'send') {
  const { link } = await node.serve(target)
  console.log(link) // hand this to the other side; keep running while they fetch
  await new Promise((resolve) => process.once('SIGINT', resolve))
} else if (mode === 'get') {
  await node.download(target, out)
  console.log(out)
} else {
  console.log('usage: send <file> | get <link> <out>   [--bootstrap host:port]')
  process.exitCode = 1
}

await node.destroy()
await swarm.destroy()

// A loopback DHT only works if the node binds there and is not firewalled.
function privateSwarm (address) {
  const [host, port] = address.split(':')
  const dht = new DHT({ bootstrap: [{ host, port: Number(port) }], ephemeral: false, firewalled: false, host: '127.0.0.1' })
  return new Hyperswarm({ dht })
}
```

```
$ node examples/send-get.js send ./holidays.mp4
swarmwire://10db6398a68dff502d002912f54502fdde9ab55fb30bec32861a2f004d874fc8?s=734003200&n=holidays.mp4

$ node examples/send-get.js get 'swarmwire://10db63…' ./holidays.mp4
./holidays.mp4
```

A folder goes the same way, as one link: `serveCollection` and `downloadCollection`.
The command-line tool built on this library is moving to its own package, `swarmwire-cli`.

> Status: **pre-alpha.** Transfers work end to end, over a real swarm, with resume and
> verification. Multi-peer scheduling is still naive and there are no request timeouts yet —
> see [docs/roadmap.md](docs/roadmap.md) for what M2 adds.

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

| Document                           | What's in it                                                                                  |
|------------------------------------|-----------------------------------------------------------------------------------------------|
| [docs/format.md](docs/format.md)   | Addressing, verification, links, topic derivation — the parts that must never change casually |
| [docs/contract.md](docs/contract.md) | What applications can rely on, supply and must not expect                                  |
| [docs/roadmap.md](docs/roadmap.md) | Vision and milestones                                                                         |
| [AGENTS.md](AGENTS.md)             | How to work in this repo                                                                      |

## License

MIT
