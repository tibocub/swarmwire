/**
 * A deterministic in-memory stand-in for Hyperswarm.
 *
 * Peers join topics, meet whoever else joined the same topic, and exchange bytes over duplex
 * streams — the same shape the real swarm hands us, minus the network. Nothing is delivered
 * until `settle()` runs, so a test controls exactly when each frame lands and there is no
 * timing to be flaky about.
 *
 * Test-only. Node-only is acceptable here (the library itself must also run on Bare).
 *
 * @example
 *   const net = new TestNetwork()
 *   const [alice, bob] = [net.peer('alice'), net.peer('bob')]
 *   alice.on('connection', (stream) => stream.write(b4a.from('hello')))
 *   alice.join(topic)
 *   bob.join(topic)
 *   await net.settle()
 */

import { EventEmitter } from 'events'
import { Duplex } from 'streamx'
import b4a from 'b4a'

export class TestNetwork {
  constructor ({ seed = 1 } = {}) {
    this.peers = new Map()
    this.links = new Map()
    this.queue = []
    this.time = 0

    this._seq = 0
    this._rand = xorshift(seed)
    this._destroyed = false
  }

  /**
   * Create a peer. The name is also its identity: the same name always gets the same public
   * key, so test assertions can name peers instead of comparing keys.
   *
   * @param {string} name
   * @returns {TestPeer}
   */
  peer (name) {
    if (this.peers.has(name)) throw new Error(`peer ${name} already exists`)
    const peer = new TestPeer(this, name)
    this.peers.set(name, peer)
    return peer
  }

  /**
   * The link between two peers, for fault injection. Policies apply in both directions.
   *
   * @param {TestPeer|string} a
   * @param {TestPeer|string} b
   * @returns {Link}
   */
  link (a, b) {
    const key = linkKey(nameOf(a), nameOf(b))
    let link = this.links.get(key)
    if (!link) {
      link = new Link()
      this.links.set(key, link)
    }
    return link
  }

  /**
   * Run discovery and deliver every queued frame, in logical-time order, until nothing is left
   * to do. Resolves once the network is idle.
   *
   * @param {{maxRounds?: number}} [opts]
   */
  async settle ({ maxRounds = 10000 } = {}) {
    for (let round = 0; round < maxRounds; round++) {
      if (!(await this.step())) return
    }

    throw new Error('network did not settle: a peer is probably sending in a loop')
  }

  /**
   * Deliver one batch: everything due at the next logical instant, and nothing after it.
   *
   * `settle()` runs a transfer to a standstill, which makes mid-flight states impossible to
   * catch. Stepping is how a test stops a peer *during* a transfer rather than after it.
   *
   * @returns {Promise<boolean>} false when there was nothing left to deliver
   */
  async step () {
    this._discover()

    if (this.queue.length === 0) {
      await tick() // give anything asynchronous a chance to queue work
      this._discover()
      if (this.queue.length === 0) return false
    }

    this.queue.sort(byDeliveryOrder)
    this.time = Math.max(this.time, this.queue[0].deliverAt)

    while (this.queue.length > 0 && this.queue[0].deliverAt <= this.time) {
      this._deliver(this.queue.shift())
    }

    await tick()
    return true
  }

  /**
   * Let writes reach the network without delivering them. `stream.write()` is asynchronous, so
   * a frame is not queued the instant a test calls it; this is how a test gets to the point
   * where `inflight` means something.
   */
  async pump () {
    await tick()
    this._discover()
  }

  /** Frames waiting to be delivered. */
  get inflight () {
    return this.queue.length
  }

  destroy () {
    this._destroyed = true
    for (const peer of this.peers.values()) peer.destroy()
    this.queue = []
  }

  // -- internals ------------------------------------------------------------

  _send (from, to, data) {
    if (this._destroyed) return

    const link = this.link(from, to)
    if (link.partitioned) return
    if (link.dropRate > 0 && this._rand() < link.dropRate) return

    const payload = from._corrupt ? from._corrupt(b4a.from(data)) : b4a.from(data)
    if (payload === null) return // the peer chose to swallow this frame

    this.queue.push({
      from,
      to,
      data: payload,
      deliverAt: link._schedule(from.name, to.name, payload.length, this.time),
      seq: this._seq++
    })
  }

  _deliver (frame) {
    const connection = frame.to._connections.get(frame.from.name)
    if (!connection || connection.destroying) return
    connection.push(frame.data)
  }

  /** Connect every pair of peers that share a topic and are not connected yet. */
  _discover () {
    const peers = [...this.peers.values()].filter((p) => !p.destroyed)

    for (let i = 0; i < peers.length; i++) {
      for (let j = i + 1; j < peers.length; j++) {
        const a = peers[i]
        const b = peers[j]

        if (a._connections.has(b.name)) continue
        if (this.link(a, b).partitioned) continue
        if (!sharesTopic(a, b)) continue

        this._connect(a, b)
      }
    }
  }

  _connect (a, b) {
    const toB = new TestStream(this, a, b)
    const toA = new TestStream(this, b, a)

    a._connections.set(b.name, toB)
    b._connections.set(a.name, toA)

    // Like Hyperswarm: both sides learn about the connection, with the remote's key on it.
    a.emit('connection', toB, { publicKey: b.publicKey, name: b.name })
    b.emit('connection', toA, { publicKey: a.publicKey, name: a.name })
  }
}

class TestPeer extends EventEmitter {
  constructor (network, name) {
    super()
    this.network = network
    this.name = name
    this.publicKey = keyFor(name)
    this.topics = new Set()
    this.destroyed = false

    this._sessions = new Map() // topic → the sessions joined on it

    this._connections = new Map()
    this._corrupt = null
  }

  /**
   * Like Hyperswarm's `join`: `{ server: false }` looks the topic up without announcing, so
   * two such peers never meet, and the result is a session that leaves only itself.
   *
   * With no options it returns the peer, so tests can write `net.peer('a').join(topic)`.
   *
   * @param {Uint8Array} topic
   * @param {{server?: boolean, client?: boolean}} [opts]
   */
  join (topic, opts) {
    const key = b4a.toString(topic, 'hex')
    const session = { server: opts?.server ?? true }

    let sessions = this._sessions.get(key)
    if (!sessions) this._sessions.set(key, sessions = new Set())
    sessions.add(session)
    this.topics.add(key)

    if (opts === undefined) return this

    return {
      flushed: async () => {},
      destroy: async () => {
        sessions.delete(session)
        if (sessions.size > 0 || this._sessions.get(key) !== sessions) return
        this._sessions.delete(key)
        this.topics.delete(key)
      }
    }
  }

  /** Leave a topic entirely, every session on it. @param {Uint8Array} topic */
  leave (topic) {
    const key = b4a.toString(topic, 'hex')
    this._sessions.delete(key)
    this.topics.delete(key)
    return this
  }

  /** Does this peer announce itself on the topic? */
  serves (key) {
    for (const session of this._sessions.get(key) ?? []) if (session.server) return true
    return false
  }

  /** Every connection this peer currently holds. */
  get connections () {
    return [...this._connections.values()]
  }

  /**
   * Tamper with everything this peer sends: a liar, or a peer with a broken disk.
   * Return `null` to swallow the frame instead.
   *
   * @param {(data: Uint8Array) => Uint8Array|null} fn
   */
  corruptOutgoing (fn) {
    this._corrupt = fn
    return this
  }

  /** Vanish, the way a peer that loses power does: connections close, nothing is flushed. */
  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    this.topics.clear()
    this._sessions.clear()

    for (const [name, stream] of this._connections) {
      const other = this.network.peers.get(name)
      const back = other?._connections.get(this.name)
      other?._connections.delete(this.name)
      this._connections.delete(name)

      stream.destroy()
      back?.destroy()
    }
  }
}

/** One direction of a connection: what `from` writes, `to` reads. */
class TestStream extends Duplex {
  constructor (network, from, to) {
    super()
    this.network = network
    this.from = from
    this.to = to
    this.remotePublicKey = to.publicKey
    this.remoteName = to.name
  }

  _write (data, cb) {
    this.network._send(this.from, this.to, data)
    cb(null)
  }
}

class Link {
  constructor () {
    this.latency = 0
    this.bandwidth = Infinity
    this.dropRate = 0
    this.partitioned = false

    this._free = new Map() // direction -> the tick this link stops being busy
  }

  /** Logical delivery delay. Higher means this peer's frames arrive after everyone else's. */
  setLatency (ticks) {
    this.latency = ticks
    return this
  }

  /**
   * Bytes per tick, in each direction.
   *
   * Without this a link is infinitely fast and only latency matters, which makes request
   * pipelining look pointless: every answer arrives in the same tick however many were asked
   * for. With it, a frame occupies the link while it is transmitted and the next one waits,
   * so a shallow request window leaves the link idle during the round trip — exactly the
   * thing a deeper queue is for.
   */
  setBandwidth (bytesPerTick) {
    this.bandwidth = bytesPerTick
    return this
  }

  /** Fraction of frames silently lost, decided by the network's seeded PRNG. */
  setDropRate (rate) {
    this.dropRate = rate
    return this
  }

  /** Cut the link without either side noticing: frames vanish, no close event. */
  partition () {
    this.partitioned = true
    return this
  }

  heal () {
    this.partitioned = false
    return this
  }

  /**
   * When a frame of this size, sent now, finishes arriving: it queues behind whatever is
   * still on the wire in that direction, takes time to transmit, and then flies.
   */
  _schedule (from, to, bytes, now) {
    if (this.bandwidth === Infinity) return now + this.latency

    const direction = from + ' ' + to
    const starts = Math.max(now, this._free.get(direction) ?? 0)
    const finishes = starts + Math.ceil(bytes / this.bandwidth)

    this._free.set(direction, finishes)

    return finishes + this.latency
  }
}

// -- helpers ----------------------------------------------------------------

function sharesTopic (a, b) {
  // Someone has to be announcing: two peers that are only looking never find each other.
  for (const topic of a.topics) {
    if (b.topics.has(topic) && (a.serves(topic) || b.serves(topic))) return true
  }
  return false
}

function byDeliveryOrder (x, y) {
  return x.deliverAt - y.deliverAt || x.seq - y.seq
}

function nameOf (peer) {
  return typeof peer === 'string' ? peer : peer.name
}

function linkKey (a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

/** Deterministic 32-byte identity for a name, so tests read as names rather than hex. */
function keyFor (name) {
  const key = b4a.alloc(32)
  const bytes = b4a.from(name, 'utf8')
  for (let i = 0; i < key.length; i++) key[i] = bytes[i % bytes.length] ^ (i * 31)
  return key
}

/** Let streams flush whatever our delivery just triggered. */
function tick () {
  return new Promise((resolve) => setImmediate(resolve))
}

function xorshift (seed) {
  let x = seed | 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return ((x >>> 0) % 1000000) / 1000000
  }
}
