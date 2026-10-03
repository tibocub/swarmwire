/**
 * A swarmwire node: serve content you already have, download content you want.
 *
 * It takes a swarm — anything with `join(topic)`, `leave(topic)` and a `connection` event —
 * so the same code runs against Hyperswarm and against the deterministic test network.
 *
 * Scheduling is deliberately plain for now: ask every peer that has the content, keep a small
 * window of requests in flight with each, take whichever groups come back. Rarest-first,
 * measured queue depths and peer banning are M2, and the harness is where they will be proved.
 */

import { EventEmitter } from 'events'
import b4a from 'b4a'

import { bao } from './blake3.js'

import { ContentSource } from './source.js'
import { Destination } from './destination.js'
import { discoveryTopic, formatLink, parseLink } from './address.js'
import { DEFAULT_GROUP_LOG, groupCount } from './tree.js'
import { openChannel, VERSION } from './wire.js'
import { rarestFirst } from './select.js'
import { systemTimers } from './timers.js'

/**
 * Requests in flight per peer.
 *
 * A window of 1 is disastrous (the benchmark shows twenty times the round trips); past about
 * 8 the benchmarks cannot tell the difference, because neither of them models a link that is
 * both slow and far away. 16 is a deliberate middle: enough to keep a real connection busy,
 * small enough that one peer cannot reserve a whole file. Revisit with a bandwidth-limited
 * benchmark, not by guesswork.
 */
const WINDOW = 16

/** How long to wait for a group before assuming the peer is not going to send it. */
const REQUEST_TIMEOUT = 15000

/** Timeouts a peer gets before it stops being asked. */
const MAX_TIMEOUTS = 3

export class Swarmwire {
  /**
   * @param {{swarm: object, groupLog?: number, timers?: object, requestTimeout?: number,
   *   window?: number}} opts
   */
  constructor ({
    swarm,
    groupLog = DEFAULT_GROUP_LOG,
    timers = systemTimers,
    requestTimeout = REQUEST_TIMEOUT,
    window = WINDOW
  }) {
    this.swarm = swarm
    this.groupLog = groupLog
    this.timers = timers
    this.requestTimeout = requestTimeout
    this.window = window
    this.serving = new Map() // root → ContentSource
    this.downloads = new Map() // root → Download
    this.peers = new Map() // peer id → Peer

    this._onconnection = (stream, info) => this._onPeer(stream, info)
    this.swarm.on('connection', this._onconnection)
  }

  /**
   * Share a file that already exists on disk. Nothing is copied, nothing is written next to
   * it: the file is hashed where it lies and served from there.
   *
   * @param {string} path
   * @param {{secret?: string|null, name?: string|null}} [opts]
   * @returns {Promise<{root: string, size: number, link: string}>}
   */
  async serve (path, { secret = null, name = basename(path) } = {}) {
    const source = await ContentSource.open(path, { groupLog: this.groupLog })

    const existing = this.serving.get(source.root)
    if (existing && existing !== source) await source.close()
    else this.serving.set(source.root, source)

    // Wait for the announce to actually land. Until it has, a peer looking this content up
    // finds nobody, which is indistinguishable from "that link does not work".
    const discovery = this.swarm.join(discoveryTopic(source.root, secret))
    if (typeof discovery?.flushed === 'function') await discovery.flushed()

    return {
      root: source.root,
      size: source.size,
      link: formatLink({ root: source.root, size: source.size, name, secret })
    }
  }

  /** Stop serving content. The file itself is untouched. */
  async unserve (root) {
    const source = this.serving.get(root)
    if (!source) return

    this.serving.delete(root)
    await source.close()
  }

  /**
   * Fetch content by link. Returns immediately; await the result for completion, or
   * `await download.ready()` to know the destination has been opened.
   *
   * @param {string|object} link
   * @param {string} outPath
   * @returns {Download}
   */
  download (link, outPath) {
    const parsed = typeof link === 'string' ? parseLink(link) : link

    const existing = this.downloads.get(parsed.root)
    if (existing) return existing

    const download = new Download(this, parsed, outPath)
    this.downloads.set(parsed.root, download)

    this.swarm.join(discoveryTopic(parsed.root, parsed.secret))
    download._start()

    return download
  }

  async destroy () {
    this.swarm.removeListener?.('connection', this._onconnection)

    for (const download of [...this.downloads.values()]) await download.stop()
    for (const root of [...this.serving.keys()]) await this.unserve(root)

    this.peers.clear()
  }

  // -- peers ----------------------------------------------------------------

  _onPeer (stream, info) {
    const id = peerId(info)
    const channel = openChannel(stream, {
      onhandshake: () => {},
      onwant: (message) => this._onWant(id, message),
      onhave: (message) => this._onHave(id, message),
      onrequest: (message) => this._onRequest(id, message),
      ondata: (message) => this._onData(id, message),
      onunavailable: (message) => this._onUnavailable(id, message),
      onholds: (message) => this._onHolds(id, message),
      onreject: (message) => this._onReject(id, message),
      onclose: () => this._onPeerGone(id)
    })

    if (channel === null) return

    const peer = { id, send: channel.send, wants: new Set() }
    this.peers.set(id, peer)

    peer.send.handshake({ version: VERSION, groupLog: this.groupLog })

    // Tell a new peer what we are after. A peer that has it answers; one that does not stays
    // quiet and is simply never asked.
    for (const download of this.downloads.values()) download._askPeer(peer)
  }

  _onPeerGone (id) {
    const peer = this.peers.get(id)
    if (!peer) return

    this.peers.delete(id)
    for (const download of this.downloads.values()) download._peerGone(peer)
  }

  _onWant (id, { root }) {
    const peer = this.peers.get(id)
    if (!peer) return

    const rootHex = hex(root)
    peer.wants.add(rootHex) // so new groups can be announced to them later

    const source = this.serving.get(rootHex)
    if (source) {
      peer.send.have({
        root,
        size: source.size,
        groupLog: source.groupLog,
        bitfield: fullBitfield(source.groupCount)
      })
      return
    }

    // A download in progress is a source too, for whatever it has verified so far. This is
    // what keeps content alive once the original sender leaves.
    const partial = this.downloads.get(rootHex)
    if (partial?.servable) {
      peer.send.have({
        root,
        size: partial.size,
        groupLog: this.groupLog,
        bitfield: partial.bitfield()
      })
      return
    }

    peer.send.unavailable({ root })
  }

  async _onRequest (id, { root, index }) {
    const peer = this.peers.get(id)
    if (!peer) return

    const rootHex = hex(root)
    const source = this.serving.get(rootHex)

    if (source) {
      if (index < 0 || index >= source.groupCount) return peer.send.reject({ root, index })

      const data = await source.readGroup(index)
      if (!this.peers.has(id)) return // they left while we were reading

      peer.send.data({ root, index, proof: source.proof(index), data })
      return
    }

    // Anything we cannot answer gets a refusal rather than silence, so the asker can give the
    // group to someone else now instead of after a timeout.
    const partial = this.downloads.get(rootHex)
    if (!partial?.servable) return peer.send.reject({ root, index })

    const served = await partial.serve(index)
    if (!this.peers.has(id)) return
    if (served === null) return peer.send.reject({ root, index })

    peer.send.data({ root, index, proof: served.proof, data: served.data })
  }

  /**
   * Keep serving content we just finished downloading, from where it landed.
   *
   * @param {string} root
   * @param {string} path
   * @param {import('./tree.js').GroupTree} tree
   */
  async _adopt (root, path, tree) {
    if (this.serving.has(root)) return

    try {
      this.serving.set(root, await ContentSource.adopt(path, tree))
    } catch {
      // The file was moved or deleted between finishing and adopting it. Nothing to serve.
    }
  }

  /** Tell everyone who asked for this content that we now hold one more piece of it. */
  _announceHolds (rootHex, index) {
    const root = b4a.from(rootHex, 'hex')

    for (const peer of this.peers.values()) {
      if (peer.wants.has(rootHex)) peer.send.holds({ root, index })
    }
  }

  _onHolds (id, message) {
    const download = this.downloads.get(hex(message.root))
    const peer = this.peers.get(id)
    if (download && peer) download._onHolds(peer, message)
  }

  _onReject (id, message) {
    const download = this.downloads.get(hex(message.root))
    const peer = this.peers.get(id)
    if (download && peer) download._onReject(peer, message)
  }

  _onHave (id, message) {
    const download = this.downloads.get(hex(message.root))
    const peer = this.peers.get(id)
    if (download && peer) download._onHave(peer, message)
  }

  _onData (id, message) {
    const download = this.downloads.get(hex(message.root))
    const peer = this.peers.get(id)
    if (download && peer) download._onData(peer, message)
  }

  _onUnavailable (id, message) {
    const download = this.downloads.get(hex(message.root))
    const peer = this.peers.get(id)
    if (download && peer) download._sources.delete(peer.id)
  }
}

/**
 * One transfer in progress. Thenable, so `await download` waits for it to finish.
 */
export class Download extends EventEmitter {
  constructor (node, { root, size, secret }, outPath) {
    super()

    this.node = node
    this.root = root
    this.size = size // may be null until a peer tells us
    this.secret = secret ?? null
    this.path = outPath

    this.received = 0 // groups accepted over the wire this session
    this.rejected = 0 // groups that failed verification
    this.timedOut = 0 // requests a peer never answered
    this.rejectedByPeers = 0 // requests a peer declined
    this.peersUsed = new Set()
    this.stopped = false

    this._destination = null
    this._bitfields = new Map() // peer id -> what that peer says it holds
    this._sources = new Set() // peer ids worth asking right now
    this._liars = new Set() // peer ids that sent something that did not verify: never again
    this._asked = new Set() // peer ids already told what we want
    this._inflight = new Map() // peer id → Map(group index → cancel its timer)
    this._strikes = new Map() // peer id → requests it has failed to answer
    this._ready = null
    this._resolve = null
    this._reject = null
    this._promise = new Promise((resolve, reject) => {
      this._resolve = resolve
      this._reject = reject
    })
  }

  /** Resolves once the destination file is open and progress is known. */
  ready () {
    return this._ready ?? Promise.resolve()
  }

  get total () {
    return this._destination ? this._destination.groupCount : (this.size === null ? 0 : groupCount(this.size, this.node.groupLog))
  }

  get have () {
    return this._destination ? this._destination.have : 0
  }

  get complete () {
    return this._destination ? this._destination.complete : false
  }

  /**
   * Is there anything here worth offering other peers? A download with verified groups is a
   * source like any other — this is what keeps content alive after the sender leaves.
   */
  get servable () {
    return !this.stopped && this._destination !== null && this._destination.have > 0
  }

  /** What this download currently holds, for advertising to peers. */
  bitfield () {
    return this._destination ? this._destination.bitfield() : new Uint8Array(0)
  }

  /**
   * Serve one group out of what has been verified so far.
   *
   * @param {number} index
   * @returns {Promise<{data: Uint8Array, proof: Uint8Array[]}|null>} null when it cannot be
   *   proved yet: holding a group is not enough, the sibling hashes have to be there too
   */
  async serve (index) {
    if (!this.servable) return null

    const proof = this._destination.proof(index)
    if (proof === null) return null

    const data = await this._destination.readGroup(index)
    return data === null ? null : { data, proof }
  }

  /** Requests sent and not yet answered. */
  get inflight () {
    let n = 0
    for (const requests of this._inflight.values()) n += requests.size
    return n
  }

  /** Stop without finishing. What has been verified stays on disk, ready to resume. */
  async stop () {
    if (this.stopped) return
    this.stopped = true

    // Let a destination that is mid-open finish, so there is something to close.
    await this.ready().catch(() => {})

    this._cancelEverything()
    this.node.downloads.delete(this.root)
    this.node.swarm.leave?.(discoveryTopic(this.root, this.secret))

    if (this._destination) await this._destination.close()

    // Never resolve with `this`: a Download is itself a thenable, and a promise resolved with
    // its own thenable waits for itself forever.
    this._resolve()
  }

  then (onfulfilled, onrejected) {
    return this._promise.then(onfulfilled, onrejected)
  }

  catch (onrejected) {
    return this._promise.catch(onrejected)
  }

  finally (onfinally) {
    return this._promise.finally(onfinally)
  }

  // -- internals ------------------------------------------------------------

  _start () {
    if (this.size === null) return // wait for a peer to tell us how big it is

    this._ready = this._open()
    this._ready.catch((err) => this._fail(err))
  }

  async _open () {
    if (this._destination) return

    const destination = await Destination.open(this.path, {
      root: this.root,
      size: this.size,
      groupLog: this.node.groupLog
    })

    // The download can be stopped while the file is still opening. Nobody would ever close
    // this handle otherwise.
    if (this.stopped) return destination.close()

    this._destination = destination
    if (this._destination.complete) return this._finish()

    for (const peer of this.node.peers.values()) this._askPeer(peer)
  }

  _askPeer (peer) {
    if (this.stopped || this._asked.has(peer.id)) return

    this._asked.add(peer.id)
    peer.send.want({ root: b4a.from(this.root, 'hex'), size: this.size ?? 0 })
  }

  async _onHave (peer, { size, groupLog, bitfield }) {
    if (this.stopped) return
    if (groupLog !== this.node.groupLog) return // we do not speak that granularity yet

    if (this._liars.has(peer.id)) return // nothing it says is worth storing

    this._bitfields.set(peer.id, b4a.from(bitfield ?? []))
    this._sources.add(peer.id)

    if (this.size === null) {
      // No size hint in the link, so take the peer's word for it. A lie here cannot corrupt
      // anything: every group is still checked against the root, and a wrong size fails.
      this.size = size
      this._ready = this._open()
      this._ready.catch((err) => this._fail(err))
      await this._ready
    }

    await this.ready()
    this._pump(peer)
  }

  async _onData (peer, { index, proof, data }) {
    if (this.stopped || !this._destination) return

    // Late answers still count. A group whose timer already fired went back in the pool, but
    // the bytes verify against the root either way: throwing away something we still need, in
    // order to go and ask somebody else for it, would be perverse.
    const accepted = await this._destination.put(index, data, proof).catch(() => false)
    this._release(peer, index) // only now: the group stays claimed while it is being written

    if (accepted) {
      this.received++
      this.peersUsed.add(peer.id)
      // Answering clears the record of not answering, and earns back a place in the pool: a
      // peer dropped for being slow has just proved it is worth asking again.
      this._strikes.delete(peer.id)
      if (!this._liars.has(peer.id) && this._bitfields.has(peer.id)) this._sources.add(peer.id)
      this.node._announceHolds(this.root, index) // we can serve this one now
      this.emit('progress', { have: this.have, total: this.total, from: peer.id })
    } else {
      this.rejected++
      this.emit('rejected', { index, from: peer.id })
      this._liars.add(peer.id) // a peer that sends rubbish is never asked again
      this._sources.delete(peer.id)
      this._bitfields.delete(peer.id)
    }

    if (this.complete) return this._finish()
    this._pumpAll()
  }

  /**
   * A peer took a request and never answered. Give the group back to the pool, and stop
   * asking a peer that keeps doing it — silence costs more than refusal, because the group
   * sits reserved while nothing happens.
   */
  _onTimeout (peer, index) {
    if (this.stopped) return

    this._requests(peer).delete(index)
    this.timedOut++

    const strikes = (this._strikes.get(peer.id) ?? 0) + 1
    this._strikes.set(peer.id, strikes)
    if (strikes >= MAX_TIMEOUTS) this._sources.delete(peer.id)

    this.emit('timeout', { index, from: peer.id, strikes })
    this._pumpAll()
  }

  _pump (peer) {
    if (this.stopped || !this._destination || !this._sources.has(peer.id)) return

    const requests = this._requests(peer)
    const wanted = rarestFirst(this._destination.missing(), (index) => this._holders(index))

    for (const index of wanted) {
      if (requests.size >= this.node.window) break
      if (this._claimed(index)) continue
      if (!this._peerHas(peer.id, index)) continue // it has not got that one yet

      this._claim(peer, index)
      peer.send.request({ root: b4a.from(this.root, 'hex'), index })
    }
  }

  _pumpAll () {
    for (const peer of this.node.peers.values()) {
      if (this._sources.has(peer.id)) this._pump(peer)
    }

    // Nobody usable and nothing outstanding: say so rather than sitting silent forever.
    // Whether to wait for new peers or give up belongs to the caller.
    if (this._sources.size === 0 && this.inflight === 0 && !this.complete) {
      this.emit('stalled', { have: this.have, total: this.total })
    }
  }

  /** How many connected peers hold this group. Drives rarest-first selection. */
  _holders (index) {
    let n = 0
    for (const peerId of this._sources) {
      if (this._peerHas(peerId, index)) n++
    }
    return n
  }

  /** Does this peer hold that group? An empty bitfield means we were told nothing useful. */
  _peerHas (peerId, index) {
    const bitfield = this._bitfields.get(peerId)
    if (!bitfield || bitfield.length === 0) return false

    return bao.getBit(bitfield, index)
  }

  /**
   * A peer saying it will not serve a group after all. Take the group back, and stop
   * believing it has that one until it says otherwise.
   */
  _onReject (peer, { index }) {
    if (this.stopped) return

    this._release(peer, index)
    this.rejectedByPeers++

    const bitfield = this._bitfields.get(peer.id)
    if (bitfield && index < bitfield.length * 8) bao.clearBit(bitfield, index)

    this._pumpAll()
  }

  /** A peer announcing one more group it now holds. */
  _onHolds (peer, { index }) {
    const bitfield = this._bitfields.get(peer.id)
    if (!bitfield || index >= bitfield.length * 8) return

    bao.setBit(bitfield, index)
    this._pump(peer)
  }

  _requests (peer) {
    let requests = this._inflight.get(peer.id)
    if (!requests) {
      requests = new Map()
      this._inflight.set(peer.id, requests)
    }
    return requests
  }

  _claim (peer, index) {
    const cancel = this.node.timers.setTimer(
      this.node.requestTimeout,
      () => this._onTimeout(peer, index)
    )

    this._requests(peer).set(index, cancel)
  }

  _release (peer, index) {
    const requests = this._requests(peer)
    const cancel = requests.get(index)

    if (cancel) cancel()
    requests.delete(index)
  }

  _releaseAll (peerId) {
    const requests = this._inflight.get(peerId)
    if (!requests) return

    for (const cancel of requests.values()) cancel()
    this._inflight.delete(peerId)
  }

  /** Is some peer already fetching this group? */
  _claimed (index) {
    for (const requests of this._inflight.values()) {
      if (requests.has(index)) return true
    }
    return false
  }

  _peerGone (peer) {
    this._sources.delete(peer.id)
    this._bitfields.delete(peer.id)
    this._asked.delete(peer.id)
    this._releaseAll(peer.id) // whatever it owed us is up for grabs again

    this._pumpAll()
  }

  async _finish () {
    if (this.stopped) return
    this.stopped = true

    this._cancelEverything()
    this.node.downloads.delete(this.root)

    // Every group was hashed on the way in, so the finished file can be served without
    // reading it again. A download that stops seeding the moment it finishes would make the
    // swarm no more durable than its original sender.
    const tree = this._destination.tree

    await this._destination.finish()
    await this.node._adopt(this.root, this.path, tree)

    this.emit('progress', { have: this.have, total: this.total, from: null })
    this._resolve()
  }

  _cancelEverything () {
    for (const peerId of [...this._inflight.keys()]) this._releaseAll(peerId)
  }

  _fail (err) {
    if (this.stopped) return
    this.stopped = true
    this._cancelEverything()
    this.node.downloads.delete(this.root)
    this._reject(err)
  }
}

/** Every bit set: what a peer holding the whole thing advertises. */
function fullBitfield (count) {
  const bitfield = bao.createBitfield(count)
  for (let i = 0; i < count; i++) bao.setBit(bitfield, i)
  return bitfield
}

function peerId (info) {
  return info?.publicKey ? hex(info.publicKey) : String(info?.name ?? 'unknown')
}

function hex (bytes) {
  return typeof bytes === 'string' ? bytes : b4a.toString(b4a.from(bytes), 'hex')
}

function basename (path) {
  const parts = String(path).split(/[\\/]/)
  return parts[parts.length - 1] || null
}
