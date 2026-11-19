# swarmwire

**Content-addressed file transfer over Hyperswarm.**

Give someone a link, they get the bytes — from you, or from anyone else who already has them.
Files are served in place, from wherever they already live on disk. Nothing is copied into a
store, a core or a cache first. Runs on Node and on Bare.

- **Content-addressed.** A file's address is its BLAKE3 hash, the value `b3sum` prints. You
  ask for content, not for a peer, so any peer holding it can answer.
- **Verified in transit.** Every 16 KiB group is checked against the root with
  [bao](https://github.com/oconnor663/bao) proofs before it touches the destination. A lying
  peer is caught on its first bad group.
- **Served in place.** No import step and no second copy. Each group is checked again before
  it is sent, so a file changed on disk is never served as the old one.
- **Swarm-shaped.** Many peers per transfer, partial seeders included, rarest group first, over
  Hyperswarm's DHT and holepunching instead of trackers.

> **Pre-alpha.** Files and folders transfer end to end over a real swarm, with resume.
> Behaviour with very many peers is modelled, not yet measured. See [docs/roadmap.md](docs/roadmap.md).

## Where it sits

```
  SwarmFS        names, directories, multi-writer, permissions
     │           (hypergraph holds the references)
     ▼
  swarmwire      roots → bytes: discovery, verified transfer, in-place serving
     │
     ▼
  Hyperswarm     DHT discovery, holepunching, encrypted streams
```

swarmwire never imports SwarmFS, hypergraph or hypercore. Anything that needs a name, a
directory or a user belongs one layer up. It is not a filesystem, not a hypercore, not
BitTorrent-compatible, and not a live-stream transport: addresses name fixed content.

## How a transfer works

```
 downloader                              peer with the content
     │── join topic derived from root ──────────│
     │── want root ────────────────────────────▶│
     │◀─ have (size, which groups it holds) ────│
     │── request group i  (a window of them) ──▶│
     │◀─ data (group i + proof) ────────────────│
     │   verify against root, then write        │
     │   now serve group i to others too        │
```

The downloader asks every connected peer, keeps an adaptive window of requests with each,
and records progress beside the file so a restart resumes. [docs/api.md](docs/api.md)
has the details.

## Example

```
npm i swarmwire-lib hyperswarm
```

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

```
$ node examples/send-get.js send ./holidays.mp4
swarmwire://10db6398a68dff502d002912f54502fdde9ab55fb30bec32861a2f004d874fc8?s=734003200&n=holidays.mp4

$ node examples/send-get.js get 'swarmwire://10db63…' ./holidays.mp4
./holidays.mp4
```

This is [`examples/send-get.js`](examples/send-get.js) without its `--bootstrap` option (a
private DHT, for the tests). It is an ES module: your project needs `"type": "module"` or a
`.mjs` file.

More in [docs/api.md](docs/api.md):

- a folder is one link: `serveCollection` / `downloadCollection`, or `readList` and
  `downloadFile` to pick files;
- serve everything a device holds without announcing it: `new Swarmwire({ swarm, resolve })`,
  where `resolve(root, peer)` returns a path or null when a peer asks;
- `hashFile(path)`, `counts(link)`, peer events, and `temporary: true` downloads.

The command-line tool is [`swarmwire-cli`](https://www.npmjs.com/package/swarmwire-cli).

## Development

```bash
npm install
npm test              # unit, filesystem and in-memory swarm tests, Node
npm run test:bare     # the same on Bare
npm run test:all      # everything, including real Hyperswarm on a private DHT
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/development.md](docs/development.md).

## Documentation

[docs/README.md](docs/README.md) lists everything. The main ones:

- [docs/api.md](docs/api.md) — how a transfer works, every option and event
- [docs/contract.md](docs/contract.md) — what applications can rely on
- [docs/format.md](docs/format.md) — addresses, links, topics, manifests
- [docs/development.md](docs/development.md) — invariants, Bare rules, tests

Family overview: [`ECOSYSTEM.md`](../hypergraph/ECOSYSTEM.md) in the hypergraph repository.

## License

MIT
