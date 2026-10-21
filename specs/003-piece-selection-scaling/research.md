# Research: Piece Selection and Swarm Scaling

Checked against the repository on 2026-10-21 unless marked unverified.

## 1. What the current selection does, and why random ties are not enough

- **Finding**: `Download._pump` takes `this._destination.missing()` (every missing group index, a
  fresh array of up to 65,536 numbers for a 1 GiB file, on every call), passes it to
  `rarestFirst`, which keeps only the **first 256** and sorts them by holder count then index.
  Ties therefore go to the lowest-numbered groups, and nothing beyond the first 256 missing groups
  is ever considered.
- **Consequence**: with only random ties, a thousand fresh downloaders of a 10 GiB file would
  spread over groups 0 to 255 of 655,360. The seeder would still upload the same 256 groups
  hundreds of times. SC-001 would fail on any large file.
- **Decision**: choose candidates from a **random window**: start the scan at a random group,
  walk forward (wrapping) and collect up to the scan limit of groups that this peer holds, we
  lack and nobody is already fetching. Rank those by availability, ties at random.
- **Side benefit**: filtering by what *this peer holds* fixes a latent miss: today a peer holding
  only groups outside the first 256 missing is asked for nothing.
- **Cost**: one pass over a bitfield, early exit at the limit. Worst case (almost everything held)
  is a scan of the whole range, which only happens near the end of a download.

## 2. Random first group (REMOVED after review, see item 11)

- **Decision**: when a download holds no group and has nothing in flight, its first pick is
  uniformly random among the candidates, ignoring rarity. Everything after follows rarity.
- **Rationale**: BitTorrent does this for a reason that holds here: the rarest group has the
  fewest sources, so starting there delays having anything to trade; any group is better to start
  with. A resume (anything held) skips it, as FR-002 says.
- **Expected effect**: small once the window is random, because with a single seeder every group is
  equally rare. It matters when peers hold different parts. The simulation includes it as its own
  strategy so its effect is measured rather than assumed.

## 3. Availability counts

- **Finding**: `Download._holders(index)` loops over every source peer and tests a bit, and
  `rarestFirst` calls it once per candidate. At 64 neighbours and 256 candidates that is 16,384
  bit tests *per request*. A 1 GiB file is 65,536 requests: about 1e9 operations on one download,
  and 8e9 for the 512-group, 1,000-peer simulation workload. Unaffordable for the simulation and
  wasteful in the library.
- **Decision**: keep a count per group (`Availability`, a `Uint16Array`): add a peer's bitfield on
  `have`, increment on `holds`, subtract a peer's bits when it leaves, sends `unavailable`, or is
  marked a liar. `holders(index)` becomes an array read.
- **Check**: counts must equal a recount from the bitfields after any sequence of events; a unit
  test asserts that with random event sequences.

## 4. Simulation: model, not real nodes

- **Options**: (a) real `Swarmwire` nodes on `TestNetwork`; (b) a model that runs the shared
  selection code over abstract peers.
- **Why not (a) at 1,000 peers**: 64 neighbours each is about 32,000 connections, each a streamx
  duplex plus a protomux channel; each downloaded group sends a `holds` frame to every neighbour
  that asked about it (about 64 per group); 1,000 peers by 512 groups by 64 is 32 million frames,
  each costing a stream write. This is hours, against a target of minutes.
- **Decision**: (b). Peers are objects with bitfields, a neighbour list, an upload queue and a
  request window. A tick delivers what is due. The selection code is `lib/select.js`, imported, not
  copied; the request loop around it (about 15 lines) mirrors `Download._pump`. The seeded random source is a new `test/helpers/random.js` (`xorshift(seed)`); the harness has none today.
- **What the model does not cover, stated so no verdict leans on it**: framing, proofs, disk,
  DHT/discovery, NAT, churn, congestion on shared links. It models: who connects to whom, who holds
  which groups, per-peer upload rate, latency, and the request window.
- **Guard against model drift**: the real-node test (SC-001, 100 downloaders on the deterministic
  network) and the model must agree in direction on the same question (how many distinct groups the
  seeder has uploaded after three files' worth). If they disagree, the model is wrong until shown
  otherwise.
- **Spec adjustment**: FR-009 asked the simulation to verify byte-identical downloads. A model does
  not move bytes. What it asserts instead: every peer finishes holding every group exactly once,
  and a duplicate is discarded. Byte-identity stays proved where bytes move (the existing transfer
  tests, and the real-node test). The spec is updated to say so.

## 5. Swarm shape for the model

- **Neighbours**: each downloader connects to up to 64 others chosen at random, seeders accept up
  to 64 too (so with one seeder, at most 64 downloaders can be fed from it directly: this is the
  question being asked, not a bug). Connections are symmetric.
- **Time**: ticks. Upload limit in groups per tick per peer (default 1 for a downloader, 4 for a
  seeder, settable). Latency in ticks. Download capacity unlimited (the constraint of interest is
  the uplink).
- **Arrival**: all at once (a flash crowd) by default, staggered optional.
- **Size**: 512 groups per file by default (the model counts groups, not bytes).
- **Window**: a fixed 32 requests per neighbour, so strategies are compared on equal footing and
  the adaptive window (already measured) does not add noise.
- **Settings are explicit**: peers, seeders, neighbours, uplink, latency, file groups, seed, so a
  run is reproducible and one setting can change at a time (story 2, scenario 5).

## 6. Strategies to compare

| Name | Tie-break | First group | Seeder | Endgame |
|---|---|---|---|---|
| `file-order` | file order | no | serve all | off |
| `random-ties` | random | no | serve all | off |
| `random-first` | random | random | serve all | off |
| `superseed-reveal` | random | random | reveals groups gradually | off |
| `superseed-reject` | random | random | rejects over-served groups | off |
| `endgame` | random | random | serve all | on |

- **`file-order`** is today's behaviour and the baseline. Shipped code takes the first 256 *missing* groups and filters by what the peer holds afterwards; `candidates` filters first. So `candidates` has a `legacy` flag (limit before filter) that only this row uses, to keep the baseline faithful.
- **Super-seeding by reveal**: the seeder answers `want` with a bitfield containing only a few
  groups chosen for that peer, and announces more (`holds`) as the peer proves useful. Uses
  existing messages. *Open*: how the seeder knows the peer passed a group on; the simplest signal
  is a neighbour's `holds`, available only if the seeder is connected to that neighbour.
- **Cost of reveal, beyond speed**: a seeder that advertises only some groups makes `counts()` report it as a leecher (and swarmwire-cli's "M with all of it" wrong), and bends the meaning of `have` ("what I hold"). The verdict must weigh this; it may disqualify the variant alone.
- **Super-seeding by reject** (the maintainer's suggestion): the seeder serves everything but
  answers a request for an already-over-served group with `reject`. *Known cost to model*:
  `Download._onReject` halves that peer's request window and clears the bit, so a downloader
  rejected often throttles itself. The model applies the same rule.
- **Endgame**: once everything missing is already requested from someone, idle neighbours are asked
  for the same groups. *Known cost*: the protocol has no cancel, so duplicates run to completion
  and cost uplink. The model charges that cost, because it is the point.
- **Out of scope**: choking, rate allocation, peer ranking.

## 7. The decision rule

- **Decision**: SC-004 as written: a strategy is built if it cuts the last downloader's time, or
  the median, by at least 5% against the best already-built strategy at 1,000 downloaders, and
  does not worsen the other by more than 2%, and the gain exceeds the spread across the five seeds.
- **Noise**: the model is deterministic per seed, but different seeds give different swarms.
  Verdicts use the median of five seeds and report the spread; a margin inside the spread is "no
  verdict, does not clear". The 5% and 2% are revisited only if the spread is larger than them.
- **Where recorded**: `docs/scaling.md`, one section per strategy: settings, table, verdict.

## 8. Contract and compatibility

- **`random` option**: `new Swarmwire({ swarm, random })`, `random()` returns a number in [0, 1).
  Default is `Math.random` (present on Bare). Not a stable promise beyond "it exists for tests";
  the contract lists it under advanced use.
- **Behavioural change**: downloads no longer proceed roughly in file order (the one visible
  effect). Stated in the contract and changelog; version 0.3.0.
- **Wire**: unchanged for selection. Super-seeding by reject or reveal uses existing messages; if a
  verdict says otherwise, that is raised then, not assumed now.

## 9. Benchmarks

- Run `npm run bench` before the first change and after the last. Requests, wasted requests and
  proof overhead must be identical (SC-002); the tick columns are compared by *completion* time as
  in 002 (the loop in `bench/swarm.js` measures time to network idle).

## 10. As built (differences from the plan above)

- **Availability follows `_bitfields`**, not `_sources` (item 3): it is where the data lives and needs fewer touch points (`_setBitfield`, `_dropBitfield`, `holds`, `reject`). A peer struck out for timeouts, or one that said `unavailable`, still counts towards rarity; harmless, since rarity is only a preference.
- **`peers` in the model means downloaders** (seeders are extra), so `--peers 1000` is the spec's thousand downloaders.
- **Model additions found necessary** (item 5): a request **timeout** (default 256 ticks; without it requests queued at a busy peer can never be re-asked and the run measures a convoy, not the strategy), narrowing of the per-neighbour window on timeout and refusal as in the library, late answers still accepted, and a default **window of 4** (the library's floor: with an uplink of one group per tick shared by 64 neighbours, larger windows only grow queues until requests time out and are asked twice). A total-pipeline cap was tried and removed: it let requests stuck at the busy seeder block asking idle peers, which the library does not do.
- **Cost**: one 1,000-downloader run takes about 6.5 minutes on one core; `npm run bench:sim` spreads runs over the cores. A table of 3 strategies x 3 seeds took 17 minutes on 4 cores.
- **The seeder in the cross-check** has an uplink of 8 groups per tick, not 1: at 1, a hundred directly attached newcomers queue longer than the timeout and the run collapses, which says nothing about selection.

## 11. Revisions after review (2026-10-21)

- **Random first group removed.** In a flash crowd every group is equally rare at the first
  request, so the random tie-break already makes it random; the model cannot tell the two apart
  (906 against 897 ticks, inside the spread). BitTorrent's reason for it is having something to
  trade under tit-for-tat, and swarmwire has no choking. It does no harm to correctness (every
  group is still verified) but was not shown to help, so `pickFirst`, the `first` strategy
  option and FR-002's original wording went. A late joiner arriving at a running swarm is the
  only case that could differ; the model has no staggered arrivals, so it is unmeasured.
- **`legacy` moved out of the library** into `bench/sim/model.js`: it exists only to reproduce
  the first release's rule for the baseline row.
- **`random` is no longer a constructor option**: `Swarmwire#random` is a plain field (default
  `Math.random`) that tests assign. A documented option would be a promise to SwarmFS and the CLI
  with no consumer but tests (Principle V).
- **All simulation figures were re-run** after these changes, because removing the first-group
  pick changes the model's random draws; `docs/scaling.md` holds the new numbers.
- **Real-node check of the baseline**: the spread test run against the first release's code
  gives 8 distinct groups of 200 after 600 seeder uploads, and all 100 downloaders make the same
  first request; with this feature, 184 distinct groups.
