# Piece selection at scale

What was measured when choosing how a downloader picks the next group, and which ideas were
built. The model and its limits come first, because every number below is only as good as it is.

Reproduce with `npm run bench:sim -- --peers 1000 --seeders 1 --seeds 3` (flags in
`bench/swarm-sim.js`). Same settings and seed give the same table.

## What the numbers were produced on

Intel Core i5-3320M (2 cores, 4 threads, 2.6 GHz, up to 3.3 GHz), 11 GiB RAM, Linux 7.2,
Node 22.22.2, a hard disk and an SSD both attached. The model touches no disk and uses almost no
memory, so only the processor matters, and only for how long a run takes: one 1,000-downloader
run is about 6.5 minutes on one core, and the 15 runs of the main table took 24 minutes on four.
The *results* are in ticks and do not depend on the machine at all.

## The model

`bench/sim/model.js` runs `lib/select.js` itself (imported, not copied) over abstract peers.

- **Swarm**: downloaders all start together; each peer links to up to 64 random others; seeders
  hold everything; a finished downloader keeps serving.
- **Time**: requests, answers and refusals each take 4 ticks; a downloader uploads 1 group per
  tick, a seeder 4; download capacity is unlimited. Holdings are seen instantly.
- **Requests**: a window of 4 per neighbour (the library's floor: with one group per tick shared
  by 64 neighbours, the adaptive window settles there); an unanswered request is given up after
  256 ticks and asked of someone else, and the late answer still counts; a window halves on
  timeout and refusal.
- **File**: 512 groups of 16 KiB = 8 MiB, so the 256-group scan limit is half the file. With 1,000
  downloaders the swarm moves 7.8 GiB.
- **Seconds and MB/s** are an illustration: they assume each downloader uploads at 10 Mbit/s, so
  one tick is 13.1 ms. A different uplink scales every time and rate by the same factor and
  changes no comparison.

**Not modelled, so not measured**: framing, proofs, disk, discovery, NAT, churn, peers leaving,
uneven bandwidth, congestion on shared links, a real choking policy, a late joiner arriving at a
swarm already running. Uploading is a FIFO queue per peer. Treat the figures as a comparison
between strategies under identical conditions, not as predictions.

**Checked against real nodes.** `test/swarm/spread.test.js` has one sender and a hundred
newcomers on the deterministic network, 200 groups. After three files' worth of sender uploads
the share of the file uploaded at least once is **0.04** with the first release's code (8 groups
of 200; all hundred downloaders made the same first request) and **0.92** with this feature. The
model on a crowd of that shape gives 0.08 and 0.95 (`test/unit/sim.test.js`).

## Selection

1,000 downloaders, 1 seeder, 3 seeds:

| strategy | median (ticks) | range | median time | rate per downloader | of ideal | last (ticks) | last range |
|---|---|---|---|---|---|---|---|
| file order (first release) | 8348 | 6555-8349 | 109 s | 0.08 MB/s | 6% | 8410 | 6633-8416 |
| random window and ties | 897 | 894-911 | 11.8 s | 0.71 MB/s | 57% | 948 | 936-983 |

"Of ideal" compares with receiving one group every tick from the start (512 ticks, which is 1.25 MB/s: the
uplink itself).

**Verdict: built.** Starting the scan at a random group and breaking ties at random takes the median
from 109 s to 12 s, nine times faster. A downloader asking in file order asks for the same few
groups as every other newcomer, so the seeder uploads them again and again (98% of its uploads
are repeats) while the rest of the file waits.

**A random first group was tried and removed.** It made no difference (906 against 897 ticks, inside
the spread), because in a flash crowd every group is equally rare at the first request, so the
tie-break already makes the first pick random. The usual reason for it, having something to trade
under tit-for-tat, does not exist without choking. It could only matter to a late joiner arriving
at a running swarm, which this model cannot show.

## Super-seeding and endgame

Against random window and ties, 3 seeds. Each cell is median / last, in ticks, with the change
from the baseline.

| setting | baseline | gradual reveal | refusal | endgame |
|---|---|---|---|---|
| 1,000 downloaders, 1 seeder | 897 / 948 | 862 / 917 (-3.9% / -3.3%) | 894 / 949 (-0.3% / +0.1%) | 876 / 935 (-2.3% / -1.4%) |
| 300 downloaders, 1 seeder | 814 / 848 | 773 / 798 (-5.0% / -5.9%) | 802 / 836 (-1.5% / -1.4%) | 798 / 843 (-2.0% / -0.6%) |
| 300 downloaders, 5 seeders | 554 / 576 | 557 / 576 (0 / 0) | 569 / 586 (+2.7% / +1.7%) | 554 / 576 (0 / 0) |
| 300 downloaders, uplink 2 | 505 / 519 | 484 / 500 (-4.2% / -3.7%) | 498 / 519 (-1.4% / 0) | 496 / 533 (-1.8% / +2.7%) |

The bar (SC-004) is 5% on the median or the last finisher at 1,000 downloaders, with the other
not worse by more than 2%, and the gain larger than the spread across seeds.

- **Endgame: not built.** 2% at best, and 124,864 groups sent twice (against 512,000 needed),
  because the protocol cannot cancel a request once another peer has answered it.
- **Super-seeding by refusal: not built.** Nothing at 1,000 downloaders. Each refusal (1,246) is a
  request that has to be made again.
- **Super-seeding by revealing groups gradually: not built.** 3% to 4% at 1,000 downloaders,
  5% to 6% only at 300 with one seeder, nothing with five seeders. It also makes a seeder look
  like a leecher in `counts()`, because it advertises less than it holds, which would make
  "peers with all of it" wrong in `swarmwire-cli`. A gain under the bar does not pay for that.

## Uneven uplinks and hotswap

Added after the verdicts above, because they named uneven bandwidth as the thing that could
change them. `hotswap` is Hypercore's rule: once everything a peer is missing has been asked for,
ask again for the least-asked groups, up to 3 copies each. `--slow 0.2` makes a fifth of the
downloaders serve one tick in eight (`--slowEvery`). 1 seeder, 64 neighbours, medians over 3
seeds, in ticks:

| | strategy | median | last | wasted |
|---|---|---|---|---|
| all peers equal (300) | random-ties (built) | 814 | 848 | 67 |
| | endgame | 798 | 843 | 28,626 |
| | hotswap | 840 | 915 | 57,416 |
| 20% slow (200) | random-ties (built) | 1307 | 2460 | 10,457 |
| | endgame | 1015 | 1202 | 59,503 |
| | hotswap | 987 | 1162 | 39,253 |

With equal peers neither helps and hotswap is about 3% slower. With slow peers the last
downloader waits on a group stuck in a slow peer's queue, and both cut that roughly in half.
**Not built**, because the 20% and the factor of 8 are assumptions, not measurements. If it is
built, hotswap is the one to build, ideally only for requests already outstanding for a long
time (not simulated).

## What would change these verdicts

A model with real choking and uneven bandwidth, a larger file, peers that leave, a late joiner, or
measurements on a real swarm. The 5% bar is smaller than the model's uncertainty about the world;
the nine-fold effect of random selection is not.
