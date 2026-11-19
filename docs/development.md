# Working on swarmwire

## The boundary

swarmwire never imports SwarmFS, hypergraph, hypercore, corestore, autobase or hyperdb. It
takes a root and returns bytes; anything that needs a filename, a directory, a user, a
permission or a mutable reference belongs in SwarmFS.

Dependencies: `hyperswarm`, `protomux`, `compact-encoding`, `b4a`, `blake3-bao`, `streamx`,
and the `bare-*` modules the `imports` map needs. Dev-only: `hyperdht`, to point a swarm at a
private DHT in `examples/send-get.js` and the network tests. A new dependency needs a reason
written here.

Adding an export or a hook means updating [contract.md](contract.md) in the same commit;
`test/unit/contract.test.js` fails if its export list drifts.

## Invariants

1. **The address is the plain BLAKE3 hash of the content.** `b3sum <file>` equals the root.
2. **Nothing is written to the destination before it is verified** against the root.
3. **Shared content is read in place.** Never copied into a store to serve it.
4. **Size and filename from peers or links are hints.** Never trusted, never used as a path
   without validation.
5. **Unknown wire messages are ignored**, so old peers survive new message types.
6. **A workspace costs one announce, not one per file.** Per-content topics are for links;
   groups of peers meet on a swarm topic and ask each other for roots over the connection.

Changing one means changing this list in the same commit, with the reason.

## Node and Bare

Mobile builds run on Bare, and the same suite runs on both.

- **No `Buffer`.** Use `b4a`.
- **Import `process`** (`import process from 'process'`); Bare has no global one.
- **No `node:` specifiers.** Import `fs`, `events`, `path`, … and let the `imports` map in
  `package.json` send Bare to `bare-fs`, `bare-events`, `bare-path`. A new builtin needs a
  mapping and a `bare-*` dependency.
- **Nothing that imports `module`.** `blake3-bao`'s ESM entry points call `createRequire`,
  which Bare lacks; `lib/blake3.cjs` reaches the CommonJS files underneath and everything else
  imports from `lib/blake3.js`. Check new dependencies for this.
- **No native modules of our own.** Those the Holepunch stack ships (sodium-native,
  udx-native) are fine.

## Tests

[brittle](https://github.com/holepunchto/brittle). Set `TMP`/`TEMP` if your system temp
drive is small: the fs and swarm tests write real files.

```bash
npm test              # unit, fs and swarm tests on Node
npm run test:net      # real Hyperswarm on a private local DHT
npm run test:bare     # the npm test suite on Bare
npm run test:all      # all of the above, plus net on Bare
npm run check:pack    # the published package holds only the library
```

- `test/unit/` — pure logic: addressing, trees, selection, manifests, the contract.
- `test/fs/` — real files in a scratch directory: hashing in place, verified writes, resume.
- `test/swarm/` — many peers in one process over the in-memory network in
  `test/helpers/network.js`. Nothing is delivered until `await net.settle()`, so a test decides
  when each frame lands. Faults: `net.step()` (one batch at a time), `link.setLatency()`,
  `link.setDropRate()` (seeded), `link.partition()`, `peer.corruptOutgoing()` (a liar, or `null`
  to swallow), `peer.destroy()`. `net.pump()` queues writes without delivering them.
- `test/net/` — real Hyperswarm against `@hyperswarm/testnet`. Slow; never the place to test
  logic.

Rules:

- Transfer and verification logic is written test-first: a bug here corrupts files.
- Every resilience claim ("survives a seeder leaving") has a `test/swarm/` test that does the
  bad thing.
- No `setTimeout` waits in tests; drive the network or the injected clock.
- Tests that act mid-transfer need a shallow window (`window: 2`), or the default of 32
  swallows a small file in one step.

Testnet pitfalls: create nodes with `testnet.createNode({ ephemeral: false, firewalled: false })`,
bind a node that talks to a loopback bootstrap to `127.0.0.1`, and wait for
`discovery.flushed()` on the announcing side before the other side looks up.

## Benchmarks and performance

- `npm run bench` — scheduler measures on the deterministic network: requests per group,
  wasted requests, proof overhead. `windowSweep` in `bench/swarm.js` is where the request window
  was chosen. The network's logical time and the injected clock are separate, so anything that
  estimates bandwidth or round-trip time from timestamps cannot be validated there.
- `npm run bench:net` — wall-clock throughput over a real swarm on loopback.
- `npm run bench:sim` — the large-swarm model in `bench/sim/`; see [scaling.md](scaling.md).
- `npm run perf` — `perf/scenarios/` (one-to-one throughput, many small files, several
  seeders, a big file's tree memory) over a real Hyperswarm on a local DHT, on Node then Bare,
  in about two minutes. It appends a line per scenario to the committed `perf/history.jsonl`.
- `npm run perf:compare` — the last run against the previous one (`-- --sha <sha>` for
  another). It flags only changes beyond run-to-run noise: roughly 25% or more (the exact rule
  is at the top of `perf/compare.mjs`).

A change to a hot path (transfers, scheduling, hashing, verification, the wire format) adds or
updates a perf scenario and runs `npm run perf` before and after. Scenarios mirror what
applications do, not benchmark-only shapes.

## Conventions

- ESM, Node 20 or later, no build step, no TypeScript (JSDoc types where they help).
- Small files with one job. `lib/swarmwire.js` is already past ~300 lines: new behaviour goes
  in its own file and the node calls it (as `holdings.js`, `listing.js`, `on-demand.js` do).
- Comments explain why, not what (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
- No lockfile is committed: a library should be tested against what its users install.
