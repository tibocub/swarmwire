# Implementation Plan: SwarmFS Contract and Publish Prep

**Branch**: `001-swarmfs-contract-publish-prep` | **Date**: 2026-10-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-swarmfs-contract-publish-prep/spec.md`

## Summary

Write the contract between swarmwire and the layers above it (`docs/contract.md`), make the
package publishable as **`swarmwire-lib`** at **0.1.0**, and add a README example that the test
suite runs. No library behaviour changes. The contract documents what exists today and marks the
four capabilities that do not exist yet (peer hints, admission decisions, peer activity events and
counts, a public folder file-list reader) as *planned*, each pointing at the feature that will
build it. A test keeps the contract's export list honest, and a pack check keeps tests and
benchmarks out of the published package.

## Technical Context

**Language/Version**: JavaScript (ESM), Node >= 20 and Bare >= 1.16, no build step

**Primary Dependencies**: unchanged. No dependency is added (Constitution, Constraints).

**Storage**: N/A

**Testing**: `brittle`. Contract-export test in `test/unit/` (runs on Node and Bare); example run
in `test/net/` (real Hyperswarm on a private DHT, as `cli.test.js` does); a pack check in CI.

**Target Platform**: Node 20/22 on Linux and Windows, Bare on Linux and Windows (existing CI matrix)

**Project Type**: library (published package)

**Performance Goals**: N/A. This feature changes no runtime path.

**Constraints**: Bare-safe (no `Buffer`, no `node:` imports in anything under `lib/` or the
example); the published package must exclude tests, benchmarks and specs.

**Scale/Scope**: one document, one `package.json` change, one example, two small checks.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1.*

| Principle | Result |
|---|---|
| I. AGENTS.md authoritative | Pass. No invariant is touched. The contract cites the invariants instead of copying them; `AGENTS.md` gains a pointer to the contract. |
| II. Moves bytes, nothing else | Pass. The contract's "will not do" list (FR-007) is this principle written for consumers. Admission and hints enter as hooks and hints, never as built-in policy. |
| III. Hints add options | Pass. Written into the contract as a normative rule (FR-002). |
| IV. Test-first, proved on harness | Pass. The only new logic is the contract-export test and the example; the export test is written first and fails until `docs/contract.md` lists the real exports. No scheduling change, so no benchmark. |
| V. A published API is a promise | Pass, and this feature is the first application of it: 0.1.0, exports enumerated, wire format untouched. |
| Constraints (Bare, deps, size) | Pass. Example and checks are Bare-safe; the pack-check script is Node-only dev tooling outside `lib/`. |

Post-design re-check (after Phase 1): unchanged, no violations. Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-swarmfs-contract-publish-prep/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── contract-draft.md   # becomes docs/contract.md
└── tasks.md                # /speckit-tasks
```

### Source Code (repository root)

```text
docs/
├── contract.md             # NEW: the deliverable (from contracts/contract-draft.md)
└── releasing.md            # NEW: release procedure (FR-015)
CHANGELOG.md             # NEW: 0.1.0 entry (not published)
examples/
└── send-get.js             # NEW: ~30 lines, run by the test and quoted in the README
scripts/
└── check-pack.js           # NEW: fails if the packlist holds tests, bench, specs or lacks LICENSE
test/
├── unit/contract.test.js   # NEW: every export the contract lists is importable
└── net/example.test.js     # NEW: runs the example as two processes, compares bytes
package.json                # name, version, private, files, repository, keywords, bin removed
README.md                   # install line, example, CLI pointer, fixed SwarmFS link
AGENTS.md                   # pointer to docs/contract.md
.github/workflows/test.yml  # + pack-check step
```

**Structure Decision**: single library project, as today. Nothing under `lib/` changes.

## Decisions confirmed by the user

**Folder file-list reader (FR-003a), confirmed 2026-10-21.** Make the manifest reader public as a separate
step (planned for feature 002) and document "read the list, then download the files you want"
as the way to take part of a folder. Do **not** add a filter to `downloadCollection`. The
selection UI and logic stay in SwarmFS. Reasoning is in [research.md](research.md) item 6.

## Complexity Tracking

No violations to justify.
