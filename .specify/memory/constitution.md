<!--
Sync Impact Report
Version change: none (template) → 1.0.0
Modified principles: n/a (initial set)
Added sections: Core Principles (I–V), Constraints, Workflow, Governance
Removed sections: none
Deferred TODOs: none
Design note: AGENTS.md already holds the layering rule, the six invariants, the Node/Bare rules and
the testing workflow. This constitution wires Spec Kit's gates around them instead of restating
them, so there is one copy to keep in sync.
-->

# swarmwire Constitution

## Core Principles

### I. AGENTS.md Is Authoritative (NON-NEGOTIABLE)

The boundary rule, the six invariants and the Node-and-Bare runtime rules in `AGENTS.md` are hard
constraints, not guidance. Every spec, plan and task MUST be checked against them directly. A
change that needs a new invariant MUST edit the invariant list in `AGENTS.md` in the same commit,
with the reason. Rationale: restating them here would create a second copy that drifts.

### II. swarmwire Moves Bytes, Nothing Else

swarmwire takes a root and returns verified bytes. Names, directories, users, permissions,
mutable references and trackers belong to SwarmFS or Hypergraph, one layer up. A feature that
cannot be expressed as "a root in, bytes out" MUST be declined or moved up a layer. Policy that
only an application can know (who may fetch, which peers to prefer) enters through a hook or a
hint, never as built-in behaviour.

### III. Hints Add Options, Never Correctness

Anything a caller or peer supplies — peer lists, priorities, sizes, filenames, availability — is a
hint. A transfer MUST complete correctly when every hint is wrong or stale, and a hint MUST NOT
be able to stall one. Verification against the root and per-connection scheduling stay inside
swarmwire. Rationale: higher layers see slowly-changing, eventually-consistent state; only
swarmwire sees the live connection.

### IV. Test-First, Proved on the Harness

Transfer and verification logic is written test-first, because a bug there corrupts files. Every
resilience claim MUST have a `test/swarm/` test that does the bad thing, with no
`setTimeout`-based waiting. A scheduling or strategy change MUST be backed by numbers from
`npm run bench` or the simulation harness, not by reasoning alone. Both `npm test` and
`npm run test:bare` MUST pass before a feature merges.

### V. A Published API Is a Promise

The exported API of `index.js` is what SwarmFS and `swarmwire-cli` build on. Additions MUST be
justified by a concrete consumer. Breaking an export MUST bump the version, following semver once
published. The wire format in `docs/format.md` changes only deliberately, and unknown messages
MUST stay ignorable so old peers survive new ones. The CLI lives in its own repository; this
repo keeps only a minimal example that doubles as a test.

## Constraints

- Allowed dependencies are those listed in `AGENTS.md`; each new one needs a line there saying
  why. No dependency may import `module` or break on Bare.
- No `Buffer`, no `node:` imports and no un-imported `process` in library code.
- ESM, Node >= 20, no build step, no TypeScript, files under about 300 lines.

## Workflow

- Branch per feature off `main`, merged when its tests pass.
- `specs/<feature>/` (spec, plan, tasks) is the record for anything new. `docs/roadmap.md` stays
  the milestone overview and is updated in the same change as the work.
- Every `/speckit-plan` MUST pass the Constitution Check against this file and `AGENTS.md` before
  research and again after design. Violations are fixed or justified in the plan's Complexity
  Tracking table; Principles I and II cannot be justified away.

## Governance

This constitution supersedes ad hoc practice. Amend it with `/speckit-constitution`, versioned
semantically: MAJOR for a principle removed or redefined incompatibly, MINOR for a principle or
section added, PATCH for wording. Reviews verify compliance with Principles I–V. Runtime guidance
for contributors and agents lives in `AGENTS.md`.

**Version**: 1.0.0 | **Ratified**: 2026-10-21 | **Last Amended**: 2026-10-21
