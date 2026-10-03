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

**Still to do:** rarest-first selection, per-peer queue depth from measured throughput, and the
benchmark that says whether any of it helped.

**Done when:** the benchmark shows a measurable gain over M1 with several peers, and killing the
original sender mid-transfer still completes the download.

### M3 — Collections

A minimal immutable manifest so a folder is one link. Deliberately dumb: a list of
`(relative path, root, size)`, itself content-addressed. Mutation stays upstairs in SwarmFS.

**Done when:** a directory can be sent and received as a single link, with per-file resume.

### M4 — Handover to SwarmFS

SwarmFS rebuilt as the layer above: directories in hypergraph, bytes through swarmwire.

## Non-goals

- BitTorrent network compatibility
- Global content routing (no DHT crawl for "who has this?" beyond the root's own topic)
- Live/append-only streams — that is hypercore's job
- Being a storage engine, cache, or filesystem
