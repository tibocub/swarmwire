# Implementation Plan: Piece Selection and Swarm Scaling

**Branch**: `003-piece-selection-scaling` | **Date**: 2026-10-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-piece-selection-scaling/spec.md`

## Summary

Make the choice of "which group next" spread a crowd of downloaders across the whole file, then
measure, before building anything else, whether seeder-side super-seeding or endgame mode help.

Three pieces, in order:

1. **Selection** (certain, no wire change): rarest-first with random tie-breaks after that, a **random scan window** instead of
   "the first 256 missing groups" (research item 1: without it, random ties only spread requests
   across the first 256 groups of a large file), and per-group availability counts so choosing
   costs O(1) per group instead of O(neighbours).
2. **Simulation** (`bench/sim/`, not shipped): a seeded, time-stepped model of a large swarm that
   runs the *same* selection code as the library, with bounded neighbours and per-peer upload
   limits, and prints one comparison table.
3. **Verdicts** (conditional): super-seeding and endgame are built only if the table clears the
   margin in SC-004. Their tasks are written after the verdict, not now.

## Technical Context

**Language/Version**: JavaScript (ESM), Node >= 20 and Bare >= 1.16, no build step

**Primary Dependencies**: unchanged. No dependency is added.

**Storage**: none

**Testing**: `brittle`. Selection as pure unit tests with a fixed random source; the crowd effect
(SC-001) on the deterministic network with real nodes; the simulation's determinism as a unit test
on a small swarm. Everything under `test/` also runs on Bare. `bench/` is Node only.

**Target Platform**: Node 20/22 and Bare; Linux and Windows

**Project Type**: library, plus a developer-only simulation under `bench/`

**Performance Goals**: single transfer unchanged (SC-002: benchmark columns equal, completion
within 2%); the simulation runs 1,000 downloaders in under ten minutes (SC-003), which is why the
selection code must be O(1) per group.

**Constraints**: Bare-safe library code (no `Buffer`, no `node:` imports); no wire change for the
tie-break or the first group (FR-005); randomness injectable (FR-003); a strategy never decides
whether a transfer can finish (Principle III).

**Scale/Scope**: up to about 64 connected neighbours per peer; files up to tens of thousands of
groups (a 1 GiB file is 65,536 groups at the default 16 KiB).

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1.*

| Principle | Result |
|---|---|
| I. AGENTS.md authoritative | Pass. Invariants 1 to 4 untouched (every group is still verified before it is stored). Invariant 5: no new message for selection. If super-seeding is built it may only use existing messages; a new one is a separate decision. Invariant 6 untouched. |
| II. Moves bytes, nothing else | Pass. Nothing here is policy. Selection is how bytes are fetched. |
| III. Hints add options | Pass. Super-seeding and endgame are tested against peers that do not know them (FR-013); selection is local and needs no cooperation. |
| IV. Test-first, proved on the harness | Pass. Every change has a fixed-random test first. The strategy numbers required by Principle IV *are* the simulation plus `npm run bench`. A peer vanishing mid-transfer is covered for any strategy that is built (FR-014). |
| V. A published API is a promise | Pass. (As first planned this added a `random` constructor option; review removed it, see research item 11.) The contract and changelog record it and the end of "roughly file order". 0.3.0. |
| Constraints (Bare, deps, size) | Pass. New logic goes in `lib/select.js` (about 80 lines); `lib/swarmwire.js` loses code (the per-call `missing()` and `_holders` loops) rather than gaining it. |

Post-design re-check: unchanged. One decision to watch: the simulation is a model, not real nodes
(research item 4). If its results and the real-node test (SC-001) disagree in direction, stop and
fix the model before drawing any verdict.

## Project Structure

### Documentation (this feature)

```text
specs/003-piece-selection-scaling/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── api.md
└── tasks.md                # /speckit-tasks
```

### Source Code (repository root)

```text
lib/
├── select.js               # EDIT: candidates() scan with a random window, ordering with random
│                           #       ties, random first group, Availability (per-group counts)
├── swarmwire.js            # EDIT: `random` option; Download._pump uses select.js; availability
│                           #       kept up to date on have / holds / unavailable / reject / gone
└── holdings.js             # unchanged
bench/
├── sim/
│   ├── model.js            # NEW: the swarm model (peers, neighbours, upload slots, time)
│   ├── strategies.js       # NEW: named strategies as settings over the shared selection code
│   └── (random: `xorshift` from the new test/helpers/random.js)
└── swarm-sim.js            # NEW: entry; prints the comparison table (npm run bench:sim)
test/
├── helpers/random.js       # NEW: `xorshift(seed)`, the one seeded random source
├── unit/select.test.js     # EDIT: fixed-random tests for window, ties, first group, availability
├── unit/sim.test.js        # NEW: same seed, same table; every peer ends with every group
└── swarm/spread.test.js    # NEW: SC-001 with real nodes on the deterministic network
docs/
├── scaling.md              # NEW: decision record for every evaluated strategy (FR-012)
├── contract.md             # EDIT: `random` option; downloads are not in file order
└── roadmap.md              # EDIT: items 3 and 4 done, with the verdicts
CHANGELOG.md                # EDIT: 0.3.0
package.json                # EDIT: version, "bench:sim" script
```

**Structure Decision**: single library as today; the simulation lives under `bench/` so it is never
published, and imports `lib/select.js` so it measures the code that ships.

## Complexity Tracking

| Addition | Why it is needed | Simpler alternative rejected because |
|---|---|---|
| Random scan window (not just random ties) | Ties are only among the 256 groups scanned; on a large file a crowd still concentrates on the file's start | Random ties alone leave SC-001 failing for any file over 256 groups |
| `Availability` counts | Rarity per group is O(neighbours) today, per candidate, per request; the simulation and a 64k-group file cannot afford it | Recomputing per request is the 8-billion-operation case in research item 3 |
| Model-based simulation | 1,000 real nodes mean ~32,000 connections and one `holds` frame per group per neighbour: hours | Real nodes at that size fail SC-003 |
