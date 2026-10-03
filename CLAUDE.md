# CLAUDE.md

Read **[`AGENTS.md`](AGENTS.md)** first — it has the layering rule, the invariants and the
testing workflow. This file only adds context that is about the wider ecosystem rather than
this repo.

## Where this sits

swarmwire is the bulk-transfer layer under **SwarmFS** (`E:\Code\P2P\SwarmFS`). SwarmFS owns
names, directories, mutability and permissions, and uses hypergraph to distribute the
*references*; swarmwire moves the *bytes* and knows nothing about either.

Canonical map of the family: [`E:\Code\P2P\hypergraph\ECOSYSTEM.md`](../hypergraph/ECOSYSTEM.md).

⚠ `E:\Code\P2P\` also holds `SwarmFS-main\`, `SwarmFS-copy\`, `SwarmFS.old\` and `SwarmFS-0.1\`,
which are dead copies. `SwarmFS\` is the live one. Confirm the path before editing anything
outside this repo.

## Related reading in SwarmFS

swarmwire replaces SwarmFS's transfer layer rather than extending it, but the old code is worth
consulting for what was learned the hard way:

- `SwarmFS/INVARIANTS.md` — subtree-request and in-flight accounting rules
- `SwarmFS/docs/P2P Networking and File Transfer.md` — the protocol as it was
- `SwarmFS/docs/Planned/More BLAKE3.md` — the question that led to bao

Do **not** copy SwarmFS's merkle implementation. Its tree duplicates the last node of odd
levels, so `[a,b,c]` and `[a,b,c,c]` share a root. bao removes the need for it entirely.

## Branching

Main branch is `main`. Branch per feature, merge back when its tests pass.
