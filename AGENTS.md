# swarmwire Agent Guidelines

Read this first. It covers the layering rule, the invariants, and how to test.

## What this repo is

A library that turns a 32-byte content address into bytes on disk, over Hyperswarm. Nothing
else. See [README.md](README.md) for scope and [docs/format.md](docs/format.md) for the parts
that must not change casually.

## The boundary rule (NON-NEGOTIABLE)

**swarmwire never imports SwarmFS, hypergraph, hypercore, corestore, autobase or hyperdb.**

If a feature needs a filename, a directory, a user, a permission or a mutable reference, it
belongs in SwarmFS, one layer up. The test is simple: swarmwire takes a root and returns bytes.
Anything that cannot be expressed that way is out of scope.

Allowed dependencies: `hyperswarm`, `protomux`, `compact-encoding`, `b4a`, `blake3-bao`,
`hypercore-crypto` (for keypairs only — it does not pull in hypercore itself).
Dev-only: `hyperdht`, to build a loopback swarm against a private DHT in `examples/send-get.js`
and the network tests (`hyperswarm` hides the options that needs).

What applications built on swarmwire can rely on, supply and must not expect lives in
[docs/contract.md](docs/contract.md). Adding an export or a hook means updating it in the same
commit; `test/unit/contract.test.js` fails if it drifts.

## Runtime targets: Node **and** Bare

Mobile apps are the reason, and both runtimes run the same tests:

```bash
npm test              # Node
npm run test:bare     # Bare, same suite
npm run test:all      # both, including the real-swarm tests
```

Rules:

- **No `Buffer`.** Use `b4a` for every byte operation.
- **No globals that Bare does not have.** `process` is the one that bites: import it
  (`import process from 'process'`), never assume it. `setImmediate`, `queueMicrotask` and
  `Buffer` do exist on Bare; `process` does not.
- **No `node:` builtins imported directly.** Import the bare specifier (`fs`, `events`,
  `path`) and let the `imports` map in `package.json` send Bare to `bare-fs`, `bare-events`,
  `bare-path`. Adding a builtin means adding a mapping and a `bare-*` dependency.
- **Nothing that imports `module`.** This is how a dependency usually breaks Bare:
  `blake3-bao`'s ESM entry points are wrappers that call `createRequire` from Node's `module`,
  which Bare has no equivalent for. The CommonJS files underneath load identically on both,
  so `lib/blake3.cjs` reaches them and `lib/blake3.js` re-exports; everything else imports
  from there. Check a new dependency for this before adding it.
- **In the CLI, print with `console.log`, not `process.stdout.write`.** On Bare the latter
  never reaches a piped stdout, so a CLI written that way works in a terminal and is silent
  to anything that spawns it. The CLI tests spawn `process.execPath`, so they catch it.
- **No native modules of our own.** Native addons the Holepunch stack already ships
  (sodium-native, udx-native) are fine: the real-swarm tests pass under Bare, addons included.

## Invariants

1. **The address is the plain BLAKE3 hash of the content.** Not a custom tree, not a hash of
   metadata. `b3sum <file>` must equal the root swarmwire computes.
2. **Nothing is written to the destination before it is verified** against the root. Not
   optimistically, not "we'll check at the end".
3. **Shared content is read in place.** swarmwire never copies a file into a store to serve it.
4. **Size and filename from peers or links are hints.** Never trusted, never used as a path
   without sanitising.
5. **Unknown wire messages are ignored, not errors.** Old peers must survive new message types.
6. **A workspace costs one announce, not one per file.** Per-content topics are for links;
   groups of peers meet on a swarm topic and ask each other for roots over the connection.

Changing an invariant means changing this list in the same commit, with the reason.

## Testing

`brittle`, like hypergraph.

```bash
npm test              # unit tests: format, addressing, scheduling logic
npm run test:swarm    # multi-peer tests over the in-memory transport
```

**Layout:**

- `test/unit/` — pure logic, no I/O, no network. Fast, run constantly.
- `test/fs/` — real files in a scratch directory: hashing in place, verified writes, resume.
- `test/swarm/` — many peers in one process over the in-memory transport in
  `test/helpers/network.js`, with deterministic ordering and fault injection. This is where
  resilience claims get proved.

  Peers join topics and meet whoever shares one, exactly like Hyperswarm, but **nothing is
  delivered until `await net.settle()`** — so a test decides when each frame lands. Faults
  available: `net.step()` delivers one batch at a time, for acting mid-transfer;
  `link.setLatency()`, `link.setDropRate()` (seeded, reproducible),
  `link.partition()`, `peer.corruptOutgoing()` (a liar, or `null` to swallow), and
  `peer.destroy()` (a peer that loses power). `net.pump()` lets writes reach the queue without
  delivering them, for assertions on `net.inflight`.
- `test/net/` — real Hyperswarm against a private local DHT (`@hyperswarm/testnet`), including
  the CLI driven as two processes. Slow and environment-dependent; never the place to test
  logic. Run with `npm run test:net`; `npm test` leaves it out, `npm run test:all` includes it.

  Two things that cost an afternoon, if a testnet peer cannot be found: testnet nodes are
  **firewalled by default**, so create them with `testnet.createNode({ ephemeral: false,
  firewalled: false })`, and a node talking to a loopback bootstrap must also **bind to
  127.0.0.1**, or it announces an address its peers cannot reach. Also wait for
  `discovery.flushed()` on the announcing side before the other side looks up.

**Rules:**

- Transfer and verification logic is written test-first. A bug in this layer corrupts files.
- Every resilience claim ("survives a seeder leaving", "bans lying peers") needs a `test/swarm/`
  test that actually does the bad thing.
- No `setTimeout`-based waiting in tests. The in-memory transport is deterministic; use it.

## Benchmarks

`npm run bench` measures what the scheduler controls, on the deterministic harness: requests
per group, wasted requests, proof overhead. Those numbers are reproducible, so a change that
makes them worse shows up immediately. `npm run bench:net` measures wall-clock throughput over
a real swarm on loopback. `npm run bench:sim` runs the swarm model in `bench/sim/` (a thousand
downloaders take minutes per run): it is how selection strategies were compared, and the way to
re-check one; see `docs/scaling.md`.

The harness models latency *and* bandwidth, which is what makes request pipelining
measurable: a link carries a frame while it transmits it, so a shallow window leaves the wire
idle during the round trip. `windowSweep` in `bench/swarm.js` is where the request window was
settled; change that code and run it rather than reasoning about a number.

Its one blind spot: the harness's logical time and the injected clock are separate, so
anything that estimates bandwidth or round-trip time from timestamps cannot be validated
there yet.

**Tests that act in the middle of a transfer need a shallow window** (`new Swarmwire({ swarm,
window: 2 })`), or the default window of 32 swallows a small file in one step and there is no
middle to act in.

## Conventions

- ESM, Node >= 20, no build step, no TypeScript (JSDoc types where they help).
- Small files with one job. If a file passes ~300 lines, it is probably two things.
- No dependency gets added without a line in this file saying why.

## Current state

Pre-alpha. See [docs/roadmap.md](docs/roadmap.md) for what is built and what is next.

`lib/swarmwire.js` is past its size guideline: new behaviour goes in its own file and the node
only calls it. Peer counts and the watch set live in `lib/holdings.js`, the folder list reader in
`lib/listing.js`.

The command-line tool lives in its own repository, [`swarmwire-cli`](https://github.com/tibocub/swarmwire-cli); this repository is the library and has no `bin`.
