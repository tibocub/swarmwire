# What other peer-to-peer systems do

Notes from reading the source of systems that already solved problems we are walking into. Each
section says what the code does, the numbers it uses, and what is worth stealing. Nothing here
is a decision: a decision goes in `contract.md` or `roadmap.md` once someone picks it.

Read in `~/Code`: `boxo` (IPFS Bitswap + provider), `kubo` (IPFS node, config docs only),
`gtk-gnutella`, `tribler`, `nicotine-plus`, `soulseek-rs`, `iroh`, `iroh-blobs`, `iroh-gossip`, `libtorrent`, `hyperswarm`, `hypercore`, `py-ipv8`,
`soulfind`. Where a claim comes from memory rather
than the code in front of me, it says so.

Who each idea is for is marked, because the two projects must stay apart:
**[wire]** belongs in swarmwire (moving verified bytes), **[fs]** belongs in SwarmFS (names,
spaces, permissions, search), **[both]** needs a hook in the first and a policy in the second.

---

## 1. IPFS Bitswap (`boxo/bitswap`)

The closest relative to what swarmwire does: ask peers for blocks by hash.

**Messages, not request/response.** Every message carries a wantlist and/or blocks. A peer says
*want-have* (do you have it?) or *want-block* (send it). The answer is *HAVE*, *DONT_HAVE* or
the block. A cancel goes out when the block arrives from somewhere else.

**Small blocks skip a round trip.** `engine.go`: if a peer sends want-have and the block is below
`wantHaveReplaceSize`, the server sends the block itself instead of HAVE. Large blocks get HAVE
and the asker upgrades to want-block. **[wire]** We already have `have`/`want` per root; the
trick would apply to the last small group of a file, or a tiny file, saving one round trip.

**Sessions.** A session remembers which peers answered HAVE for blocks of *this* download and
asks only them first (`session/session.go`). Only when no block arrives for a while, or every
session peer says DONT_HAVE, does it *broadcast* want-have to all connected peers and search the
DHT for providers (`broadcast`, `handlePeriodicSearch`). The periodic search picks **one random
still-wanted block** and looks up its providers: cheap, and it covers the case where the first
providers do not hold everything. **[wire]** This is what our `Download` already does in spirit;
the random-want periodic lookup is a cleaner trigger than a fixed timer.

**Broadcast control** (`docs/broadcastcontrol.md`). Broadcasting every want to every connected
peer collapsed under load. Fix: send to non-local peers *only if they previously answered HAVE*;
optionally also to up to N random peers so a peer that gained the block later is not missed.
Measured by the authors on a production gateway: **80–98 % fewer broadcast messages, 50–95 %
less bandwidth**, same success rate. Local-network peers always get the broadcast. **[wire]**
Relevant the day swarmwire has more than a few dozen neighbours per root: ask peers that
reported holding something, plus a few random ones.

**Fairness on the serving side** (`decision/engine.go`, `scoreledger.go`):
- A peer-task queue picks whose turn is next with five layers: empty queue loses; starvation
  override; prefer the peer already being served (locality); cap on pending bytes; salted-hash
  tiebreak. Messages are packed to about **16 KiB** (`defaultTargetMessageSize`).
- Per-peer limits: max queued wantlist entries (new high-priority wants evict old low-priority
  ones), max CID size, **max outstanding bytes per peer** (soft backpressure).
- A byte ledger per peer feeds two moving averages, short term (alpha 0.5, sampled every 10 s)
  and long term (alpha 0.05, ten samples). The score only tags the connection so useful peers
  survive trimming; **it does not change ordering** in the default engine.
**[wire]** The uplink-limit and fair-turn logic is what our `bench/sim` models crudely. The
outstanding-bytes-per-peer limit is the cheap, real protection against one peer asking for
everything at once.

## 2. IPFS announcing (`boxo/provider`, `kubo/docs/config.md`)

This is exactly our DHT-cost problem, at 1000× the scale.

- **Reprovide interval 22 h** (`DefaultReproviderInterval`), against provider-record validity
  of about double that. Compare Hyperswarm: 10 min refresh, 20 min record life.
- **Legacy provider** announces each key with its own lookup (10–20 s each) and manages fewer
  than ~10,000 keys per 22 h. Exactly the wall we measured on the testnet.
- **Sweep provider** (kubo): split the DHT keyspace into regions of at least ~20 peers, visit one
  region at a time over the interval, find its peers *once*, then push **every record that
  belongs to those peers in one batch**. Lookups are bounded by the DHT size, not the number of
  keys: kubo's docs claim 97 % fewer lookups at 100,000 keys. **[wire]/[both]** Hyperswarm
  announces per topic. Batching announces by closest nodes is the one real fix for "thousands
  of topics", and it would live in Hyperswarm/HyperDHT, not here. Worth an issue or a
  prototype there before building anything of our own.
- **`Provide.Strategy`** — the most useful idea in this section. The node chooses *what is
  worth announcing*: `all`, `pinned`, `roots` (only the root of each pinned DAG), `mfs`
  (only the part the user's filesystem holds), combinations, plus `+unique` (bloom filter so
  shared sub-DAGs are announced once) and `+entities` (files and directories, not every
  chunk). Kubo's own warning on `roots`: an interrupted download cannot find providers for a
  block in the middle of a file, *unless it is already connected to a peer that has it*.
  **[both]** This is the "app decides what is published" model I proposed. swarmwire provides
  the mechanism (announce a root, announce a file in a folder); SwarmFS picks the strategy.
- Changing the strategy clears the provide queue, so stale content stops being announced.

## 3. Gnutella (`gtk-gnutella`) — search without a server

Gnutella flooded queries to everyone and died of it, then fixed it with three mechanisms. All
three are about *making a text search cheap*, which is SwarmFS's problem if it wants search
across spaces, not swarmwire's.

**Ultrapeers and leaves.** Well-connected nodes become ultrapeers and hold the connections of
many leaves; leaves send queries only to their ultrapeers.

**QRP, the Query Routing Protocol** (`core/qrp.c`). Every leaf sends its ultrapeer a
**Bloom-style table of hashed keywords** from its filenames. The ultrapeer forwards a query to a
leaf only if the leaf's table says it might match. Details in the code:
- Table size 2^14 to 2^21 slots (16 KB to 2 MB); inter-ultrapeer tables up to 128 K slots.
- A table is rejected if more than 20 % of insertions conflicted, and "sparse" means at most
  1 % of slots used.
- A query with more than 2 words matches if **2/3 of the words** hit (LimeWire's rule, adopted
  by GTKG in 2014); a query with 1–2 words needs all.
- Tables are sent as **patches** (`qrt_patch_*`, compressed) so a change costs bytes, not 2 MB.
**[fs]** A Hypergraph member who wants to search *other spaces* could exchange small keyword
tables instead of full file lists. 1 M files at ~100 B each is ~100 MB as a list; a 2 MB table
answers "might they have it" for the same corpus with false positives and no names.

**Dynamic querying** (`core/dq.c`). Instead of flooding with a high TTL, the ultrapeer queries
**3 ultrapeers first** (`DQ_PROBE_UP`), estimates how popular the keyword is from the hit
count, and widens only while results are scarce. It stops at a result target, a horizon
(`DQ_MAX_HORIZON` 500,000 nodes), or **10 minutes**. Between queries it waits 1.5–3.7 s, scaled
by connection count. Popular terms stop after a handful of nodes; rare ones go wide. Hash
queries (SHA-1) expect ~25× fewer hits (`DQ_SHA1_DECIMATOR`), so they use a lower target.
**[fs]** "Ask a few, learn how common it is, widen only if rare" is the right shape for any
search over many spaces, and it is the same idea as the lookup-first announce rule.

**Download mesh** (`core/dmesh.c`). Every downloader keeps, per file hash, a list of other
sources it has heard about: up to **256 entries per SHA-1**, entries expire after **12 hours**
(**1 hour** for files you are sharing/seeding), peers can be banned after **3** bad reports, and
firewalled sources are stored with up to **4 push proxies**. Sources are exchanged *inside the
HTTP transfer headers* (`X-Alt`, `X-Nalt`), so you learn new holders from the peer you are
already downloading from, with no DHT. **[wire]** This is peer exchange (PEX). It is the
cheapest answer to ">64 peers": the app keeps a list of holders per root and dials them, which
is also what `roadmap.md` calls hints. Worth designing the hint message after this one.

**THEX** (`core/thex_download.c`). Before downloading, fetch the file's Tiger tree hash
(a Merkle tree) over HTTP, so each piece can be verified. Same job our bao outboard does; ours
is strictly better (one root, streaming proofs). Nothing to take, only a reminder that
verification-before-trust has been needed since 2005.

## 4. Tribler — search by gossip, no server (`tribler/src/tribler/core/content_discovery`)

~1000 lines, readable in an hour. Built on IPv8 (its own overlay).

- **Gossip of what is alive.** Every **5 s**, send **10 randomly chosen** torrent-health records
  to one random peer, and more to up to 5 more (`random_torrent_interval`,
  `random_torrent_count`). A peer can also ask for the *most popular* records (largest
  `seeders + leechers`, `heapq.nlargest`). So every node accumulates a bounded, slowly
  refreshed picture of what exists and is healthy.
- **Search = ask 20 random peers.** `send_search_request` samples up to **`max_query_peers` =
  20** peers from those it knows and sends each the same query; each answers from its *local
  database* and replies with at most **100 entries** (`max_response_size`), packed to **1300
  bytes** per datagram. Results stream into the UI as they arrive. There is no routing: a rare
  item is found only if one of the 20 happens to have it, which is why their gossip matters.
- Defences: queries are sanitised and capped (`sanitize_query(cap=100)`, "to prevent DDOS-like
  attacks"), and rate-limited per query shape.
**[fs]** This is the lightest possible cross-space search and the honest baseline: no server, no
tree, results from a few random peers, popularity gossiped. It works for "what is popular",
badly for "find this rare thing". Combine with the keyword tables above for rare items.

## 5. Soulseek (`nicotine-plus`, `soulseek-rs`)

Covered in conversation; the details worth keeping:

- **Search index is a word → file-list map** (`nicotine-plus/pynicotine/search.py`). A query is
  split into words; each word's file list is **intersected**, starting with the first;
  excluded words (`-word`) are removed; partial words (`*word`, suffix only) scan the
  vocabulary. At least one **whole** word is required. A one-word query is cut to `max_results`
  before intersecting so "flac" cannot blow up memory. Results are skipped for users who are
  banned, below `min_search_chars`, or when the user disabled results. **[fs]** For an in-space
  search over Hypergraph-replicated names this is exactly what to build locally: ~100 lines.
- **Wishlist**: saved searches re-run on an interval the server dictates
  (`set-wishlist-interval`), one at a time (`_do_next_wishlist_search`). A cheap way to turn a
  one-off search into "tell me when it appears". **[fs]**
- **Upload slots and queue** (`uploads.py`): a **slot limit** or a **bandwidth limit**
  (choose one), a **per-user queue limit in files and in megabytes** (`TOO_MANY_FILES`,
  `TOO_MANY_MEGABYTES`), privileged users go first, and the downloader can ask its **place in
  queue**. Rejections carry a *reason code*, so the other side can tell "queue full" from "file
  not shared". **[wire]** swarmwire's `reject` already exists; typed reasons and a queue
  position would let a downloader choose between waiting here and trying another peer.
- Servers are central (logins, brokering), search is a tree, and identity is path+size, no hash.
  Nothing to copy there; see the previous conversation.

## 6. iroh (`iroh/`, core repo only)

Same job as Hyperswarm's connection side, in Rust/QUIC. I read file names and a few headers, not
the connection logic, so treat this as a map for later.

- **Address lookup is pluggable** (`iroh/src/address_lookup/`: `dns`, `pkarr`, `memory`): given a
  public key, find how to reach it. Pkarr records are **signed DNS packets**:
  `<32 pubkey><64 sig><8 timestamp><DNS packet ≤1000 B>`, so a record cannot be forged and a
  newer one replaces an older. **[both]** The idea of "who is where" being a signed, replaceable
  record is what a Hypergraph member list could hold for peers.
- **Relay as a backup path** (`socket/biased_rtt_path_selector.rs`): paths are *primary* (direct)
  or *backup* (relay). Direct wins whenever it exists; among direct paths the lowest RTT wins,
  with **stickiness** so it does not flap; IPv6 gets a small bias. A relay is used only when no
  direct path exists. **[wire]** Hyperswarm has no relay, so a failed holepunch is simply no
  connection. If SwarmFS users hit that, this is the design to read first.
- **Custom transports by numeric id** (`TRANSPORTS.md`), including Tor and Bluetooth reserved.
- Not read: holepunching and the relay server. `iroh-blobs` and `iroh-gossip` are next.

## 7. iroh-blobs — the closest relative (`iroh-blobs/`)

Same foundation as swarmwire: BLAKE3, bao, **16 KiB chunk groups** (16 BLAKE3 chunks, the same
granularity as our default group). Its authors' stated goals read like ours: integrity over
speed ("the requester will notice after at most 16 KiB"), no size limit, cheap range requests
(worst-case overhead about two groups per range), cheap tiny blobs.

- **Discovery is explicitly a non-goal and is a trait.** `protocol.rs`: "Do not support
  discovery... you have to have some out-of-band knowledge about what node has data".
  `downloader.rs`: `trait ContentDiscovery { fn find_providers(hash) -> Stream<EndpointId> }`,
  with a plain list and a `Shuffled` list as the provided implementations. **[wire]** This is
  the "pluggable discovery" shape I recommended, written by people with the same constraints.
  A stream rather than a callback means the downloader can start with the first provider while
  more are still being found.
- **Provider fallback keeps progress.** `execute_get` tries providers in order, and a new
  provider is asked only for what earlier ones did not deliver ("if the first had 10 %, ask
  the next for the remaining 90 %"). Strictly one request in flight in that mode.
- **Folders (collections) are a hash sequence plus parallel split.** `SplitStrategy::Split`
  downloads the sequence blob first (its size is `32 × n`), then fires one request per child
  hash in parallel, rather than one long stream. Range requests are per child:
  `ChunkRangesSeq` = "for blob i, these chunk ranges". **[wire]** Our collections download
  files with a bounded pool already; their range-sequence type is a tidy way to say "groups
  3–10 of file 2" and would be the wire form of partial/streaming reads for SwarmFS.
- **Typed server-side hooks** (`provider/events.rs`): per request kind (get, get-many, push,
  observe) a mode of *none / notify / intercept-and-reject / +transfer events*, plus a
  `throttle` hook, with rejection reasons `Permission` and `LimitExceeded` ("OK to try again
  later"). Push is **disabled by default** because it writes to the store. **[both]** This is
  the admission callback SwarmFS needs, shaped as an event mask so an app pays only for what it
  listens to. Copy the two rejection reasons: "no, never" and "not now" are different answers
  for a downloader.
- **Store design** (`DESIGN.md`, worth reading in full): data and outboard kept apart so a
  complete file stays a plain file; **small blobs inline in a database, big ones as files**
  (threshold 16 KiB) because a directory of millions of tiny files is slow and creating file
  metadata dominates; an in-flight download is **held in memory until the size is known**, so a
  peer lying about size makes no work for you; "the secret to fast download speeds is to not
  touch the metadata database at all"; and a chunk can only go from absent to present, so
  **concurrent downloads from several sources commute**. Deletion is whole-blob, protected by
  temporary tags (process lifetime), persistent tags, or a hash-sequence tag covering a folder.
  **[wire]/[fs]** Our `Destination`/`NodeStore` split is the same idea; the lying-size and
  commuting-writes notes are the invariants to test ours against.
- Overlap with our own work: their `get.rs` is ~1000 lines for what our `Download` does; ours is
  smaller because we do not do QUIC streams per request, and weaker because we have no range
  requests.

## 8. iroh-gossip — swarm membership and broadcast (`iroh-gossip/`)

Not file transfer: a small overlay per *topic* that spreads messages to everyone in it. Built on
two papers, **HyParView** (who is connected to whom) and **Plumtree** (how messages travel).

- **HyParView** keeps two views per topic: an **active view of 5** peers you hold connections
  to, and a **passive view of 30** you only remember (`Config::default`, "from the paper").
  Join: contact one peer; it forwards a `ForwardJoin` on a random walk (TTL 6, added to others'
  passive views at TTL 3). A **shuffle** every 60 s (3 active + 4 passive entries, walk TTL 6)
  keeps the passive view a live random sample. A dead active peer is replaced from the passive
  view; refill checks run every 5 s; an isolated node rejoins at passes 1, 2, 4, 8 then every
  12th. Failure of a connection, not a timeout, triggers repair.
- **Plumtree** puts a spanning tree on top: send the full message to *eager* neighbours and
  only an id to *lazy* ones; if a lazy neighbour's id arrives and the message does not within
  a timeout, promote that link to eager and prune the redundant one. Cost: roughly one copy per
  node plus ids, instead of one per edge.
- It ships a **simulator** (`src/proto/sim.rs`, `bin/sim.rs`, `tests/paper.rs`) that reproduces
  the papers' graphs, and the protocol is a pure state machine with no I/O (`proto/`) and a
  thin network layer (`net.rs`). **[wire]** Both are habits to copy: our `bench/sim` and the
  separation of logic from sockets.
- **What it could be for us** **[fs]**: SwarmFS needs members to learn "who now holds hash H".
  Hypergraph already replicates that as data. A gossip topic per space would only matter for
  *ephemeral* facts (who is online, who is seeding right now) that should not be written into
  the CRDT forever. Active view 5 is also a strong argument against our 64 neighbours *for
  control traffic*; bulk transfer needs more links, announcements do not.

## 9. libtorrent — the reference BitTorrent implementation (`libtorrent/`)

I had been working from memory of BitTorrent; this is the code.

- **Piece picking** (`src/piece_picker.cpp`, ~4000 lines). Options combine: `rarest_first`,
  `sequential`, `prioritize_partials` (finish pieces already started before opening new ones,
  so few half-done pieces exist), `suggested_pieces`, and **`piece_extent_affinity`**: prefer
  pieces inside a recently used **4 MiB extent** so the file on disk is written in fewer
  fragments. When rarest-first is *not* in use, the starting piece is **random**
  (`start_piece = random(...)`), which is the prior art for our random first group.
  **[wire]** `prioritize_partials` is the one we do not have: with several peers, finish
  groups already begun.
- **Streaming** (`docs/streaming.rst`). Plain `sequential_download` fills request queues in
  order but may ask a slow peer for piece 0. The time-critical mode instead ranks peers by
  **estimated download queue time** (`outstanding_bytes / estimated rate`), **drops the slowest
  10 %**, and for the soonest-deadline piece picks the peer with the lowest queue time, stopping
  when even the best queue is over **2 s**. Run once a second. **[both]** This is the design for
  SwarmFS playing a video while it downloads; swarmwire would expose "deadline per group", not
  the player.
- **Choking** (`src/choker.cpp`). Slots are given by: bytes the peer sent us (tit-for-tat) while
  leeching; while *seeding*, a **round-robin** that keeps unchoked peers unless they have taken
  more than one quota since being unchoked and held the slot at least a minute, then the
  longest-waiting peer goes next. There is also an *anti-leech* ranking from Chow et al.
  ("Improving BitTorrent: a simple approach"): score is high for peers with **few pieces** (just
  started) and **nearly all** (about to finish), low in the middle. **[wire]** A seeder with
  limited upload and many leechers needs a rule like this; today we answer whoever asks.
- **Peer exchange** (`src/ut_pex.cpp`). Every **minute** each connection sends the peers
  *added* and *dropped* since the last message, with a flag byte (`0x02` = is a seed, `0x04` =
  supports uTP). A cap (`max_pex_peers`) bounds what is accepted and a cap on entries bounds the
  packet. The seed flag lets a downloader skip seeds that cannot want anything from it.
  **[wire]** Same job as Gnutella's mesh, in a tidier form: send diffs, flag seeds.
- **Snubbing and parole**: peers that stop delivering are "snubbed" and excluded; peers that
  sent bad data are "on parole" and only get pieces nobody else is fetching. Cheap and effective
  against a peer that sends corrupt data once. **[wire]**
- Not read: the DHT, uTP, hybrid v1/v2 torrents (BEP 52 uses per-file merkle trees, close to our
  per-file bao roots), the web seed code.

## 10. Hyperswarm — what our connections actually do (`hyperswarm/`)

Read to explain behaviour we measured, not to copy.

- **Refresh every 10 min + up to 2 min of random jitter**; if a laptop sleeps past the delay
  plus 30 s it refreshes eagerly (`peer-discovery.js`). A lookup result is remembered up to **64**
  peers; `limit` stops dialing once enough are connected.
- **Dial retry ladder** (`retry-timer.js`, `peer-info.js`). Failed peers retry after about
  **1 s**, **5 s**, **15 s**, then **10 minutes** (each with jitter), and only *explicit* peers
  ever reach the 10-minute rung; others are dropped after 4 attempts. A peer that has never
  connected (`proven = false`) skips the 1 s rung and waits **5 s** for its first retry.
  A connection that lasted at least 15 s resets the counter.
  **This probably explains the ~6 s (sometimes 13 s) first-contact delay** I saw in the CLI
  tests: the first dial fails (server not yet visible, or a lookup that raced the announce), and
  the retry is 5 s plus jitter. Plausible, not proven; a test that logs dial attempts would
  settle it.
- Priority by attempts: 1 attempt = very high, 2 = high, 0 = normal, 3 = low, stale = very low.
  So a peer that failed once is retried before brand-new ones.
- Defaults: `maxPeers` 64, `maxParallel` 3 dials at once.

## 11. Hypercore — sparse replication of a log (`hypercore/lib/replicator.js`)

Different data model (an append-only log of blocks, not hashes), same problem of getting verified
pieces from several peers. Worth reading because SwarmFS lives on it.

- **Per-peer bitfield** (`remote-bitfield.js`): each peer tells which blocks it has; requests go
  only to peers with the block. Equivalent to our `have`.
- **Request pipelining scales with latency**: in-flight window per peer is between **16 and
  512** blocks, grown by `rtt / 50 ms`, reduced when many peers share the work
  (`getMaxInflight`). Over a non-UDP stream it is capped at 3× the minimum. **[wire]** Our
  window per connection: is it fixed? A latency-scaled window is a likely win on long links and
  is cheap to add.
- **Hotswap** (`hotswap-queue.js`): a block already in flight to one peer may be **requested
  again from a different peer** (at most 3 copies; blocks with fewer copies come first, picked
  randomly within a tier), so one slow peer cannot hold up the tail. This is endgame mode, done
  continuously and bounded. **[wire]** Earlier we decided against endgame because the
  simulation showed no gain; hotswap is the version that does not wait for "the last few
  blocks", and is the thing to simulate if we revisit it.
- **Priorities** (`NORMAL`, `HIGH`, `VERY_HIGH`) per range request, up to **64 ranges** wanted
  at once. A reader asking for a block now outranks a background download.
  **[both]** This is what SwarmFS needs for "open this file now while the rest syncs".
- **Abuse limits**: after **64** invalid requests from a peer it is disconnected, with backoff
  after 32. Same shape as Bitswap's per-peer limits.

## 12. IPv8 (`py-ipv8`) — how peers find each other without a server

- Discovery strategies are objects with a `take_step()` called on a timer. **RandomWalk**: at
  each step pick a random known peer and ask it to introduce another; at most **5**
  unanswered introductions in flight; unreachable after **3 s**; with some chance
  (`reset_chance`, 50/255) go back to the tracker so a walk cannot get stuck among dead peers.
  **EdgeWalk**: depth-first from your neighbourhood (size 6, edge length 4), then teleport home.
- Peers are introduced *by other peers*, so nobody has to run anything but a few bootstrap
  addresses. This is the machinery under Tribler's "ask 20 random peers" search (section 4).
  **[fs]** If SwarmFS ever wants peer discovery that does not depend on the DHT, this is the
  smallest design; it also gives a natural place for the introduction to carry the space id.

## 13. Soulfind — what the Soulseek server really is (`soulfind/`)

A correction to my earlier answer. This open server (~9,500 lines of D) does **not** build the
distributed search tree ("Distributed network, unused in Soulfind" in `msghandler.d`). It does
the dumb thing: a search is queued, and every **650 ms** the queue is flushed and each query is
sent **to every connected user** (`send_to_all`), or to one user, or to one room. Limits: query
length 256, users can opt out of being searched, queries can be filtered server-side, wishlist
searches repeat every **12 min** (2 min for privileged users). So the "tree" belongs to the
official server; a small community server gets by with a flat batched broadcast, which says how
far a plain broadcast goes when the user count is in the thousands. **[fs]** Batching outgoing
searches into one flush per interval is a free 10x on message count under load.

---

## What this means, by project

**swarmwire (bytes only)** — the ideas that fit, in the order I would try them (items 6–9 come
from libtorrent and Hypercore):
0. Make discovery a stream-returning plug-in (iroh-blobs `ContentDiscovery`), with hash topics
   as the default implementation and "none, the app gives me peers" as another.
1. A holder list per root that the app can feed and read (the dmesh/PEX idea, `have` from peers
   plus app-supplied hints). Fixes ">64 peers" without any new discovery.
2. Per-peer outstanding-bytes cap and typed reject reasons with a queue position.
3. Broadcast control: ask peers that said they hold something, plus a few random ones.
4. Skip the round trip for tiny last groups (want-have answered with data).
5. Make announcing optional and strategy-driven (Kubo's `Provide.Strategy`) instead of fixed.
6. Bounded hotswap: re-request a group already in flight from one more peer, up to 3 copies
   (Hypercore). Simulate it before building it.
7. `prioritize_partials`: finish groups already started before opening new ones (libtorrent).
8. Latency-scaled request window per connection (Hypercore).
9. Seed-side slot rotation and a "snub / parole" rule for peers that send bad data.

**SwarmFS (names and search)**:
1. In-space search is a local word index over replicated names (Nicotine+'s intersection).
2. Cross-space search starts with Tribler's "ask ~20 random peers, they answer from their local
   index, gossip what is popular", and adds Gnutella keyword tables or dynamic querying only if
   rare items matter.
3. Public hash discovery should be a *chosen* set of published files (Kubo strategy), not every
   file.

**Not worth it for either:** a Soulseek-style central server or distributed tree, Gnutella
flooding, Bitswap's per-block protocol (we move groups, not blocks), content-addressed names.

## Not checked

Everything above comes from reading code and docs, not running anything. I did not verify the
Tribler or iroh behaviour at runtime, did not read iroh's holepunching or relay server, the
Bitswap session want-sender, libtorrent's DHT/uTP/v2 code, Hyperswarm's holepunching (in
hyperdht, not cloned), Hypercore's merkle and request-cancel paths, Tribler's IPv8 community
code, iroh-blobs' store code beyond `DESIGN.md`,
or the Plumtree message handling (only its README and the HyParView defaults). The 1000× scale comparison to IPFS is
arithmetic on its documented numbers, not a measurement.
