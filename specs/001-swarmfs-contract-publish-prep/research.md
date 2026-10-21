# Research: SwarmFS Contract and Publish Prep

Facts below were checked against the repository on 2026-10-21 unless marked otherwise.

## 1. Package name

- **Decision**: `swarmwire-lib` for the library, `swarmwire-cli` for the tool (chosen by the user).
- **Rationale**: `swarmwire` on npm belongs to an unrelated AI-agent project (v1.0.1 to 1.0.3,
  March 2026). `swarmwire-lib` and `swarmwire-cli` returned 404 on the registry.
- **Alternatives**: a scoped name (rejected by the user), disputing the name (unlikely to succeed).
- **Caveat**: availability was checked today; claim `swarmwire-cli` with a placeholder publish soon
  so it is not taken before the CLI repo ships.

## 2. What is published

- **Finding**: with no `files` field and no `.npmignore`, `npm pack --dry-run` lists **81 files**
  (152 kB), including `test/`, `bench/` and `.github/`.
- **Decision**: a `files` whitelist: `index.js`, `lib/`, `docs/format.md`, `docs/contract.md`.
  npm always adds `package.json`, `README.md` and `LICENSE`.
- **Rationale**: a whitelist cannot leak a new dev folder by accident; a blacklist can.
- **Check**: `scripts/check-pack.js` runs `npm pack --dry-run --json` and fails on any path outside
  the whitelist or a missing `LICENSE`. Run in CI.

## 3. The `bin` entry

- **Finding**: `package.json` declares `bin: swarmwire -> bin/swarmwire.js`. Publishing it would
  make `npm i -g swarmwire-lib` install a command named `swarmwire`, which is the confusion the
  repo split is meant to remove.
- **Decision** (confirmed by the user: the CLI is moving to its own repository): drop `bin` from `package.json`; `bin/swarmwire.js` stays in the repo until
  the CLI is extracted (a later feature) and is run as `node bin/swarmwire.js`.
- **To verify in tasks**: `test/net/cli.test.js` spawns the script by path, not through `bin`.

## 4. Version

- **Decision**: `0.1.0`, normal `latest` tag. The current `0.0.0` is a placeholder.
- **Rationale**: pre-1.0 semver already tells consumers minor releases may break. A separate
  `next` tag would hide the library from `npm i` for no benefit while SwarmFS and the CLI are the
  only consumers.

## 5. Contract format and how it stays true

- **Decision**: one markdown document, `docs/contract.md`, with a table giving every capability a
  status of *exists* or *planned (feature NNN)*. The list of exports sits in one fenced block; a
  unit test reads that block and checks each name is exported by `index.js`.
- **Rationale**: SC-002 forbids claims the code does not back. A test is cheaper than review
  discipline and runs on Bare too.
- **Alternatives**: TypeScript declaration file (rejected: no build step, no TypeScript, per
  Conventions); generated docs from JSDoc (rejected: the contract is about promises, not
  signatures).
- **Not decided here**: the exact shape of the four planned APIs. The contract states their
  semantics (see `contracts/contract-draft.md`); feature 002 designs the signatures against it.

## 6. Part of a folder: where does it belong? (FR-003a)

- **Finding**: `downloadCollection` fetches the manifest through the private `_fetchManifest`,
  then downloads every listed file one after another. A file inside a folder is already an
  ordinary download (`download({root, size, secret, name}, path, {announce:false})`), so nothing
  stops an application downloading a subset if it can get the list. Today it cannot without
  calling a private method.
- **Recommendation**: expose the file-list read as a public method (feature 002); leave choosing,
  and any interface for choosing, to SwarmFS; do not add a filter option to `downloadCollection`.
- **Rationale**: a filter in swarmwire would carry selection policy (globs? indices? sizes?) that
  SwarmFS needs to own anyway, and would still need the list for the UI. The list is the
  primitive; policy sits above it. Constitution Principle II.
- **Counter-argument**: a CLI wants "get these files from this folder" too. It can build that on
  the same primitive in the CLI repo.
- **Side note**: files in a folder download sequentially today. That is a scheduling concern for
  the simulation work, not this feature.
- **Status**: decided by the user on 2026-10-21: follow the recommendation.

## 7. Example and its test

- **Decision**: `examples/send-get.js`, run as two processes (`send` and `get` modes) using
  Hyperswarm directly, quoted in the README. `test/net/example.test.js` runs it against the private
  testnet exactly as `cli.test.js` runs the CLI, and compares bytes.
- **Rationale**: the example is the "how do I use the library" answer once the CLI leaves; running
  it in the suite means it cannot rot (FR-013).
- **To verify in tasks**: how `cli.test.js` points the process at the private DHT (flag or
  environment) and reuse the same mechanism.

## 8. Release procedure (FR-015)

- **Decision**: `docs/releasing.md` covering: checks (`npm run test:all`, `npm run check:pack`),
  choosing the version (0.x: minor for any export change), `npm publish` from the maintainer's
  machine with 2FA for the first release, a tag on the commit, and what to do after a mistake.
- **Mistakes**: `npm unpublish` works only within 72 hours and only when nothing depends on the
  version; otherwise `npm deprecate` the bad version and publish a fixed patch.
- **Later**: CI publish with provenance once the process is stable. Not part of this feature.

## 9. Documentation fixes found on the way

- `README.md` links SwarmFS as `../SwarmFS`; the live repository is `swarmfs` (lowercase) on this
  machine, and the link is only useful if the repo is public. Replace with plain text until a URL
  exists.
- `README.md` says "A library (with a thin CLI)". Reword to say the CLI is moving to
  `swarmwire-cli` (FR-014), linking once that repository exists.
- `AGENTS.md` and `CLAUDE.md` say main branch is `main`; the checkout is on `master`. Not fixed
  here; flagged to the user.
