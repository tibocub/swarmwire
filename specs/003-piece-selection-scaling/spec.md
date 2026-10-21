# Feature Specification: Piece Selection and Swarm Scaling

**Feature Branch**: `003-piece-selection-scaling`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "Piece selection and swarm scaling: a random tie-break in rarest-first selection (today ties go to file order, so a thousand fresh downloaders all ask for the same first group), a random very first group before rarest-first takes over, and a large-swarm simulation (bounded neighbours around 64, a per-node uplink limit, many downloaders and few seeders) that measures strategies against each other and decides whether seeder-side super-seeding (handing different groups to different peers, using the existing reject message) and endgame mode (re-requesting the last few groups from several peers) earn their place; only strategies the simulation shows to help are built."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A crowd of new downloaders does not all ask for the same thing (Priority: P1)

Someone shares a large file and a few hundred people start downloading it at once. Today every
fresh downloader asks for the same groups first (the lowest-numbered ones), so the single seeder
uploads the same few groups hundreds of times while the rest of the file sits unrequested. The
downloaders then have nothing to trade with each other, and the seeder's upload is wasted on
repeats.

A downloader prefers the groups fewest peers hold, breaking ties at random instead of by position
in the file. A crowd
of fresh downloaders therefore spreads its first requests across the whole file, and the seeder's
first three files' worth of upload covers almost every group at least once, so downloaders can start
serving each other quickly.

**Why this priority**: it is a small change with a large effect on a swarm's first minutes, it is
the one part of the request that needs no new measurement to justify (the problem is visible in
the current behaviour), and it is the baseline every other strategy is compared against.

**Independent Test**: in the deterministic test network, start one seeder and many fresh
downloaders together; count how many distinct groups the seeder has uploaded after one file's
worth of upload. Compare with the same run before the change.

**Acceptance Scenarios**:

1. **Given** one seeder and a hundred fresh downloaders starting together, **When** the seeder has
   uploaded three files' worth of data, **Then** nearly every group of the file has been uploaded at
   least once, where before the change it was a small fraction of them.
2. **Given** a downloader that holds no groups, **When** it makes its first request, **Then** the
   group it asks for is chosen at random, and two fresh downloaders with different random seeds
   usually ask for different groups.
3. **Given** a downloader that already holds some groups, **When** it chooses what to ask for next,
   **Then** it prefers the groups held by the fewest connected peers, and among equally rare
   groups it chooses at random.
4. **Given** a single downloader and a single seeder, **When** the file is downloaded, **Then**
   the file arrives intact and the existing benchmarks for requests per file, wasted requests
   and proof overhead are unchanged.
5. **Given** a test that fixes the random source, **When** it runs twice, **Then** the choices are
   identical both times.

---

### User Story 2 - Measuring how strategies behave in a large swarm (Priority: P2)

The maintainer wants to know, before building anything elaborate, whether ideas such as
seeder-side super-seeding or endgame mode would actually help, and by how much. A simulation of a
large swarm, with a bounded number of neighbours per peer and a limit on how much each peer can
upload, runs the same crowd of downloaders under several strategies and prints a comparison.

**Why this priority**: it is what turns "should we build X" from opinion into a number, and it
comes after the first story because the first story's change is the baseline it measures.

**Independent Test**: run the simulation twice with the same seed and the same settings and get
the same table; change the strategy and see the numbers change.

**Acceptance Scenarios**:

1. **Given** the simulation with a thousand downloaders, few seeders, about sixty-four neighbours
   per peer and a per-peer upload limit, **When** it runs, **Then** it reports for each strategy
   how long the median and the last downloader take, how much of the seeders' upload was spent on
   groups already uploaded elsewhere, and how many requests were wasted.
2. **Given** the same settings and seed, **When** it runs twice, **Then** the output is identical.
3. **Given** the strategies "ties in file order", "random ties", with super-seeding added, and with endgame mode added, **When** the simulation runs,
   **Then** all of them appear in one comparison, run under identical conditions.
4. **Given** every strategy, **When** a simulated download finishes, **Then** it holds every group
   exactly once: no strategy trades completeness for speed.
5. **Given** the settings (number of downloaders, seeders, neighbours, upload limit, file size),
   **When** the maintainer changes one, **Then** only that one changes and the rest of the setup
   stays the same.

---

### User Story 3 - Only what the numbers justify gets built (Priority: P3)

Super-seeding (a seeder hands different groups to different peers instead of serving whoever asks
first) and endgame mode (the last few groups are requested from several peers at once so one slow
peer cannot hold up the finish) are known ideas with known costs: extra complexity, extra waste, a
risk of misbehaving next to peers that do not know them. Each one is built only if the simulation
shows it helps, and is otherwise left out with its numbers written down.

**Why this priority**: it depends on the measurements, and it is the decision the maintainer asked
for, not a feature in itself.

**Independent Test**: for each of the two strategies, the repository holds either the numbers that
justified building it, together with a test showing it works, or the numbers that justified
leaving it out.

**Acceptance Scenarios**:

1. **Given** a strategy that improves the last downloader's completion time by the agreed margin
   without making anything else worse, **When** the decision is made, **Then** it is built, tested
   on the deterministic test network, and enabled by default only if it does not hurt a single
   plain download.
2. **Given** a strategy that does not clear the margin, **When** the decision is made, **Then** it
   is not built, and the simulation results and the reason are recorded in the project's
   documents so the question is not reopened without new evidence.
3. **Given** a peer that does not know a strategy (an older version, or another implementation),
   **When** it takes part in a swarm that uses the strategy, **Then** its downloads still complete
   correctly; the strategy changes order and speed, never whether a transfer can finish.

---

### Edge Cases

- A file of a single group: nothing to choose, the download still completes.
- A downloader that resumes with groups already held: it continues by rarity and never asks for
  what it already holds.
- Every group equally rare (for example a single seeder holding everything): the choice among them
  is random, not the first.
- A downloader connected to only one peer: the same choices apply; there is nothing to spread.
- A seeder serving one downloader under super-seeding: it must still hand over every group, not
  withhold groups waiting for other peers who are not there.
- Endgame requests that arrive twice: the duplicate is accepted once and discarded safely, never
  counted twice, never corrupting the file.
- A folder download: each file is chosen separately, files are still fetched in turn, and nothing
  about the folder's list changes.
- Choice order is no longer roughly file order: an application that wanted to read a file while it
  downloads loses that; swarmwire moves bulk data and the contract says so.
- The simulation is asked for more peers than the machine can hold: it fails clearly rather than
  running for hours.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When choosing which groups to request, a downloader MUST break ties between groups
  held by the same number of connected peers at random, not by position in the file.
- **FR-002**: *(Revised after review; the original required a random first group.)* The search for
  wanted groups MUST start at a random place in the file, so that breaking ties at random is not
  limited to the first few hundred groups. A special random first group was tried in the model,
  showed no benefit, rests on a reason (something to trade) that does not apply without choking,
  and was removed.
- **FR-003**: The source of randomness MUST be replaceable, so tests and the simulation can fix it
  and get identical runs (Constitution Principle IV).
- **FR-004**: A single download between one seeder and one downloader MUST produce identical bytes
  and MUST NOT regress the existing benchmark figures for requests per file, wasted requests or
  proof overhead.
- **FR-005**: The library MUST NOT change the wire format for FR-001 and FR-002.
- **FR-006**: A repeatable simulation of a large swarm MUST exist: a configurable number of
  downloaders and seeders, a bound on neighbours per peer (default about sixty-four), a limit on
  each peer's upload, and a fixed random seed, producing identical output for identical settings.
- **FR-007**: The simulation MUST compare, under identical conditions, at least: ties in file
  order (today's behaviour), random ties, and each of those
  strategies of this feature that has been built or is under evaluation (super-seeding, endgame).
- **FR-008**: For each strategy the simulation MUST report the completion time of the median and of
  the last downloader, the share of each seeder's upload that repeated groups already uploaded,
  and the number of wasted requests.
- **FR-009**: The simulation MUST verify that every simulated download ends holding every group
  exactly once, with duplicates discarded. Byte-identity of what is transferred stays proved where
  bytes actually move (the transfer tests, and the real-node test of this feature).
- **FR-010**: Seeder-side super-seeding and endgame mode MUST each be evaluated in the simulation
  against the baseline before any code for them is written into the library.
- **FR-011**: A strategy MUST be built only if the simulation shows it improves the completion time
  of the last downloader, or of the median, by at least the margin in SC-004 without worsening
  the other, and without regressing a plain download (FR-004). Otherwise it MUST NOT be built.
- **FR-012**: The outcome for each evaluated strategy, built or not, with its numbers and the
  settings that produced them, MUST be recorded in the project's documents.
- **FR-013**: Any strategy that is built MUST leave correctness untouched: a transfer completes
  correctly when the strategy is absent on the other side, and a hint or strategy cannot stall it
  (Constitution Principle III).
- **FR-014**: Any strategy that is built MUST be proved in the deterministic test network,
  including the case of a peer that disappears mid-transfer (Principle IV).
- **FR-015**: If any behaviour visible to applications changes, `docs/contract.md` and the
  changelog MUST say so in the same change, including that downloads no longer proceed roughly in
  file order (Principle V).

### Key Entities

- **Selection strategy**: the rule that picks the next group to request: tie-break (file order or
  random), first request (random or not), and any additions such as endgame.
- **Seeder strategy**: how a node holding everything answers requests (serve whoever asks, or
  super-seeding).
- **Simulated swarm**: a set of simulated peers, each with a neighbour bound and an upload limit,
  one file, one fixed random seed.
- **Comparison table**: one row per strategy with the figures in FR-008.
- **Decision record**: for each evaluated strategy, the numbers, the settings and the verdict.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With one seeder and a hundred fresh downloaders starting together, by the time the
  seeder has uploaded three files' worth of data, at least 90% of the file's groups have been
  uploaded at least once. (Before the change: about one request window's worth, a small fraction.)
  Three, not one, because the first file's worth of uploads answers only the first few
  downloaders' request batches: even perfectly random choices cover about 63% after one file's
  worth and about 95% after three.
- **SC-002**: A download between one seeder and one downloader shows no change in the benchmark's
  requests per file, wasted requests and proof overhead, and its completion time is within 2% of
  before.
- **SC-003**: The simulation, run twice with identical settings and seed, prints identical tables,
  and a run of a thousand downloaders finishes in under ten minutes on the maintainer's machine.
- **SC-004**: A strategy is built only if, in the thousand-downloader settings, it reduces the
  completion time of the last downloader or of the median by at least 5% against the best
  strategy that is already built, with no worsening of the other beyond 2%, and a gain larger than the spread across five seeds.
- **SC-005**: In every simulated run, 100% of downloads finish holding every group exactly once.
- **SC-006**: Each evaluated strategy has a recorded verdict with its numbers; none is left
  undecided.

## Assumptions

- "Helps" in FR-011 means the margin in SC-004. The 5% and 2% figures are a starting point,
  chosen so the decision is not made on noise; the plan may adjust them with the measured spread
  between runs.
- The simulation models the swarm at the level of groups and uploads (who holds what, who asks
  whom, how fast a peer can upload), not at the level of network packets. How it is built is for
  the plan; it may reuse the deterministic test network or be a lighter model of it.
- About sixty-four neighbours per peer is Hyperswarm's usual connection ceiling; the figure is a
  setting, not a promise. The simulation does not model the DHT or peer discovery.
- Rarest-first uses the peers a downloader is connected to, as it does now; nothing here adds a
  tracker or a global view.
- Randomness does not need to be cryptographic; a seedable generator is enough.
- Super-seeding and endgame are the only two strategies evaluated here. Others (choking, rate
  allocation, peer ranking) are not in scope.
- No wire change is expected. If evaluation shows super-seeding needs one, the plan must say so
  and that change is decided there, not assumed here.
- The CLI and its new features (word-code rendezvous, passwords, QR) are separate work in
  `swarmwire-cli` and are not part of this feature.
