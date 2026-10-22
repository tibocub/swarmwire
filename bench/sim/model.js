/**
 * A swarm, modelled: who is connected to whom, who holds which groups, how much each peer can
 * upload per tick, and how far apart they are. Not bytes, not frames, not a DHT.
 *
 * Real nodes at this size are hours of work: a thousand peers with sixty-four neighbours each
 * is thousands of streams. The part under test is the choice of which group to ask for, and
 * that is `lib/select.js` itself, imported, not copied. What the model leaves out (framing,
 * proofs, disk, discovery, NAT, churn, shared links) is not measured here.
 *
 * Holdings are seen instantly (a `holds` costs no latency); requests, data and refusals each
 * take `latency` ticks. Download capacity is unlimited; the uplink is the constraint.
 */

import { Availability, candidates, rank, SCAN_LIMIT } from '../../lib/select.js'
import { xorshift } from '../../test/helpers/random.js'
import { STRATEGIES } from './strategies.js'

const MAX_PEERS = 20000
const WINDOW_MIN = 4
const REVEAL = 16 // a seeder first shows a neighbour 1/16 of the file

export const DEFAULTS = {
  peers: 1000, // downloaders; seeders are extra
  seeders: 1,
  neighbours: 64,
  uplink: 1, // groups per tick, downloaders
  seederUplink: 4,
  latency: 4,
  groups: 512,
  window: 4, // per neighbour: the library's floor, where its adaptive window settles when each neighbour gets a small share of the uplink
  slow: 0, // share of downloaders whose uplink is slowed
  slowEvery: 8, // a slow peer serves one tick in this many
  timeout: 256, // ticks before an unanswered request is given up on and asked of someone else
  seed: 1,
  strategy: 'random-ties'
}

export function simulate (options = {}) {
  const s = { ...DEFAULTS, ...options }
  if (s.peers + s.seeders > MAX_PEERS) throw new Error(`${s.peers + s.seeders} peers is more than the model will run (${MAX_PEERS})`)

  const strategy = typeof s.strategy === 'string' ? STRATEGIES[s.strategy] : s.strategy
  if (!strategy) throw new Error('unknown strategy ' + s.strategy)

  const G = s.groups
  const random = xorshift(s.seed)
  const peers = build(s, random)
  const downloaders = peers.filter((p) => !p.seed)

  const bucket = new Map() // tick → events due then
  const at = (tick, event) => {
    if (!bucket.has(tick)) bucket.set(tick, [])
    bucket.get(tick).push(event)
  }

  const revealed = new Uint32Array(G) // how often each group has been shown to someone
  const stats = { wasted: 0, seederUploads: 0, seederRepeats: 0, covered: new Set() }

  // -- what a peer may see of a neighbour -------------------------------------------------

  const offers = (p, n, g) => {
    if (n.has[g] === 0 || (p.deny.size > 0 && p.deny.has(n.id * G + g))) return false
    return !(n.seed && strategy.seeder === 'reveal') || n.shown.get(p.id)[g] === 1
  }

  const show = (seeder, p, g) => {
    seeder.shown.get(p.id)[g] = 1
    revealed[g]++
    p.availability.set(g)
    p.dirty.add(seeder.id)
  }

  const showMore = (seeder, p, k) => {
    const flags = seeder.shown.get(p.id)
    const open = []
    for (let g = 0; g < G; g++) if (!flags[g] && p.has[g] === 0) open.push(g)
    for (const g of rank(open, { at: (g) => revealed[g] }, random).slice(0, k)) show(seeder, p, g)
  }

  // -- the three things that happen to a peer ---------------------------------------------

  const acquire = (p, g) => {
    p.has[g] = 1
    p.count++

    for (const id of p.neighbours) {
      const m = peers[id]
      if (m.seed || m.doneAt !== null) continue
      m.availability.set(g)
      m.dirty.add(p.id)
    }

    if (strategy.seeder === 'reveal') {
      for (const id of p.neighbours) {
        const m = peers[id]
        if (m.seed && m.shown.get(p.id)[g]) showMore(m, p, 1)
      }
    }
  }

  /** Stop waiting for a request: true if it was still outstanding. */
  const release = (p, n, g) => {
    if (!p.inflight.get(n.id).delete(g)) return false

    p.out--
    p.wake = true
    p.claimed.set(g, p.claimed.get(g) - 1)
    if (p.claimed.get(g) === 0) p.claimed.delete(g)
    return true
  }

  const narrow = (p, n) => p.windows.set(n.id, Math.max(Math.floor((p.windows.get(n.id) ?? s.window) / 2), WINDOW_MIN))

  const onData = (t, p, n, g) => {
    const saturated = p.inflight.get(n.id).size >= (p.windows.get(n.id) ?? s.window)
    release(p, n, g) // a late answer finds nothing to release, and still counts

    if (p.has[g] === 1) {
      stats.wasted++
    } else {
      acquire(p, g)
      lastGain = t
      if (p.count === G) p.doneAt = t
    }

    if (saturated) p.windows.set(n.id, Math.min((p.windows.get(n.id) ?? s.window) + 1, s.window))
    p.dirty.add(n.id)
  }

  const onReject = (p, n, g) => {
    release(p, n, g)
    stats.wasted++
    narrow(p, n)
    p.deny.add(n.id * G + g)
    p.availability.unset(g)
    p.dirty.add(n.id)
  }

  const onTimeout = (p, n, g) => {
    if (release(p, n, g)) narrow(p, n)
  }

  // -- serving ---------------------------------------------------------------------------

  const serve = (t, n) => {
    if (n.slow && t % s.slowEvery !== 0) return
    for (let k = n.seed ? s.seederUplink : s.uplink; k > 0 && n.queue.length > 0; k--) {
      const { from, g } = n.queue.shift()
      const p = peers[from]

      if (n.seed) {
        if (strategy.seeder === 'reject' && overServed(n, g)) {
          at(t + s.latency, { type: 'reject', p, n, g })
          continue
        }
        stats.seederUploads++
        if (n.up[g]++ > 0) stats.seederRepeats++
        if (stats.seederUploads <= 3 * G) stats.covered.add(g)
      }
      at(t + s.latency, { type: 'data', p, n, g })
    }
  }

  /** A group served well above its share while some other group has not been served yet. */
  const overServed = (n, g) => {
    const share = Math.ceil(n.upTotal++ / G) + 1
    if (n.up[g] < share) return false
    for (let i = 0; i < G; i++) if (n.up[i] < n.up[g]) return true
    return false
  }

  // -- asking ----------------------------------------------------------------------------

  /** The first release's rule: weigh the first 256 missing groups from the start, then drop what the peer lacks. */
  const legacyPool = (p, n) => {
    const pool = []
    for (let g = 0, seen = 0; g < G && seen < SCAN_LIMIT; g++) {
      if (p.has[g] === 1) continue
      seen++
      if (offers(p, n, g) && !p.claimed.has(g)) pool.push(g)
    }
    return pool
  }

  const pump = (t, p, n) => {
    const out = p.inflight.get(n.id)
    const free = (p.windows.get(n.id) ?? s.window) - out.size
    if (free <= 0) return false

    const missing = G - p.count
    const endgame = strategy.endgame && missing <= strategy.endgame.last
    const spare = p.claimed.size >= missing // everything missing is already asked for
    if (spare && !endgame && !strategy.hotswap) return false
    const copies = strategy.hotswap?.copies
    const pool = strategy.legacy ? legacyPool(p, n) : candidates({
      count: G,
      has: (g) => p.has[g] === 1,
      peerHas: (g) => offers(p, n, g),
      claimed: endgame ? (g) => out.has(g) : spare && copies ? (g) => out.has(g) || p.claimed.get(g) >= copies : (g) => p.claimed.has(g),
      from: strategy.from === 'random' ? Math.floor(random() * G) : 0
    })

    const wanted = rank(pool, p.availability, strategy.ties === 'random' ? random : () => 0)
    if (spare && copies) wanted.sort((a, b) => (p.claimed.get(a) ?? 0) - (p.claimed.get(b) ?? 0)) // least asked first

    for (const g of wanted.slice(0, free)) {
      out.add(g)
      p.claimed.set(g, (p.claimed.get(g) ?? 0) + 1)
      p.out++
      at(t + s.latency, { type: 'request', p, n, g })
      at(t + s.timeout, { type: 'timeout', p, n, g })
    }
    return wanted.length > 0 && free > 0
  }

  // -- the clock -------------------------------------------------------------------------

  if (strategy.seeder === 'reveal') {
    for (const sd of peers.filter((x) => x.seed)) {
      for (const id of sd.neighbours) {
        sd.shown.set(id, new Uint8Array(G))
        if (!peers[id].seed) showMore(sd, peers[id], Math.ceil(G / REVEAL))
      }
    }
  }
  for (const p of downloaders) {
    for (const id of p.neighbours) {
      const m = peers[id]
      if (m.seed && strategy.seeder !== 'reveal') for (let g = 0; g < G; g++) p.availability.set(g)
      p.inflight.set(id, new Set())
      p.dirty.add(id)
    }
  }

  let left = downloaders.length
  let lastGain = 0
  const patience = s.timeout * 4 // long enough for requests to time out and be asked again

  for (let t = 0; left > 0; t++) {
    for (const e of bucket.get(t) ?? []) {
      if (e.type === 'request') e.n.queue.push({ from: e.p.id, g: e.g })
      else if (e.type === 'data') { const was = e.p.doneAt; onData(t, e.p, e.n, e.g); if (was === null && e.p.doneAt !== null) left-- }
      else if (e.type === 'reject') onReject(e.p, e.n, e.g)
      else onTimeout(e.p, e.n, e.g)
    }
    bucket.delete(t)

    for (const p of peers) if (p.queue.length) serve(t, p)

    for (const p of downloaders) {
      if (p.doneAt !== null) continue
      if (p.out === 0) p.wake = true // idle: look at everyone again
      const ids = [...p.dirty]
      p.dirty.clear()
      for (const id of ids) pump(t, p, peers[id])

      if (p.wake) {
        p.wake = false
        const start = Math.floor(random() * p.neighbours.length)
        // one answer frees one place: the first neighbour with something wanted fills it
        for (let k = 0; k < p.neighbours.length; k++) {
          if (pump(t, p, peers[p.neighbours[(start + k) % p.neighbours.length]])) break
        }
      }
    }

    if (left > 0 && t - lastGain > patience) throw new Error('swarm stalled')
  }

  const done = downloaders.map((p) => p.doneAt).sort((a, b) => a - b)
  return {
    strategy: typeof s.strategy === 'string' ? s.strategy : 'custom',
    median: done[Math.floor(done.length / 2)] ?? 0,
    last: done[done.length - 1] ?? 0,
    repeatShare: stats.seederUploads ? stats.seederRepeats / stats.seederUploads : 0,
    wasted: stats.wasted,
    coverage3: stats.covered.size / G,
    complete: downloaders.every((p) => p.count === G),
    edges: peers.reduce((n, p) => n + p.neighbours.length, 0) / 2
  }
}

/** Seeders first, then downloaders; every peer links to up to `neighbours` random others. */
function build (s, random) {
  const G = s.groups
  const peers = []
  const mk = (id, seed) => {
    const p = {
      id,
      seed,
      has: new Uint8Array(G), // 1 where the group is held
      count: seed ? G : 0,
      neighbours: [],
      availability: new Availability(G),
      claimed: new Map(), // group → requests outstanding for it
      inflight: new Map(), // neighbour → groups asked of it
      windows: new Map(),
      deny: new Set(),
      out: 0, // requests outstanding in all
      wake: false, // an answer arrived: the freed place may suit any neighbour
      queue: [],
      dirty: new Set(),
      doneAt: seed ? 0 : null,
      up: new Uint32Array(G),
      upTotal: 0,
      shown: new Map()
    }
    if (seed) p.has.fill(1)
    if (!seed && s.slow > 0) p.slow = random() < s.slow
    peers.push(p)
  }

  for (let i = 0; i < s.seeders + s.peers; i++) mk(i, i < s.seeders)

  const order = peers.map((p) => p.id)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }

  for (const id of order) {
    const p = peers[id]
    for (let tries = 0; tries < s.neighbours && p.neighbours.length < s.neighbours; tries++) {
      const q = peers[Math.floor(random() * peers.length)]
      if (q === p || q.neighbours.length >= s.neighbours || p.neighbours.includes(q.id)) continue
      p.neighbours.push(q.id)
      q.neighbours.push(p.id)
    }
  }

  return peers
}
