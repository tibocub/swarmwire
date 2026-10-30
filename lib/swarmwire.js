/**
 * A swarmwire node: serve content you already have, download content you want.
 *
 * It takes a swarm — anything with `join(topic, opts)` (returning a session with `destroy()`) and a `connection` event —
 * so the same code runs against Hyperswarm and against the deterministic test network.
 *
 * Scheduling is deliberately plain for now: ask every peer that has the content, keep a small
 * window of requests in flight with each, take whichever groups come back. Rarest-first,
 * measured queue depths and peer banning are M2, and the harness is where they will be proved.
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

/**
 * Requests in flight per peer, to begin with.
 *
 * No fixed number is right. Keeping a link busy needs roughly (2 x latency x bandwidth) /
 * group size requests outstanding: about 20 for a nearby link, 1600 for a fast distant one —
 * `npm run bench` measures both. So the window starts here and adapts upwards.
 *
 * 32 is where the ramp stops being the bottleneck: starting at 8 costs 1.46x against an
 * oracle-tuned fixed window on a distant link, 32 costs 1.25x, and 64 costs 1.19x for twice
 * the memory. 32 outstanding requests is half a megabyte in flight per peer.
 */
const WINDOW = 32

/**
 * The most requests to have outstanding with one peer: 512 groups is 8 MiB of memory at the
 * default group size, which is as much as one peer should be able to reserve.
 */
const WINDOW_MAX = 512

/** Never go below this: a peer that keeps failing still deserves a chance to answer. */
const WINDOW_MIN = 4

/** How long to wait for a group before assuming the peer is not going to send it. */
const REQUEST_TIMEOUT = 15000

/** Timeouts a peer gets before it stops being asked. */
const MAX_TIMEOUTS = 3

/** Files served on demand that stay open at once. Each is one file handle. */
const MAX_OPEN = 64

/** Passing options makes `join` return a session that leaves only itself. */
const ANNOUNCE = { server: true, client: true }

/**
 * Emits `peer-connected` and `peer-disconnected`, each with `{ id }`, for peers that completed
 * the swarmwire handshake. `peerCount` and `counts(link)` read the same state.
 */
export class Swarmwire extends EventEmitter {
  /**
   * `resolve(root, peer)` (may be async) maps a root no one is serving to a path, or null: the
   * file is opened and hashed when a peer asks for it, and served only if it still has that
   * root. `peer` is `{ id, publicKey }` (`id` as in `peer-connected`); a file open for one peer
   * is served to another only once `resolve` said yes for that one too. `allowed(root, peer)`
   * (may be async) is asked before serving a download still in progress: `resolve` cannot
   * answer for a file not yet held. Without it, a partial download serves any peer.
   * At most `maxOpen` such files stay open, each closed after 5 s without a read. `temporary` downloads to `<path>.part` and renames
   * it into place once complete.
   *
   * @param {{swarm: object, groupLog?: number, timers?: object, requestTimeout?: number,
   *   window?: number, resolve?: Function|null, allowed?: Function|null, maxOpen?: number,
   *   temporary?: boolean}} opts
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
    this.serving = new Map() // root → ContentSource
    this.downloads = new Map() // root → Download
    this.peers = new Map() // peer id → Peer
    this.holdings = new Holdings({ groupLog }) // what those peers say they hold
    this.lists = new Map() // folder root → its file entries, once known
    this._listings = new Map() // folder root → the list read in progress
    this._sessions = new Map() // served root → its announce session, ended by unserve

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
    this._watch(source.root, source.size)

    // Wait for the announce to actually land. Until it has, a peer looking this content up
    // finds nobody, which is indistinguishable from "that link does not work".
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
   * @param {string|null} dir
   * @param {{secret?: string|null, name?: string|null, files?: {path: string, from: string}[]}} [opts]
   *   `files`: each file's path inside the folder, and where to read it from
   * @returns {Promise<{root: string, size: number, files: number, link: string}>}
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

  /** One read per folder at a time: asking again while one runs shares it (and its `stop`). */
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

  /** A folder's list became known: remember it, and ask peers what they hold of its files. */
  _learnList (root, files) {
    this.lists.set(root, files)
    for (const file of files) this._watch(file.root, file.size)
  }

  /**
   * Fetch a collection: the list first, then every file it names, into `dir`.
   *
   * @param {string|object} link
   * @param {string} dir
   * `onfile({ path, size })` runs as each file completes; `onprogress({ bytes, total })` as bytes of
   * the whole folder arrive, first with `bytes: 0` once the list is known.
   *
   * @param {{onfile?: Function, onprogress?: Function}} [opts]
   * @returns {Promise<{files: number, bytes: number}>}
   */
  async downloadCollection (link, dir, { onfile = null, onprogress = null } = {}) {
    const parsed = typeof link === 'string' ? parseLink(link) : link

    await fsx.mkdir(dir)

    // Reading the list only looks; downloading a folder also announces it, so whoever fetches
    // it can be fetched from in turn.
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

  /** Stop serving content. The file itself is untouched. */
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

  /** Ask every peer about a root we hold, unless a download already did. */
  _watch (root, size) {
    this.holdings.watch(root, size, this.peers.values(), (r) => this.downloads.has(r))
  }

  /**
   * Fetch content by link. Returns immediately; await the result for completion, or
   * `await download.ready()` to know the destination has been opened.
   *
   * @param {string|object} link
   * @param {string} outPath
   * @returns {Download}
   */
  download (link, outPath, { announce = true, destination = null, temporary = this.temporary } = {}) {
    const parsed = typeof link === 'string' ? parseLink(link) : link

    const existing = this.downloads.get(parsed.root)
    if (existing) return existing

    const download = new Download(this, parsed, outPath, { announced: announce, destination, temporary })
    this.downloads.set(parsed.root, download)

    // A file inside a collection is not announced on its own: whoever has it is already
    // connected through the collection's topic, and a folder of a thousand files should not
    // mean a thousand announces.
    if (announce) download._session = this.swarm.join(discoveryTopic(parsed.root, parsed.secret), ANNOUNCE)

    download._start()

    return download
  }

  async destroy () {
    this.swarm.removeListener?.('connection', this._onconnection)

    for (const download of [...this.downloads.values()]) await download.stop()
    for (const root of [...this.serving.keys()]) await this.unserve(root)
    await this.onDemand?.close()

    this.peers.clear()
  }

  // -- peers ----------------------------------------------------------------

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
    peer.who = { id, publicKey: info?.publicKey ?? null } // what resolve and allowed are told
    peer.granted = new Set() // roots allowed() said yes to, for this connection
    this.peers.set(id, peer)

    peer.send.handshake({ version: VERSION, groupLog: this.groupLog })

    // Tell a new peer what we are after. A peer that has it answers; one that does not stays
    // quiet and is simply never asked.
    for (const download of this.downloads.values()) download._askPeer(peer)
    this.holdings.wantAll(peer, (root) => this.downloads.has(root))
  }

  /** The remote spoke swarmwire: from here on it is a peer, not just a connection. */
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

    // A download in progress is a source too, for whatever it has verified so far. This is
    // what keeps content alive once the original sender leaves.
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

    // Anything we cannot answer gets a refusal rather than silence, so the asker can give the
    // group to someone else now instead of after a timeout.
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

  /**
   * Keep serving content we just finished downloading, from where it landed.
   *
   * @param {string} root
   * @param {string} path
   * @param {import('./tree.js').GroupTree} tree
   */
  async _adopt (root, path, tree) {
    if (this.serving.has(root) || this.onDemand?.open.has(root)) return

    try {
      const source = await ContentSource.adopt(path, tree)
      // Serving on demand keeps no file open for good: it joins the others, closed when unused.
      if (this.onDemand) return this.onDemand.add(root, source)
      this.serving.set(root, source)
      this._watch(root, source.size) // peers that connect from now on are asked what they hold
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
    } else return // somebody already dealt with it

    const root = b4a.from(rootHex, 'hex')
    for (const peer of this.peers.values()) {
      if (peer.wants.has(rootHex)) peer.send.unavailable({ root })
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
 * One transfer in progress. Thenable, so `await download` waits for it to finish.
 */
export class Download extends EventEmitter {
  constructor (node, { root, size, secret }, outPath, { announced = true, destination = null, temporary = false } = {}) {
    super()

    this.announced = announced
    this._session = null // the announce session, when there is one
    this._destinationFactory = destination // where the content lands, when not a file at `outPath`

    this.node = node
    this.root = root
    this.size = size // may be null until a peer tells us
    this.secret = secret ?? null
    this.path = outPath
    this._writePath = temporary && !destination ? outPath + '.part' : outPath // renamed to `path` once complete

    this.received = 0 // groups accepted over the wire this session
    this.rejected = 0 // groups that failed verification
    this.timedOut = 0 // requests a peer never answered
    this.rejectedByPeers = 0 // requests a peer declined
    this.peersUsed = new Set()
    this.stopped = false

    this._destination = null
    this._bitfields = new Map() // peer id -> what that peer says it holds
    this._availability = null // how many of those hold each group; built once the size is known
    this._sources = new Set() // peer ids worth asking right now
    this._liars = new Set() // peer ids that sent something that did not verify: never again
    this._asked = new Set() // peer ids already told what we want
    this._unavailable = new Set() // peer ids that said they hold none of it
    this._inflight = new Map() // peer id → Map(group index → cancel its timer)
    this._strikes = new Map() // peer id → requests it has failed to answer
    this._windows = new Map() // peer id → how many requests to keep outstanding with it
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
    await this._session?.destroy?.() // only ours: the same topic may be served or read elsewhere

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

    const options = { root: this.root, size: this.size, groupLog: this.node.groupLog }
    const destination = this._destinationFactory
      ? await this._destinationFactory(options)
      : await Destination.open(this._writePath, options)

    // The download can be stopped while the file is still opening. Nobody would ever close
    // this handle otherwise.
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

    if (this._liars.has(peer.id)) return // nothing it says is worth storing

    this._setBitfield(peer.id, b4a.from(bitfield ?? []))
    this._sources.add(peer.id)
    this._unavailable.delete(peer.id)

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

    // Were we asking this peer for as much as we allow when the answer came? If so the
    // window, not the link, is what limits this peer, and it should grow.
    const saturated = this._requests(peer).size >= this._windowFor(peer)

    // Late answers still count. A group whose timer already fired went back in the pool, but
    // the bytes verify against the root either way: throwing away something we still need, in
    // order to go and ask somebody else for it, would be perverse.
    const accepted = await this._destination.put(index, data, proof).catch(() => false)
    if (this.stopped && !this.complete) return // stop() while writing: the group stays on disk, nothing more to say
    this._release(peer, index) // only now: the group stays claimed while it is being written

    if (accepted) {
      this.received++
      this.peersUsed.add(peer.id)
      // Answering clears the record of not answering, and earns back a place in the pool: a
      // peer dropped for being slow has just proved it is worth asking again.
      this._strikes.delete(peer.id)
      this._widen(peer, saturated)
      if (!this._liars.has(peer.id) && this._bitfields.has(peer.id)) this._sources.add(peer.id)
      this.node._announceHolds(this.root, index) // we can serve this one now
      this.emit('progress', { have: this.have, total: this.total, from: peer.id })
    } else {
      this.rejected++
      this.emit('rejected', { index, from: peer.id })
      this._liars.add(peer.id) // a peer that sends rubbish is never asked again
      this._sources.delete(peer.id)
      this._dropBitfield(peer.id)
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

    this._narrow(peer) // asking for less is the first thing to try when a peer struggles

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

    // Nobody usable and nothing outstanding: say so rather than sitting silent forever.
    // Whether to wait for new peers or give up belongs to the caller.
    if (this._sources.size === 0 && this.inflight === 0 && !this.complete) {
      this.emit('stalled', { have: this.have, total: this.total })
    }
  }

  /**
   * The request window for one peer.
   *
   * It grows by one each time an answer arrives while we were already asking for as much as
   * the window allows, and halves whenever a request is refused or times out. Additive
   * increase and multiplicative decrease, the same shape as congestion control, for the same
   * reason: the right depth depends on a link's latency and speed, which only the traffic
   * knows.
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

  /** Remember what a peer holds, keeping the per-group counts in step. */
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

  /**
   * A peer saying it will not serve a group after all. Take the group back, and stop
   * believing it has that one until it says otherwise.
   */
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

  /** A peer announcing one more group it now holds. */
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

  /** Is some peer already fetching this group? */
  _claimed (index) {
    for (const requests of this._inflight.values()) {
      if (requests.has(index)) return true
    }
    return false
  }

  /**
   * A peer that holds none of it. Once every peer asked has said so there is nobody to wait
   * for, so `stalled` fires now rather than after the caller's own timeout.
   */
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
