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

### M1 — One file, one link

Hash on demand (cached by path + size + mtime), announce on the root's topic, serve ranges in
place, write to the destination with a sidecar holding the verified-range bitfield.

**Done when:** a multi-gigabyte file moves between two machines, no copy of it exists anywhere,
and a transfer killed halfway resumes without rehashing what it already has.

### M2 — Swarm

Partial seeders (you serve what you have, mid-download), pipelined block requests with a
per-peer queue sized from measured throughput, rarest-first selection, and dropping peers whose
ranges fail verification.

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
