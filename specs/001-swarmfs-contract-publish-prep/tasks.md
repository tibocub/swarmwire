# Tasks: SwarmFS Contract and Publish Prep

**Input**: Design documents in `specs/001-swarmfs-contract-publish-prep/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/contract-draft.md, quickstart.md

**Tests**: Included. Constitution Principle IV requires test-first for new logic; the new logic here is the contract-export check, the pack check and the example.

**Format**: `- [ ] T### [P?] [US#?] Description with file path`. `[P]` means a different file with no dependency on an unfinished task.

Decisions already made (do not reopen): package is `swarmwire-lib` 0.1.0; `bin` is dropped from `package.json`; part-of-a-folder is a planned public file-list reader in feature 002, not a filter on `downloadCollection`.

## Phase 1: Setup

- [X] T001 Rename the local branch `master` to `main` (`git branch -m master main`; the user prefers `main` and `AGENTS.md` and `CLAUDE.md` already say it; do not push or touch the remote), then create branch `001-swarmfs-contract-publish-prep` from it.

*No foundational phase: the three stories touch separate files and can be done in any order, but the order below is recommended.*

## Phase 2: User Story 1 - The contract (Priority: P1) MVP

**Goal**: One document tells an application author everything it may rely on, and a test keeps it true.

**Independent test**: `npm run test:unit` passes on Node and Bare with `docs/contract.md` in place, and fails if the document lists an export that does not exist.

- [X] T002 [US1] Write `test/unit/contract.test.js` first, in the style of the other unit tests. It reads `docs/contract.md` (via `fs` through the `imports` map, so it runs on Bare), takes the lines inside the fenced block tagged `exports`, and asserts each is a defined export of `../../index.js`. It also asserts that every path named in the contract's Proof column exists on disk, and that every row with status `planned` names a feature in its "Delivered by" column. Run it: it must fail because `docs/contract.md` does not exist yet.
- [X] T003 [US1] Create `docs/contract.md` from `specs/001-swarmfs-contract-publish-prep/contracts/contract-draft.md`, unchanged in content. Run T002's test: it must now pass or show which Proof paths are wrong.
- [X] T004 [US1] Check the contract's "Peer identity" row against the code. `peerId` in `lib/swarmwire.js` derives the id from `info.publicKey`. Peer identity matters for admission, not for integrity (content is verified against the root regardless). Keep this light: confirm a swarmwire-level test asserts that a peer's id in `node.peers` equals the remote public key; `test/swarm/network.test.js` only asserts it on the raw stream. If there is none, add one in `test/swarm/network.test.js`; then set the row's Proof column to the test that really proves it.
- [X] T005 [P] [US1] Add a line to `AGENTS.md` (near the boundary rule) saying the application-facing promises live in `docs/contract.md` and that adding an export or a hook means updating it in the same commit.
- [X] T006 [P] [US1] Add `docs/contract.md` to the Documentation table in `README.md`.

**Checkpoint**: contract exists, is tested, and no claim is unbacked (SC-002).

## Phase 3: User Story 2 - Installing from the registry (Priority: P2)

**Goal**: `npm i swarmwire-lib` gives a working library with nothing extra in it.

**Independent test**: `npm run check:pack` passes; installing the packed tarball into an empty directory lets `import { Swarmwire } from 'swarmwire-lib'` succeed on Node.

- [X] T007 [P] [US2] Write `scripts/check-pack.js` first (Node only, dev tooling, not under `lib/`): run `npm pack --dry-run --json`, fail if any listed path is outside `index.js`, `lib/`, `docs/format.md`, `docs/contract.md`, `package.json`, `README.md`, `LICENSE`, or if `LICENSE` is missing. Run it against the current `package.json`: it must fail (81 files today). `CHANGELOG.md` (T012) is deliberately outside the whitelist; if `npm pack --dry-run` shows npm includes it anyway, add `CHANGELOG.md` to the allowed list rather than fighting npm.
- [X] T008 [US2] Edit `package.json`: `name` to `swarmwire-lib`; `version` to `0.1.0`; remove `"private": true`; remove the `bin` field; add `files` as `["index.js", "lib/", "docs/format.md", "docs/contract.md"]`; add `repository` (`git+https://github.com/tibocub/swarmwire.git`, from `git remote get-url origin`), `bugs`, `homepage`, and a few `keywords` (hyperswarm, p2p, file-transfer, content-addressed, bare); add the script `"check:pack": "node scripts/check-pack.js"`. Keep `engines`, `imports` and all dependencies exactly as they are. Run T007: it must now pass.
- [X] T009 [US2] Run `npm run test:net`. `test/net/cli.test.js` spawns `bin/swarmwire.js` by path (checked), so dropping `bin` must not break it. Fix anything that does.
- [X] T010 [P] [US2] Add a `check:pack` step to the `unit` job in `.github/workflows/test.yml` (one OS is enough).
- [X] T011 [P] [US2] Write `docs/releasing.md` per research.md item 8: checks (`npm run test:all`, `npm run check:pack`), choosing the version under 0.x (minor for any export change), publishing from the maintainer's machine with 2FA for the first release, tagging the commit, a short note on what to do if a package name is taken or revoked after release, and the mistake procedure (`npm unpublish` only within 72 hours with no dependents, otherwise `npm deprecate` plus a fixed patch).
- [X] T012 [P] [US2] Create `CHANGELOG.md` with an entry for 0.1.0 (first publication; contract added; `bin` removed because the CLI moves to `swarmwire-cli`). Not in `files`.

**Checkpoint**: package is clean and publishable (SC-005). Publishing itself is a manual step for the maintainer, see T019.

## Phase 4: User Story 3 - A minimal example that doubles as a check (Priority: P3)

**Goal**: a newcomer runs a short example and sees a file move; the suite runs the same example.

**Independent test**: `npm run test:net` and `npm run test:bare:net` pass with the new example test, and the received file is byte-identical.

- [X] T013 [US3] Write `test/net/example.test.js` first, modelled on `test/net/cli.test.js` (private DHT via `@hyperswarm/testnet`, firewalled false, bound to 127.0.0.1, spawn `process.execPath` with the script path, pass `--bootstrap host:port`). It starts the sender, reads the link from its output, starts the receiver, and asserts the received bytes equal the original. Run it: it must fail because the example does not exist.
- [X] T014 [US3] Write `examples/send-get.js` (about 30 lines): modes `send <file>` and `get <link> <out>`, optional `--bootstrap host:port`, using `Hyperswarm` and the public API only (`Swarmwire`, `serve`, `download`, `destroy`). Print with `console.log`, import `process` from `'process'`, no `Buffer`, no `node:` imports, so it runs on Bare. Run T013 on Node and Bare.
- [X] T015 [US3] Update `README.md`: an install line (`npm i swarmwire-lib`); the example from `examples/send-get.js` quoted verbatim; replace "A library (with a thin CLI)" with a statement that swarmwire is a library and the command-line tool is moving to `swarmwire-cli` (no link until that repository exists); replace the dead `../SwarmFS` link with plain text. Remove the `$ swarmwire send` and `$ swarmwire get` terminal blocks (the package no longer exposes that command) so the README documents no command that does not ship with the package.

**Checkpoint**: README example runs and is covered by the suite (SC-003, SC-004).

## Phase 5: Polish & Cross-Cutting

- [X] T016 Write the ten reading-test questions into `specs/001-swarmfs-contract-publish-prep/quickstart.md` (step 5), covering hints, admission, refusals, peer counts, folders, the shared connection and what swarmwire will not do. Write them from the spec, not by reading `lib/`. Each question needs a one-line expected answer from the spec.
- [X] T017 Run the whole of `specs/001-swarmfs-contract-publish-prep/quickstart.md`, including `npm run test:all`, the tarball install into a scratch directory outside the repo, and the ten-question reading test from T016, answered by someone (or a fresh session) that has not read `lib/`. Also review every `exists` row of the contract by hand and confirm its Proof file really tests that claim (T002 only checks the file exists). Delete the scratch directory afterwards.
- [X] T018 Update `docs/roadmap.md`: record that the contract exists, that the package is published as `swarmwire-lib`, and add the planned feature 002 (peer hints, admission decisions, peer events and counts, public folder file-list reader, random tie-break) so the milestone view matches the specs.
- [X] T019 Hand-off, not code: tell the user the exact commands to publish (`npm publish`, with their 2FA) and to claim `swarmwire-cli` with a placeholder. Do not run either. After the user has published, install `swarmwire-lib` from the registry into a scratch directory outside the repo and run the example against the private DHT or the public one, to prove FR-009 and SC-003.

## Dependencies and order

- T001 first. Within US1: T002 -> T003 -> T004; T005 and T006 are independent of those and each other.
- US2: T007 -> T008 -> T009; T010, T011, T012 are independent. US2 depends on US1 only through `docs/contract.md` being in `files` (T003 before T007's run).
- US3: T013 -> T014 -> T015. Independent of US2.
- T016 any time after T003; T017 after everything (it uses T016's questions); T018 any time after T003; T019 last.

## Parallel example

After T003: T004 (tests), T005 (AGENTS.md), T006 (README table), T007 (check script), T011 (releasing doc) and T012 (changelog) touch different files and can run together.

## Implementation strategy

MVP is Phase 2 alone: the contract, tested. It unblocks SwarmFS design immediately. Then Phase 3 (publishable), then Phase 4 (example). Stop after any phase and the repo is consistent.

## Phase 6: Convergence

- [X] T020 Make the README example installable by following the README alone: list every package the snippet imports in the install line (`npm i swarmwire-lib hyperswarm`, plus `hyperdht` only if the private-DHT branch stays in the quoted snippet), declare `hyperdht` in `devDependencies` in `package.json` because `examples/send-get.js` and the tests import it, and add one line to the allowed-dependencies paragraph in `AGENTS.md` saying why (private-DHT swarm for the example and tests). Keep `check:pack` and `npm run test:all` green per FR-013, SC-003, Constitution Constraints (partial)
- [X] T021 Run the ten-question reading test written in `specs/001-swarmfs-contract-publish-prep/quickstart.md` step 5: give `docs/contract.md` and nothing else to a reader who has not read `lib/` (the user, or a fresh session started without this conversation), compare every answer with the expected one, fix `docs/contract.md` wherever a question was answered wrongly or not at all, and record the result (questions answered correctly out of ten) in `quickstart.md` per SC-001 (partial)
- [X] T022 Record the transitional state in `AGENTS.md`: `bin/swarmwire.js` and `test/net/cli.test.js` stay here only until the CLI is extracted to `swarmwire-cli`, are not published, and must not gain features; point to the CLI extraction item in `docs/roadmap.md` per Constitution V (contradicts, transitional)
- [X] T023 Link the CLI from the README sentence "moving to its own package, `swarmwire-cli`" to `https://github.com/tibocub/swarmwire-cli` (repository field of the published placeholder) and the npm package page per FR-014 (partial)
- [X] T024 Correct the "Status" paragraph of `README.md` (it still says there are no request timeouts; `docs/roadmap.md` records them as done) so the npm page text matches the roadmap per FR-012 (partial)
