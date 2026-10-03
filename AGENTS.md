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

## Runtime targets: Node **and** Bare

Mobile apps are the reason. Everything here must run on Bare as well as Node:

- **No `Buffer`.** Use `b4a` for every byte operation.
- **No `node:` builtins imported directly.** Filesystem access goes behind a small adapter so
  Bare can supply `bare-fs`; same for anything else platform-shaped.
- **No native modules, no WASM-only paths.** `blake3-bao`'s ESM builds are pure JavaScript and
  use no `Buffer` — that was checked, and it is why they were chosen over a Rust binding.
- Do not add a dependency without checking it the same way.

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
- `test/swarm/` — many peers in one process over the in-memory transport in
  `test/helpers/network.js`, with deterministic ordering and fault injection. This is where
  resilience claims get proved.

  Peers join topics and meet whoever shares one, exactly like Hyperswarm, but **nothing is
  delivered until `await net.settle()`** — so a test decides when each frame lands. Faults
  available: `link.setLatency()`, `link.setDropRate()` (seeded, reproducible),
  `link.partition()`, `peer.corruptOutgoing()` (a liar, or `null` to swallow), and
  `peer.destroy()` (a peer that loses power). `net.pump()` lets writes reach the queue without
  delivering them, for assertions on `net.inflight`.
- `test/net/` — a small number of real-Hyperswarm smoke tests. Slow and flaky by nature; never
  the place to test logic.

**Rules:**

- Transfer and verification logic is written test-first. A bug in this layer corrupts files.
- Every resilience claim ("survives a seeder leaving", "bans lying peers") needs a `test/swarm/`
  test that actually does the bad thing.
- No `setTimeout`-based waiting in tests. The in-memory transport is deterministic; use it.

## Conventions

- ESM, Node >= 20, no build step, no TypeScript (JSDoc types where they help).
- Small files with one job. If a file passes ~300 lines, it is probably two things.
- No dependency gets added without a line in this file saying why.

## Current state

Pre-alpha, M0. See [docs/roadmap.md](docs/roadmap.md) for what is built and what is next.
