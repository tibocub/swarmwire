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

import { ContentSource } from './source.js'
import { Destination } from './destination.js'
import { discoveryTopic, formatLink, parseLink } from './address.js'
import { DEFAULT_GROUP_LOG, groupCount } from './tree.js'
import { openChannel, VERSION } from './wire.js'
import { systemTimers } from './timers.js'

/** Requests in flight per peer. Enough to keep a link busy, small enough to spread the load. */
const WINDOW = 8

/** How long to wait for a group before assuming the peer is not going to send it. */
const REQUEST_TIMEOUT = 15000

/** Timeouts a peer gets before it stops being asked. */
const MAX_TIMEOUTS = 3

export class Swarmwire {
  /**
   * @param {{swarm: object, groupLog?: number, timers?: object, requestTimeout?: number}} opts
   */
  constructor ({ swarm, groupLog = DEFAULT_GROUP_LOG, timers = systemTimers, requestTimeout = REQUEST_TIMEOUT }) {
    this.swarm = swarm
    this.groupLog = groupLog
    this.timers = timers
    this.requestTimeout = requestTimeout
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
      onclose: () => this._onPeerGone(id)
    })

    if (channel === null) return

    const peer = { id, send: channel.send }
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

  _onWant (id, { root, size }) {
    const peer = this.peers.get(id)
    const source = this.serving.get(hex(root))
    if (!peer) return

    if (!source) {
      peer.send.unavailable({ root })
      return
    }

    peer.send.have({ root, size: source.size, groupLog: source.groupLog })
  }

  async _onRequest (id, { root, index }) {
    const peer = this.peers.get(id)
    const source = this.serving.get(hex(root))
    if (!peer || !source) return

    if (index < 0 || index >= source.groupCount) return

    const data = await source.readGroup(index)
    if (!this.peers.has(id)) return // they left while we were reading

    peer.send.data({ root, index, proof: source.proof(index), data })
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
    this.peersUsed = new Set()
    this.stopped = false

    this._destination = null
    this._sources = new Set() // peer ids known to hold this content
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

  async _onHave (peer, { size, groupLog }) {
    if (this.stopped) return
    if (groupLog !== this.node.groupLog) return // we do not speak that granularity yet

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
    if (!this._requests(peer).has(index)) return // we did not ask this peer for that

    const accepted = await this._destination.put(index, data, proof)
    this._release(peer, index) // only now: the group stays claimed while it is being written

    if (accepted) {
      this.received++
      this.peersUsed.add(peer.id)
      this.emit('progress', { have: this.have, total: this.total, from: peer.id })
    } else {
      this.rejected++
      this.emit('rejected', { index, from: peer.id })
      this._sources.delete(peer.id) // a peer that sends rubbish is not asked again
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

    for (const index of this._destination.missing()) {
      if (requests.size >= WINDOW) break
      if (this._claimed(index)) continue

      this._claim(peer, index)
      peer.send.request({ root: b4a.from(this.root, 'hex'), index })
    }
  }

  _pumpAll () {
    for (const peer of this.node.peers.values()) {
      if (this._sources.has(peer.id)) this._pump(peer)
    }
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
    this._asked.delete(peer.id)
    this._releaseAll(peer.id) // whatever it owed us is up for grabs again

    this._pumpAll()
  }

  async _finish () {
    if (this.stopped) return
    this.stopped = true

    this._cancelEverything()
    this.node.downloads.delete(this.root)
    await this._destination.finish()
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
