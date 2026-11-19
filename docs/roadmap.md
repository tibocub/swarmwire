# Roadmap

## Aim

A small, dependable layer any P2P application can embed to move bulk bytes:

> You hold a 32-byte address. swarmwire gets you the bytes it names, verified, from whoever
> has them, without copying anything into a store first.

It should hold up when the original sender is offline, when half the peers are slow, and when
one of them lies. Users in this ecosystem: SwarmFS, `swarmwire-cli`, HyperBrowser, and the
Android app.

## Where it stands

Pre-alpha, published as `swarmwire-lib` 0.x. What works is in the capability table of
[contract.md](contract.md); what changed per release is in [CHANGELOG.md](../CHANGELOG.md).

- Files and folders transfer by link over a real swarm, with resume, verification of every
  group, request timeouts, partial seeding, rarest-first selection and an adaptive request window.
- It can serve SwarmFS on demand (`resolve`, `allowed`, no announce of its own when the
  application owns the connections).
- Behaviour with very many peers is modelled ([scaling.md](scaling.md)), not measured on a
  real swarm.

## Next

- **Admission and peer hints** (planned in the contract as feature 006): a per-peer, per-root
  decision that denies on failure and looks like "not held", and a way for the application to
  say which connected peers to ask first.
- **One-to-one speed.** The scheduler was built for flash crowds; a single seeder to a single
  downloader runs at about 1–16 MB/s. A sequential, bulk mode for that case (in the spirit of
  hyperbeam) is the obvious candidate. Also worth measuring: bigger groups, compression, and
  cheaper encodings.
- **Bandwidth and RTT estimates** so the window jumps to the right size instead of ramping.
  The test network needs its logical time joined to the injected clock first.
- **Not built, with numbers in [scaling.md](scaling.md):** endgame, super-seeding, hotswap.
  Also not built: a persistent hash cache (a restarted process rehashes what it serves, about
  70 MB/s) and a faster BLAKE3.
- **Observed, not explained:** a first contact sometimes takes 6–13 s. Hyperswarm retries a
  never-connected peer after about 5 s, which is the likely cause
  ([research](research/p2p-landscape.md), section 10).
- **Unmerged branch `file-topics`:** a big file inside a folder is also announced on its own
  topic. It works, but makes the library join public hash topics, which SwarmFS may not want.

## Open question: swarmwire's role under SwarmFS

Serving a file by its hash means keeping a DHT record per file alive, and re-announcing one
record per file does not scale to everything a device holds. Two directions:

1. swarmwire as the transport behind links and QR codes (`swarmwire-cli`, the Android app,
   maybe a desktop app), and SwarmFS using something else.
2. SwarmFS keeps "who shares what" in each space's hypergraph and asks known peers for a root
   over connections it already has. A peer that is asked starts serving that file through
   swarmwire, which also makes it findable by its hash to people outside the space. A DHT
   lookup by hash (about 3–5 times cheaper than an announce) stays as a fallback for files no
   connected peer has.

On-demand serving (`resolve` with a network whose `join` does nothing) already supports the
second one.

## Handover to SwarmFS

SwarmFS is to be rebuilt as the layer above: directories in hypergraph, bytes through
swarmwire. Hypergraph already provides external content references (`putContentRef`, whose
digest format is a BLAKE3 hash like ours), multi-writer contexts, roles and permissions,
identity, and networking. Replication there is manual (`update()` has to be called).

One decision first: a stored content reference should be `swarmwire://<root>`. `swarmfs://`
should mean a *name* in the virtual filesystem, which is mutable.

## Non-goals

- BitTorrent network compatibility
- Global content routing beyond the root's own topic
- Live or append-only streams (that is hypercore's job)
- Being a storage engine, cache or filesystem
