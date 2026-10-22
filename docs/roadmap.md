# Roadmap

## Long-term vision

A small, boring, dependable layer that any P2P app can embed to move bulk bytes:

> You hold a 32-byte address. swarmwire gets you the bytes it names, verified, from whoever
> has them, without copying anything into a store first.

That is the whole contract. It should be as uninteresting to use as `fetch`, and it should hold
up when the original sender is offline, when half the peers are slow, and when one of them lies.

Consumers in this ecosystem: **SwarmFS** (virtual filesystem, multi-writer directories through
hypergraph), **HyperBBS** (attachments and media in hypersites), and anything else that ends up
needing bulk transfer without a server.

## Short-term vision

Two commands that work and feel instant:

```
swarmwire send <path>     # prints a link, serves the file in place
swarmwire get <link>      # downloads it, resumable, from every peer that has it
```

No `add` step, no topic to join, no daemon required, no copy of the file anywhere.

## Where this stands (2026-10-22)

- **Good enough for a command-line tool**: `swarmwire-cli` sends and fetches a file or folder by
  link, over a real swarm, and keeps seeding.
- **Not yet the layer SwarmFS needs.** What is missing is listed under "Next" and "M4" below:
  an admission decision (which peer may fetch which root), peer hints (an application telling
  swarmwire who holds what), a way to switch off swarmwire's own public discovery, and
  priority or range reads for a filesystem. Nothing was built for these because the SwarmFS side
  (hypergraph) is being rewritten; read it first, then build from what it needs.
- **Unmerged branch `file-topics`**: a big file inside a folder is also announced and looked up
  on its own topic (`fileTopicMin`, at most 64). It works and is measured
  (`docs/discovery.md` on that branch), but it makes the library join public hash topics, which
  SwarmFS may not want. Decide after the admission and discovery questions are settled.
- **Not built, with numbers**: endgame, super-seeding, hotswap ([scaling.md](scaling.md)); a
  persistent hash cache (every `send` rehashes, about 70 MB/s); a fast BLAKE3.
- **Observed, not explained**: a first contact sometimes takes 6 to 13 s. Hyperswarm retries a
  never-connected peer after about 5 s, which is the likely cause
  ([research](research/p2p-landscape.md), section 10).
- **Ideas from other systems**, with who each belongs to: [research/p2p-landscape.md](research/p2p-landscape.md).

## Milestones

### M0 — Foundations ✅

Repo, licence, CI, agent docs. Addressing settled and pinned by tests: BLAKE3 roots, link
syntax, topic derivation. A deterministic multi-peer test harness before any engine code.

**Done:** addressing vectors pass, and `test/helpers/network.js` runs any number of peers over
an in-memory transport with no real network, no timers, and fault injection for the cases that
matter (latency, loss, partition, a lying peer, a peer that vanishes). Real protomux channels
run over it, so the engine can be written against the same mux it will use in production.

### M1 — One file, one link ✅

Hash on demand (cached by path + size + mtime), announce on the root's topic, serve ranges in
place, write to the destination with a sidecar holding the verified-range bitfield.

**Done:** `swarmwire send` prints a link and serves the file where it lies; `swarmwire get`
takes that link and nothing else. Proven in `test/swarm` against the deterministic harness
(including a liar and a seeder pulled mid-transfer) and in `test/net` against a real Hyperswarm
on a private DHT, CLI processes included.

**Known gaps, deliberately left for M2:**

- **No request timeouts.** A peer that accepts a request and never answers stalls that group
  until it disconnects. Harmless in the harness, not acceptable on a real network.
- **No partial seeding.** A downloader cannot serve what it has yet: proving a group needs the
  sibling hashes, which it does not keep. Recording each group's hash as it arrives would fix
  this, and the sidecar is the place for them.
- Scheduling is first-missing-first, not rarest-first, with a fixed window of 8.
- Hashing is cached in memory only, so a restarted process rehashes what it serves.

### M2 — Swarm *(in progress)*

Partial seeders (you serve what you have, mid-download), pipelined block requests with a
per-peer queue sized from measured throughput, rarest-first selection, and dropping peers whose
ranges fail verification.

**Done so far:**

- **Request timeouts.** A peer that goes quiet loses the group after a timeout and stops being
  asked after three; answering earns its place back. Time is injected, so the tests wind a
  clock rather than sleeping.
- **Refusals.** A peer that cannot serve a group says so, instead of leaving it reserved until
  a timeout. This alone was the difference between a stalled relay and a working one.
- **Partial seeding.** A download in progress serves what it holds, and a finished one keeps
  serving without re-reading the file. Verifying a group now also keeps the proof that came
  with it, which is what makes the group provable to the next peer — without that, a peer
  holding the first third of a file can prove none of it.
- **Content outliving its sender**, proved in `test/swarm/partial.test.js`: the origin is
  destroyed, and a newcomer still gets the file from the peer that had downloaded it.

- **Rarest-first selection**, so a group only one peer holds is fetched before one everybody
  has. It is about the swarm surviving, not this download finishing: a group whose only copy
  is on one machine disappears when that machine does.
- **Benchmarks** (`npm run bench`, `npm run bench:net`). Current numbers on one machine:

  | measure | value |
  |---|---|
  | wasted requests | 0 of 512, and 10 extra when a dud peer joins |
  | proof overhead | 1.76% of content bytes at 16 KiB groups |
  | rounds, 8 MiB | 166 with one seeder, 42 with two |
  | throughput | ~13 MiB/s over loopback, one seeder |
  | hashing | ~68 MiB/s, pure JavaScript BLAKE3 |

- **An adaptive request window.** The harness now models bandwidth as well as latency, which
  is what made this measurable: a link carries a frame while it transmits it, so a shallow
  window leaves the wire idle during the round trip. Keeping a link busy needs roughly
  `(2 x latency x bandwidth) / group size` requests outstanding — about 20 groups for a
  nearby link and 1600 for a fast distant one, so no fixed number can be right.

  The window now starts at 32 per peer, grows by one each time an answer arrives while the
  window (rather than the link) was the constraint, and halves on a refusal or timeout:
  additive increase, multiplicative decrease, for the same reason congestion control uses it.

  Measured on a distant link, against the best fixed window chosen with hindsight:

  | window | far and slow | far and fast |
  |---|---|---|
  | 16 (the old fixed value) | 4.9x worse | 7.4x worse |
  | adaptive | 1.9x worse | 2.1x worse |
  | adaptive, on a transfer bigger than the pipe | 1.25x worse | — |

  The remaining gap is the ramp: a window that starts small spends a few round trips getting
  big, and on a 4 MiB transfer against a pipe that holds 25 MiB there is nothing to ramp
  into. Closing it properly means estimating bandwidth and round-trip time and jumping
  straight to the answer, which **the harness cannot currently validate**: its logical time
  and the injected clock are separate, so a timing-based estimate would measure nothing real.
  That is the next piece of work here, and it needs the harness changed first.

**Done:** the benchmark shows large gains with several peers, and killing the original sender
mid-transfer still completes the download from a peer that only has part of it.

### M3 — Collections ✅

A minimal immutable manifest so a folder is one link. Deliberately dumb: a list of
`(relative path, root, size)`, itself content-addressed. Mutation stays upstairs in SwarmFS.

**Done:** `swarmwire send ./folder` prints one link and `swarmwire get <link> ./out` rebuilds
the folder, proved between two CLI processes over a real swarm. The manifest is served from
memory, so sharing a folder does not add a file to it, and only the manifest's root is
announced — a thousand files still cost one announce. Per-file resume comes free, since each
file is an ordinary transfer.

Paths out of a manifest are validated rather than repaired: absolute paths, `..`, drive
letters, control characters, duplicates and non-canonical spellings are all refused. A folder
packed on Windows has the same address as the same folder packed on Linux.

### Contract and first publication ✅

[contract.md](contract.md) is what applications can rely on, supply and must not expect, and a
unit test fails if its export list drifts. The library publishes as `swarmwire-lib` (the CLI
will be `swarmwire-cli`; `swarmwire` itself belongs to an unrelated project), version 0.1.0,
containing only `index.js`, `lib/` and the format and contract documents. See
[releasing.md](releasing.md). Specified in `specs/001-swarmfs-contract-publish-prep/`.

### Next: what the contract marks as planned

Specified next, in this order, each as its own feature under `specs/`:

1. ✅ (0.2.0) Peer activity events and counts (direct connections only), and a public reader
   for a folder's file list, so an application can take part of a folder.
2. Admission decisions (per peer, per content root, deny on failure, a refusal looks like
   "not held") and peer hints (which connected peers to ask first).
3. ✅ (0.3.0) Random selection: random window and random ties, so a
   thousand fresh downloaders do not all ask for the same groups.
4. ✅ (0.3.0) A simulation of large swarms (`npm run bench:sim`); endgame mode and both kinds of
   super-seeding did not clear the bar. See [scaling.md](scaling.md).
5. ✅ The CLI left for its own repository, `swarmwire-cli`.

### M4 — Handover to SwarmFS

SwarmFS rebuilt as the layer above: directories in hypergraph, bytes through swarmwire.

**What hypergraph actually provides today** (checked 2026-10-03 against the repo, not
assumed):

- **External content references** — `graph.putContentRef()` stores an entity whose content is
  an *address* held elsewhere: `{src: [...], size, type, mutable, digest: "blake3:…"}`, specced
  in its `specs/001-external-content-refs/`. It validates the envelope and deliberately never
  interprets a scheme, "which is what lets new backends arrive without a change". This is
  precisely the split swarmwire was built for, and the digest format is already ours.
- **Multi-writer contexts** (`createContext`, Autobase underneath) — what a shared directory
  needs.
- **Roles, permissions and moderation** (`createRoleBase`, `setRole`, `can`, `moderateAction`).
- **Identity** with multi-device support and mnemonic recovery.
- **Networking** (`connectToSwarm`, `handlePeerConnection`, bootstrap export).

So the features SwarmFS was paused for exist. Known rough edges to design around: replication
is manual (`update()` has to be called; nothing polls), the bootstrap/export API is split in
two, and there is no way to prune a single context.

**One decision before building:** hypergraph's examples write `swarmfs://…` in `src`. A
swarmwire root is not a filesystem path, so the address that belongs in a content reference is
`swarmwire://<root>`; `swarmfs://` should mean a *name* in the virtual filesystem, which is
mutable and resolves to different content over time. Worth settling before links are stored in
anyone's graph.

## Non-goals

- BitTorrent network compatibility
- Global content routing (no DHT crawl for "who has this?" beyond the root's own topic)
- Live/append-only streams — that is hypercore's job
- Being a storage engine, cache, or filesystem
