# Releasing swarmwire-lib

Versions are `0.x` until the contract settles: a minor release (`0.1` to `0.2`) may change any
export marked *exists* in [contract.md](contract.md); a patch release (`0.1.0` to `0.1.1`) only
fixes bugs. Record every change in [CHANGELOG.md](../CHANGELOG.md).

## Before publishing

1. `npm run test:all` passes: Node and Bare, including the real-swarm tests.
2. `npm run check:pack` passes: the package holds only `index.js`, `lib/`, the format and
   contract documents, the README, the licence and `package.json`.
3. `docs/contract.md` and `CHANGELOG.md` match what is being released, and `version` in
   `package.json` is the one you mean.

## Publishing

The first releases are published by hand from the maintainer's machine, with two-factor
authentication on:

```
npm publish
git tag v0.1.0 && git push origin v0.1.0
```

Publishing from CI with provenance can replace this once the process is stable.

## If something goes wrong

- **A bad release.** `npm unpublish swarmwire-lib@x.y.z` works only within 72 hours and only
  while nothing depends on that version. Otherwise run `npm deprecate swarmwire-lib@x.y.z
  "reason, use x.y.z+1"` and publish a fixed patch. Never reuse a version number.
- **A package name is taken or revoked.** The names in use are `swarmwire-lib` and
  `swarmwire-cli` (`swarmwire` belongs to an unrelated project). If one is lost, rename the
  package in `package.json`, `README.md` and `CHANGELOG.md`, release it as the next minor
  version, and tell the projects that depend on it.
