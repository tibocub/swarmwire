# Implementation Plan: On-Demand Serving

**Branch**: `004-on-demand-serving` | **Spec**: [spec.md](spec.md)

## Constitution Check

- I (AGENTS.md): no new import, no new dependency; Bare-safe (`fs.promises.rename` exists in
  `bare-fs`). Invariant 2 holds: a `.part` file receives only verified groups, and the rename
  happens after the last one. Invariant 3 holds: resolved files are read in place. Invariant 6
  holds by construction when the network's `join` goes nowhere.
- II: `resolve` is a lookup the application supplies; swarmwire still knows no names.
- III: a resolved path is a hint; the root is recomputed before anything is served.
- IV: tests first, in `test/swarm/on-demand.test.js` and `test/swarm/timeout.test.js`.
- V: additions only (constructor options, one `download` option); minor version bump.

## Design

- `lib/on-demand.js` (`OnDemand`): `get(root)` returns the open source (touching it), or resolves,
  opens and checks it; concurrent asks share one open. `add()` enforces the limit.
- `lib/swarmwire.js`: `_onWant` and `_onRequest` fall back to `onDemand.get()` when nothing is
  served and no partial download can answer. A read on a source closed meanwhile is a `reject`.
  With `resolve` set, a finished download joins the bounded set instead of staying open forever.
- `Download`: `_writePath` is `<path>.part` when temporary (never for a memory destination);
  `_finish` renames after `finish()`. `_onUnavailable` records the peer and calls `_pumpAll`
  (which emits `stalled`) once every asked peer said unavailable.
- No-announce mode needs no code: every `join` result is already used optionally.

## Complexity Tracking

None.
