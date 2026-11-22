# CLAUDE.md

swarmwire moves bytes by content address over Hyperswarm. It sits under SwarmFS
(`../SwarmFS`) and must never
import SwarmFS, hypergraph or hypercore. Do not copy SwarmFS's merkle tree: it duplicates the
last node of odd levels, so `[a,b,c]` and `[a,b,c,c]` share a root. Branch per feature off `main`.

## Tests

```bash
npm test              # unit, fs, swarm on Node
npm run test:bare     # same suite on Bare
npm run test:all      # plus real-swarm tests on both
```

No lockfile is committed.

## Types

`npm run typecheck` (tsc strict, `jsconfig.json`) must pass with no error; a test enforces it.
JSDoc `@typedef` for every object shape; `any`, casts and `@ts-expect-error` only with a one-line
reason. Untyped packages get hand-written types in `types/`.

## Comments

Keep a comment only when it explains why something is done in a way the code can't show:
a subtle bug avoided, a security choice, a platform quirk. No restating code, no spec
numbers, dates or names. Public exports get complete JSDoc.

## Docs

Everything is in [`docs/`](docs/README.md): invariants and test workflow in
`docs/development.md`, the stable contract in `docs/contract.md` (its export list is checked
by a test), every option in `docs/api.md`. Feature specs are in `specs/`. Record user-visible
changes in `CHANGELOG.md`.
