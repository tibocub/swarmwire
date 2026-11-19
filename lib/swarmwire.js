/**
 * A swarmwire node: serve content you already have, download content you want.
 */

import { EventEmitter } from 'events'
import b4a from 'b4a'

import { bao } from './blake3.js'

import { ContentSource, MemorySource } from './source.js'
import { encodeManifest, decodeManifest, totalSize } from './collection.js'
import { Destination } from './destination.js'
import { discoveryTopic, formatLink, parseLink } from './address.js'
import { DEFAULT_GROUP_LOG, groupCount, groupLength } from './tree.js'
import { openChannel, PROTOCOL, VERSION } from './wire.js'
import { Availability, candidates, rank } from './select.js'
import { Holdings } from './holdings.js'
import { Listing } from './listing.js'
import { OnDemand } from './on-demand.js'
import { systemTimers } from './timers.js'
import * as fsx from './fs.js'

/** Starting window; it adapts. vs the best fixed window on a distant link: 8 costs 1.46x, 32 1.25x, 64 1.19x for twice the memory. */
const WINDOW = 32

/** 512 groups = 8 MiB: the most one peer may reserve. */
const WINDOW_MAX = 512

/** Never go below this: a peer that keeps failing still deserves a chance to answer. */
const WINDOW_MIN = 4

const REQUEST_TIMEOUT = 15000

const MAX_TIMEOUTS = 3

const MAX_OPEN = 64

/** Passing options makes `join` return a session that leaves only itself. */
const ANNOUNCE = { server: true, client: true }

/**
 * A node that serves and downloads content over one swarm.
 *
 * Emits `peer-connected` and `peer-disconnected`, each with `{ id }` (the remote public key in
 * hex), once per distinct peer that completed the swarmwire handshake. `peerCount` and
 * `counts(link)` read the same state.
 */
export class Swarmwire extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.swarm - a Hyperswarm, or anything with `join(topic, opts)` and a
   *   `connection` event. The application creates and destroys it.
   * @param {number} [opts.groupLog=4] - log2 of the 1 KiB chunks per verified group (4 = 16 KiB).
   *   Both sides must use the same value.
   * @param {{setTimer: (ms: number, fn: Function) => Function}} [opts.timers] - clock used for
   *   request timeouts; tests pass a manual one
   * @param {number} [opts.requestTimeout=15000] - ms to wait for a requested group before
   *   giving it to another peer; three timeouts and the peer is no longer asked
   * @param {number} [opts.window=32] - requests in flight per peer to start with; it then
   *   adapts between 4 and 512
   * @param {((root: string, peer: {id: string, publicKey: Uint8Array|null}) =>
   *   string|null|Promise<string|null>)|null} [opts.resolve] - maps a root nothing is serving
   *   to a path, or null. Called when a peer asks; the file is served only if it still hashes
   *   to that root, and only to peers `resolve` said yes to.
   * @param {((root: string, peer: {id: string, publicKey: Uint8Array|null}) =>
   *   boolean|Promise<boolean>)|null} [opts.allowed] - asked before a download in progress is
   *   served to a peer. Anything but a truthy answer, a throw included, refuses. Without it a
   *   download in progress serves any peer.
   * @param {number} [opts.maxOpen=64] - files opened through `resolve` that stay open at once;
   *   each is also closed after 5 s without a read
   * @param {boolean} [opts.temporary=false] - download to `<path>.part` and rename it into
   *   place once complete
   */
  constructor ({
    swarm,
    groupLog = DEFAULT_GROUP_LOG,
    timers = systemTimers,
    requestTimeout = REQUEST_TIMEOUT,
    window = WINDOW,
    resolve = null,
    allowed = null,
    maxOpen = MAX_OPEN,
    temporary = false
  }) {
    super()
    this.swarm = swarm
    this.groupLog = groupLog
    this.timers = timers
    this.requestTimeout = requestTimeout
    this.window = window
    this.temporary = temporary
    this.allowed = allowed
    this.onDemand = resolve ? new OnDemand({ resolve, max: maxOpen, groupLog, timers }) : null
    this.random = Math.random // decides between equally rare groups; tests replace it with a seeded one
    this.serving = new Map()
    this.downloads = new Map()
    this.peers = new Map()
    this.holdings = new Holdings({ groupLog })
    this.lists = new Map()
    this._listings = new Map()
    this._sessions = new Map()

    this._onconnection = (stream, info) => this._onPeer(stream, info)
    this.swarm.on('connection', this._onconnection)
  }

  /**
   * Share a file that already exists on disk. Nothing is copied, nothing is written next to
   * it: the file is hashed where it lies and served from there.
   *
   * Without a `secret` the content is announced on its public topic: anyone who knows the
   * root can find this node. Resolves once the announce has landed.
   *
   * @param {string} path - a file path, or `fd:N` for an already-open descriptor
   * @param {{secret?: string|null, name?: string|null}} [opts] - `secret`: 64 hex characters,
   *   the swarm key for a private topic; `name`: the link's filename hint (default: the
   *   file's basename)
   * @returns {Promise<{root: string, size: number, link: string}>}
   */
  async serve (path, { secret = null, name = basename(path) } = {}) {
    const source = await ContentSource.open(path, { groupLog: this.groupLog })

    const existing = this.serving.get(source.root)
    if (existing && existing !== source) await source.close()
    else this.serving.set(source.root, source)
    this._watch(source.root, source.size)

    // Until the announce lands a lookup finds nobody, which looks like a broken link.
    const discovery = this._announce(source.root, discoveryTopic(source.root, secret))
    if (typeof discovery?.flushed === 'function') await discovery.flushed()

    return {
      root: source.root,
      size: source.size,
      link: formatLink({ root: source.root, size: source.size, name, secret })
    }
  }

  /**
   * Share a whole folder under one link.
   *
   * Every file is hashed where it lies and a manifest naming them is served from memory, so
   * sharing a folder does not add anything to it. The link addresses the manifest; the files
   * are fetched over the same connections afterwards, so a thousand files still cost one
   * announce.
   *
   * `files` replaces the walk of `dir` with an explicit list, for folders that have no path to
   * walk (on Android, a picked folder is only reachable file by file, as `fd:N` descriptors).
   *
   * @param {string|null} dir - the folder; may be null when `files` is given
   * @param {{secret?: string|null, name?: string|null, files?: {path: string, from: string}[]}} [opts]
   *   `secret` and `name` as for `serve`; `files`: each file's path inside the folder, and
   *   where to read it from
   * @returns {Promise<{root: string, size: number, files: number, link: string}>} `root` is
   *   the manifest's root, `size` the total of the files
   */
  async serveCollection (dir, { secret = null, name = dir && basename(dir), files = null } = {}) {
    const found = files ?? (await fsx.list(dir)).map((relative) => ({ path: relative, from: join(dir, relative) }))
    const entries = []

    for (const { path: relative, from } of found) {
      const source = await ContentSource.open(from, { groupLog: this.groupLog })
      if (!this.serving.has(source.root)) this.serving.set(source.root, source)
      else await source.close()

      entries.push({ path: relative, root: source.root, size: source.size })
      this._watch(source.root, source.size)
    }

    const manifest = MemorySource.from(encodeManifest(entries), { groupLog: this.groupLog })
    this.serving.set(manifest.root, manifest)
    this.lists.set(manifest.root, entries)
    this._watch(manifest.root, manifest.size)

    const discovery = this._announce(manifest.root, discoveryTopic(manifest.root, secret))
    if (typeof discovery?.flushed === 'function') await discovery.flushed()

    return {
      root: manifest.root,
      size: totalSize(entries),
      files: entries.length,
      link: formatLink({ root: manifest.root, size: manifest.size, name, secret, type: 'collection' })
    }
  }

  /**
   * Read a folder's file list without fetching any of it: each file's path, root and size, and
   * the total. Nothing is written to disk and this node is never announced as a provider.
   *
   * @param {string|object} link - a folder link
   * @returns {Listing} thenable, resolving to `{ files, size }`; `stop()` gives up waiting
   */
  readList (link) {
    const parsed = typeof link === 'string' ? parseLink(link) : link
    if (parsed.type !== 'collection') return Listing.failed(new Error('not a folder: that link is a single file'))

    return this._list(parsed)
  }

  /**
   * Fetch one file of a folder, using only the folder's link and an entry from its list. It is
   * not announced on its own: the peers holding it are the ones connected through the folder.
   *
   * @param {string|object} link - the folder's link
   * @param {{path: string, root: string, size: number}} file - an entry of `readList`'s result
   * @param {string} outPath - where to write it; its directory must exist
   * @returns {Download}
   */
  downloadFile (link, file, outPath) {
    const { secret } = typeof link === 'string' ? parseLink(link) : link

    return this.download(
      { root: file.root, size: file.size, secret, name: file.path },
      outPath,
      { announce: false }
    )
  }

  _list (parsed) {
    // shortcut: a folder's list is kept for the node's lifetime; evict if a node reads thousands of folders
    const known = this.lists.get(parsed.root)
    if (known) return Listing.known(known)

    let listing = this._listings.get(parsed.root)
    if (!listing) {
      listing = new Listing(this, parsed)
      this._listings.set(parsed.root, listing)
      const done = () => this._listings.delete(parsed.root)
      listing.then(done, done)
    }

    return listing
  }

  _learnList (root, files) {
    this.lists.set(root, files)
    for (const file of files) this._watch(file.root, file.size)
  }

  /**
   * Fetch a collection: the list first, then every file it names, one after another, into
   * `dir` (created if missing). This node announces the folder while it downloads.
   *
   * @param {string|object} link - a folder link, or a parsed one
   * @param {string} dir
   * @param {{onfile?: Function, onprogress?: Function}} [opts] - `onfile({ path, size })` runs
   *   as each file completes; `onprogress({ bytes, total })` as bytes of the whole folder
   *   arrive, first with `bytes: 0` once the list is known
   * @returns {Promise<{files: number, bytes: number}>}
   */
  async downloadCollection (link, dir, { onfile = null, onprogress = null } = {}) {
    const parsed = typeof link === 'string' ? parseLink(link) : link

    await fsx.mkdir(dir)

    // Downloading a folder announces it (reading the list only looks), so others can fetch from us.
    this.swarm.join(discoveryTopic(parsed.root, parsed.secret), ANNOUNCE)

    const list = await this._list(parsed)
    if (!list) throw new Error('the folder list read was stopped')

    let bytes = 0
    const total = list.size
    onprogress?.({ bytes, total })

    for (const file of list.files) {
      const target = join(dir, file.path)
      await fsx.mkdir(parentOf(target))

      const download = this.downloadFile(parsed, file, target)
      download.on('progress', ({ have }) => {
        onprogress?.({ bytes: bytes + Math.min(have * groupLength(this.groupLog), file.size), total })
      })
      await download

      bytes += file.size
      onprogress?.({ bytes, total })
      if (onfile) onfile({ path: file.path, size: file.size })
    }

    return { files: list.files.length, bytes }
  }

  /**
   * Stop serving content and leave its topic. The file itself is untouched.
   *
   * @param {string} root
   * @returns {Promise<void>}
   */
  async unserve (root) {
    const source = this.serving.get(root)
    if (!source) return

    this.serving.delete(root)
    this.holdings.unwatch(root)
    this.lists.delete(root)
    await this._sessions.get(root)?.destroy?.()
    this._sessions.delete(root)
    await source.close()
  }

  _announce (root, topic) {
    if (!this._sessions.has(root)) this._sessions.set(root, this.swarm.join(topic, ANNOUNCE))
    return this._sessions.get(root)
  }

  /** Connected peers that completed the handshake, counting each distinct peer once. */
  get peerCount () {
    return this._ready().length
  }

  /**
   * How many direct connections hold this content: all of it (seeders) or part of it
   * (leechers). It describes who is connected to this node, not the swarm, and a peer that has
   * said nothing about the content is counted in `peers` only. A folder's counts need its file
   * list, which a node knows once it has served, read or downloaded it; until then they are 0.
   *
   * @param {string|object} link
   * @returns {{peers: number, seeders: number, leechers: number}}
   */
  counts (link) {
    const parsed = typeof link === 'string' ? parseLink(link) : link
    const list = this.lists.get(parsed.root)

    let roots = [parsed.root]
    if (list) roots = [parsed.root, ...list.map((file) => file.root)]
    else if (parsed.type === 'collection') roots = []

    return this.holdings.count(this._ready(), roots)
  }

  _ready () {
    const ids = []
    for (const peer of this.peers.values()) if (peer.ready) ids.push(peer.id)
    return ids
  }

  _watch (root, size) {
    this.holdings.watch(root, size, this.peers.values(), (r) => this.downloads.has(r))
  }

  /**
   * Fetch content by link. Returns immediately; await the result for completion, or
   * `await download.ready()` to know the destination has been opened. Asking again for a root
   * already downloading returns the same `Download`.
   *
   * @param {string|object} link - a link, or a parsed one (`{ root, size, secret }`)
   * @param {string} outPath - where to write it; its directory must exist
   * @param {{announce?: boolean, destination?: Function|null, temporary?: boolean}} [opts]
   *   `announce` (default true): join the root's topic; `destination`: an async factory
   *   `({ root, size, groupLog }) => destination` used instead of a file at `outPath`;
   *   `temporary` (default: the node's option): write to `<outPath>.part` and rename at the end
   * @returns {Download}
   */
  download (link, outPath, { announce = true, destination = null, temporary = this.temporary } = {}) {
    const parsed = typeof link === 'string' ? parseLink(link) : link

    const existing = this.downloads.get(parsed.root)
    if (existing) return existing

    const download = new Download(this, parsed, outPath, { announced: announce, destination, temporary })
    this.downloads.set(parsed.root, download)

    // Files of a folder are found through the folder's topic: one announce, not one per file.
    if (announce) download._session = this.swarm.join(discoveryTopic(parsed.root, parsed.secret), ANNOUNCE)

    download._start()

    return download
  }

  /**
   * Stop every download (keeping their resume state), stop serving, close open files. The
   * swarm and its connections are left alone.
   *
   * @returns {Promise<void>}
   */
  async destroy () {
    this.swarm.removeListener?.('connection', this._onconnection)

    for (const download of [...this.downloads.values()]) await download.stop()
    for (const root of [...this.serving.keys()]) await this.unserve(root)
    await this.onDemand?.close()

    this.peers.clear()
  }

  _onPeer (stream, info) {
    const id = peerId(info)
    let peer = null

    const channel = openChannel(stream, {
      onhandshake: () => peer && this._onHandshake(peer),
      onwant: (message) => this._onWant(id, message),
      onhave: (message) => this._onHave(id, message),
      onrequest: (message) => this._onRequest(id, message),
      ondata: (message) => this._onData(id, message),
      onunavailable: (message) => this._onUnavailable(id, message),
      onholds: (message) => this._onHolds(id, message),
      onreject: (message) => this._onReject(id, message),
      onclose: () => peer && this._onPeerGone(peer)
    })

    if (channel === null) return

    // The other side may open after ours was rejected (it was handed the stream later, as
    // with an app's member streams): accept that open instead of letting Protomux reject it.
    channel.mux.pair({ protocol: PROTOCOL }, () => {
      if (channel.channel.closed) this._onPeer(stream, info)
    })

    // A second connection from the same peer replaces the first without announcing it again.
    peer = { id, send: channel.send, wants: new Set(), ready: this.peers.get(id)?.ready === true }
    peer.who = { id, publicKey: info?.publicKey ?? null }
    peer.granted = new Set() // roots allowed() said yes to, for this connection
    this.peers.set(id, peer)

    peer.send.handshake({ version: VERSION, groupLog: this.groupLog })

    // A peer without the content stays quiet and is never asked.
    for (const download of this.downloads.values()) download._askPeer(peer)
    this.holdings.wantAll(peer, (root) => this.downloads.has(root))
  }

  _onHandshake (peer) {
    if (peer.ready) return

    peer.ready = true
    this.emit('peer-connected', { id: peer.id })
  }

  _onPeerGone (peer) {
    // The connection that closed may be one a newer connection from the same peer replaced.
    if (this.peers.get(peer.id) !== peer) return

    this.peers.delete(peer.id)
    this.holdings.dropPeer(peer.id)
    for (const download of this.downloads.values()) download._peerGone(peer)

    if (peer.ready) this.emit('peer-disconnected', { id: peer.id })
  }

  async _onWant (id, { root }) {
    const peer = this.peers.get(id)
    if (!peer) return

    const rootHex = hex(root)
    peer.wants.add(rootHex) // so new groups can be announced to them later

    let source = this.serving.get(rootHex)
    if (!source && this.onDemand && !this.downloads.get(rootHex)?.servable) {
      source = await this.onDemand.get(rootHex, peer.who)
      if (this.peers.get(id) !== peer) return // they left while the file was opened
    }

    if (source) {
      peer.send.have({
        root,
        size: source.size,
        groupLog: source.groupLog,
        bitfield: fullBitfield(source.groupCount)
      })
      return
    }

    const partial = this.downloads.get(rootHex)
    if (partial?.servable && await this._mayServe(peer, rootHex)) {
      if (this.peers.get(id) !== peer) return
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
    let source = this.serving.get(rootHex)
    if (!source && this.onDemand && !this.downloads.get(rootHex)?.servable) {
      source = await this.onDemand.get(rootHex, peer.who) // reopened if it was closed since the `have`
    }

    if (source) {
      if (index < 0 || index >= source.groupCount) return peer.send.reject({ root, index })

      // A source closed under us (evicted, unserved) is a refusal, not a crash.
      const read = this.onDemand ? this.onDemand.read(rootHex, source, index) : source.readGroup(index)
      const data = await read.catch((err) => {
        if (err.code === 'CHANGED') this._changed(rootHex, source)
        return null
      })
      if (!this.peers.has(id)) return // they left while we were reading
      if (data === null) return peer.send.reject({ root, index })

      peer.send.data({ root, index, proof: source.proof(index), data })
      return
    }

    // Refuse rather than stay silent, so the asker reassigns now, not after a timeout.
    const partial = this.downloads.get(rootHex)
    if (!partial?.servable || !(await this._mayServe(peer, rootHex))) {
      if (this.peers.has(id)) peer.send.reject({ root, index })
      return
    }

    const served = await partial.serve(index)
    if (!this.peers.has(id)) return
    if (served === null) return peer.send.reject({ root, index })

    peer.send.data({ root, index, proof: served.proof, data: served.data })
  }

  /** Whether `allowed` lets this peer have a download in progress. A yes lasts the connection. */
  async _mayServe (peer, rootHex) {
    if (!this.allowed || peer.granted.has(rootHex)) return true
    const yes = await Promise.resolve().then(() => this.allowed(rootHex, peer.who)).catch(() => false)
    if (yes) peer.granted.add(rootHex)
    return Boolean(yes)
  }

  /** Keep serving a finished download from where it landed, without rehashing. */
  async _adopt (root, path, tree) {
    if (this.serving.has(root) || this.onDemand?.open.has(root)) return

    try {
      const source = await ContentSource.adopt(path, tree)
      // Serving on demand keeps no file open for good: it joins the others, closed when unused.
      if (this.onDemand) return this.onDemand.add(root, source)
      this.serving.set(root, source)
      this._watch(root, source.size)
    } catch {
      // The file was moved or deleted between finishing and adopting it. Nothing to serve.
    }
  }

  /**
   * The file behind a root no longer hashes to it. Stop serving it and tell everyone who asked
   * that we do not hold it: wrong bytes would get us banned, silence would cost them timeouts.
   */
  _changed (rootHex, source) {
    if (this.serving.get(rootHex) === source) this.unserve(rootHex).catch(() => {})
    else if (this.onDemand?.open.get(rootHex) === source) {
      this.onDemand._drop(rootHex)
      source.close().catch(() => {})
    } else return

    const root = b4a.from(rootHex, 'hex')
    for (const peer of this.peers.values()) {
      if (peer.wants.has(rootHex)) peer.send.unavailable({ root })
    }
  }

  _announceHolds (rootHex, index) {
    const root = b4a.from(rootHex, 'hex')

    for (const peer of this.peers.values()) {
      if (peer.wants.has(rootHex)) peer.send.holds({ root, index })
    }
  }

  _onHolds (id, message) {
    const rootHex = hex(message.root)
    const download = this.downloads.get(rootHex)
    const peer = this.peers.get(id)
    if (!peer) return

    const size = this.serving.get(rootHex)?.size ?? download?.size ?? this.holdings.watched.get(rootHex)
    this.holdings.grow(id, rootHex, message.index, size ?? undefined)
    download?._onHolds(peer, message)
  }

  _onReject (id, message) {
    const download = this.downloads.get(hex(message.root))
    const peer = this.peers.get(id)
    if (download && peer) download._onReject(peer, message)
  }

  _onHave (id, message) {
    const rootHex = hex(message.root)
    const download = this.downloads.get(rootHex)
    const peer = this.peers.get(id)
    if (!peer) return

    this.holdings.set(id, rootHex, message)
    download?._onHave(peer, message)
  }

  _onData (id, message) {
    const download = this.downloads.get(hex(message.root))
    const peer = this.peers.get(id)
    if (download && peer) download._onData(peer, message)
  }

  _onUnavailable (id, message) {
    const rootHex = hex(message.root)
    const download = this.downloads.get(rootHex)
    const peer = this.peers.get(id)
    if (!peer) return

    this.holdings.remove(id, rootHex)
    download?._onUnavailable(peer)
  }
}

/**
 * One transfer in progress, made by `Swarmwire.download`. Thenable: `await download` resolves
 * when it completes or is stopped, and rejects if the destination cannot be written.
 *
 * Events:
 * - `progress` `{ have, total, from }`: a group verified and written (`from` is the peer id;
 *   null on the final event)
 * - `rejected` `{ index, from }`: a group failed verification; that peer is never asked again
 * - `timeout` `{ index, from, strikes }`: a request went unanswered
 * - `stalled` `{ have, total }`: nobody connected can supply what is missing. It never fails
 *   for lack of peers; waiting or `stop()` is the caller's choice.
 *
 * Counters: `have`, `total` (groups), `complete`, `received`, `rejected`, `timedOut`,
 * `rejectedByPeers`, `inflight`, `peersUsed` (a Set of peer ids).
 */
export class Download extends EventEmitter {
  constructor (node, { root, size, secret }, outPath, { announced = true, destination = null, temporary = false } = {}) {
    super()

    this.announced = announced
    this._session = null
    this._destinationFactory = destination

    this.node = node
    this.root = root
    this.size = size // may be null until a peer tells us
    this.secret = secret ?? null
    this.path = outPath
    this._writePath = temporary && !destination ? outPath + '.part' : outPath

    this.received = 0
    this.rejected = 0
    this.timedOut = 0
    this.rejectedByPeers = 0
    this.peersUsed = new Set()
    this.stopped = false

    this._destination = null
    this._bitfields = new Map()
    this._availability = null
    this._sources = new Set()
    this._liars = new Set() // peer ids that sent something that did not verify: never again
    this._asked = new Set()
    this._unavailable = new Set()
    this._inflight = new Map() // peer id → Map(group index → cancel its timer)
    this._strikes = new Map()
    this._windows = new Map()
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

  /** Whether it has verified groups to offer other peers. */
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
    await this._session?.destroy?.() // only ours: the same topic may be served or read elsewhere

    if (this._destination) await this._destination.close()

    // Never resolve with `this`: a thenable resolved with itself waits forever.
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

  _start () {
    if (this.size === null) return // wait for a peer to tell us how big it is

    this._ready = this._open()
    this._ready.catch((err) => this._fail(err))
  }

  async _open () {
    if (this._destination) return

    const options = { root: this.root, size: this.size, groupLog: this.node.groupLog }
    const destination = this._destinationFactory
      ? await this._destinationFactory(options)
      : await Destination.open(this._writePath, options)

    // Stopped while opening: close it here, nobody else will.
    if (this.stopped) return destination.close()

    this._destination = destination
    this._availability = new Availability(destination.groupCount)
    for (const bitfield of this._bitfields.values()) this._availability.add(bitfield)
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

    if (this._liars.has(peer.id)) return

    this._setBitfield(peer.id, b4a.from(bitfield ?? []))
    this._sources.add(peer.id)
    this._unavailable.delete(peer.id)

    if (this.size === null) {
      // No size hint: take the peer's word; every group is still checked against the root.
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

    // Answer arrived with the window full: the window, not the link, is the limit, so grow it.
    const saturated = this._requests(peer).size >= this._windowFor(peer)

    // Late answers still count: the bytes verify either way, and asking someone else would waste them.
    const accepted = await this._destination.put(index, data, proof).catch(() => false)
    if (this.stopped && !this.complete) return // stop() while writing: the group stays on disk, nothing more to say
    this._release(peer, index) // only now: the group stays claimed while it is being written

    if (accepted) {
      this.received++
      this.peersUsed.add(peer.id)
      // An answer clears past timeouts and earns a slow peer its place back.
      this._strikes.delete(peer.id)
      this._widen(peer, saturated)
      if (!this._liars.has(peer.id) && this._bitfields.has(peer.id)) this._sources.add(peer.id)
      this.node._announceHolds(this.root, index)
      this.emit('progress', { have: this.have, total: this.total, from: peer.id })
    } else {
      this.rejected++
      this.emit('rejected', { index, from: peer.id })
      this._liars.add(peer.id)
      this._sources.delete(peer.id)
      this._dropBitfield(peer.id)
    }

    if (this.complete) return this._finish()
    this._pumpAll()
  }

  /** Silence costs more than refusal (the group sits reserved), so a peer that keeps timing out stops being asked. */
  _onTimeout (peer, index) {
    if (this.stopped) return

    this._requests(peer).delete(index)
    this.timedOut++

    const strikes = (this._strikes.get(peer.id) ?? 0) + 1
    this._strikes.set(peer.id, strikes)
    if (strikes >= MAX_TIMEOUTS) this._sources.delete(peer.id)

    this._narrow(peer)

    this.emit('timeout', { index, from: peer.id, strikes })
    this._pumpAll()
  }

  _pump (peer) {
    if (this.stopped || !this._destination || !this._sources.has(peer.id)) return

    const requests = this._requests(peer)
    const window = this._windowFor(peer)
    const destination = this._destination
    const random = this.node.random

    const pool = candidates({
      count: destination.groupCount,
      has: (index) => destination.has(index),
      peerHas: (index) => this._peerHas(peer.id, index),
      claimed: (index) => this._claimed(index),
      from: Math.floor(random() * destination.groupCount)
    })
    const wanted = rank(pool, this._availability, random)

    for (const index of wanted) {
      if (requests.size >= window) break

      this._claim(peer, index)
      peer.send.request({ root: b4a.from(this.root, 'hex'), index })
    }
  }

  _pumpAll () {
    for (const peer of this.node.peers.values()) {
      if (this._sources.has(peer.id)) this._pump(peer)
    }

    // Say so rather than sit silent; waiting or giving up is the caller's choice.
    if (this._sources.size === 0 && this.inflight === 0 && !this.complete) {
      this.emit('stalled', { have: this.have, total: this.total })
    }
  }

  /**
   * AIMD, as in congestion control: the right depth depends on latency and speed, which only the traffic shows.
   */
  _windowFor (peer) {
    return this._windows.get(peer.id) ?? this.node.window
  }

  _widen (peer, saturated) {
    if (!saturated) return // the link, not the window, is what we are waiting on

    const next = Math.min(this._windowFor(peer) + 1, WINDOW_MAX)
    this._windows.set(peer.id, next)
  }

  _narrow (peer) {
    const next = Math.max(Math.floor(this._windowFor(peer) / 2), WINDOW_MIN)
    this._windows.set(peer.id, next)
  }

  _setBitfield (peerId, bitfield) {
    this._dropBitfield(peerId)
    this._bitfields.set(peerId, bitfield)
    this._availability?.add(bitfield)
  }

  _dropBitfield (peerId) {
    const old = this._bitfields.get(peerId)
    if (old) this._availability?.remove(old)
    this._bitfields.delete(peerId)
  }

  /** Does this peer hold that group? An empty bitfield means we were told nothing useful. */
  _peerHas (peerId, index) {
    const bitfield = this._bitfields.get(peerId)
    if (!bitfield || bitfield.length === 0) return false

    return bao.getBit(bitfield, index)
  }

  /** A refused group goes back to the pool, and the peer no longer counts as holding it. */
  _onReject (peer, { index }) {
    if (this.stopped) return

    this._release(peer, index)
    this.rejectedByPeers++
    this._narrow(peer)

    const bitfield = this._bitfields.get(peer.id)
    if (bitfield && index < bitfield.length * 8 && bao.getBit(bitfield, index)) {
      bao.clearBit(bitfield, index)
      this._availability?.unset(index)
    }

    this._pumpAll()
  }

  _onHolds (peer, { index }) {
    const bitfield = this._bitfields.get(peer.id)
    if (!bitfield || index >= bitfield.length * 8) return

    if (!bao.getBit(bitfield, index)) {
      bao.setBit(bitfield, index)
      this._availability?.set(index)
    }
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

  _claimed (index) {
    for (const requests of this._inflight.values()) {
      if (requests.has(index)) return true
    }
    return false
  }

  /** Once every peer asked has said it holds none, `stalled` fires now, not after the caller's timeout. */
  _onUnavailable (peer) {
    this._sources.delete(peer.id)
    this._unavailable.add(peer.id)
    if ([...this._asked].every((id) => this._unavailable.has(id))) this._pumpAll()
  }

  _peerGone (peer) {
    this._sources.delete(peer.id)
    this._unavailable.delete(peer.id)
    this._dropBitfield(peer.id)
    this._asked.delete(peer.id)
    this._releaseAll(peer.id)

    this._pumpAll()
  }

  async _finish () {
    if (this.stopped) return
    this.stopped = true

    this._cancelEverything()
    this.node.downloads.delete(this.root)

    // Keep seeding from the tree built on the way in, so the swarm outlives the original sender.
    const tree = this._destination.tree

    try {
      await this._destination.finish()
      if (this._writePath !== this.path) await fsx.rename(this._writePath, this.path)
    } catch (err) {
      return this._reject(err)
    }
    if (!this._destinationFactory) await this.node._adopt(this.root, this.path, tree)

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

function join (dir, relative) {
  return dir.replace(/[\/]+$/, '') + '/' + relative
}

function parentOf (path) {
  const at = path.lastIndexOf('/')
  return at === -1 ? '.' : path.slice(0, at)
}

function basename (path) {
  const parts = String(path).split(/[\\/]/)
  return parts[parts.length - 1] || null
}
