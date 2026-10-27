# Tasks: On-Demand Serving

**Input**: `specs/004-on-demand-serving/`. Tests first (Principle IV).

- [X] T001 [US1] Test: application-owned topic, network `join` goes nowhere; serve, download, readList, downloadFile, downloadCollection work and no other topic is joined (`test/swarm/on-demand.test.js`)
- [X] T002 [US2] Tests: resolved file arrives, async resolver, changed file / null / throw answer "not held", bounded open set with reopen (`test/swarm/on-demand.test.js`)
- [X] T003 [US2] `lib/on-demand.js` and the fallback in `_onWant` / `_onRequest`; finished downloads join the bounded set when `resolve` is set
- [X] T004 [US3] Test: nothing at the target while partial or stopped, resume from `.part`, clean end state
- [X] T005 [US3] `temporary` option, `fsx.rename`, rename in `Download._finish`
- [X] T006 [US4] Test: every peer unavailable gives `stalled` with no clock advance (`test/swarm/timeout.test.js`)
- [X] T007 [US4] `Download._onUnavailable`
- [X] T008 `docs/contract.md`, `CHANGELOG.md`, README, `docs/roadmap.md`; version 0.6.0
- [X] T009 `npm test` and `npm run test:bare` pass
