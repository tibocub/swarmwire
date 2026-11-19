# Contributing

1. `npm install`, then `npm test`. Before a pull request, `npm run test:all` (Node and Bare,
   including the real-swarm tests).
2. Read [docs/development.md](docs/development.md): the boundary rule, the invariants, and the
   Node/Bare rules. A change that breaks an invariant changes that list, with the reason.
3. Transfer and verification changes come with tests, written first. A resilience claim needs a
   `test/swarm/` test that does the bad thing.
4. A change to a hot path runs `npm run perf` before and after.
5. New or changed exports update [docs/contract.md](docs/contract.md) and
   [docs/api.md](docs/api.md); user-visible changes go in [CHANGELOG.md](CHANGELOG.md).
6. Comments explain *why*, not *what*. Public exports get JSDoc.

Code is written in [standard](https://standardjs.com) style: ESM, no semicolons, no build step.
