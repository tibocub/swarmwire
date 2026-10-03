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

## Invariants

1. **The address is the plain BLAKE3 hash of the content.** Not a custom tree, not a hash of
   metadata. `b3sum <file>` must equal the root swarmwire computes.
2. **Nothing is written to the destination before it is verified** against the root. Not
   optimistically, not "we'll check at the end".
3. **Shared content is read in place.** swarmwire never copies a file into a store to serve it.
4. **Size and filename from peers or links are hints.** Never trusted, never used as a path
   without sanitising.
5. **Unknown wire messages are ignored, not errors.** Old peers must survive new message types.

Changing an invariant means changing this list in the same commit, with the reason.

## Testing

`brittle`, like hypergraph.

```bash
npm test              # unit tests: format, addressing, scheduling logic
npm run test:swarm    # multi-peer tests over the in-memory transport
```

**Layout:**

- `test/unit/` — pure logic, no I/O, no network. Fast, run constantly.
- `test/swarm/` — many peers in one process over an in-memory transport, with deterministic
  ordering and fault injection (slow peer, lying peer, peer that vanishes). This is where
  resilience claims get proved.
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
