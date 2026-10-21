/**
 * Reading a folder's file list: fetch the manifest into memory, validate it, and leave nothing
 * behind. Nothing here touches disk, and it only ever looks for peers — a node that is merely
 * reading a list is not a provider of the folder.
 */

import b4a from 'b4a'
import { bao } from './blake3.js'

import { decodeManifest, totalSize, MAX_MANIFEST_BYTES } from './collection.js'
import { discoveryTopic } from './address.js'
import { GroupTree, groupHash, verifyGroup, groupCount } from './tree.js'
import { NodeStore } from './nodes.js'

/**
 * The same surface a `Download` uses on a file destination, kept in memory: verify a group
 * before storing it, remember the proofs, hand groups back out. A manifest is small and capped,
 * so there is no resume state to keep.
 */
export class MemoryDestination {
  constructor ({ root, size, groupLog }) {
    if (size > MAX_MANIFEST_BYTES) throw new Error('manifest is implausibly large')

    this.root = root
    this.size = size
    this.groupLog = groupLog
    this.groupCount = groupCount(size, groupLog)

    this._groups = new Map() // index → bytes
    this._bitfield = bao.createBitfield(this.groupCount)
    this._nodes = new NodeStore(this.groupCount)
  }

  get have () { return this._groups.size }
  get complete () { return this._groups.size === this.groupCount }
  has (index) { return bao.getBit(this._bitfield, index) }
  bitfield () { return this._bitfield }

  missing () {
    const out = []
    for (let i = 0; i < this.groupCount; i++) if (!this.has(i)) out.push(i)
    return out
  }

  async put (index, data, proof) {
    if (!Number.isInteger(index) || index < 0 || index >= this.groupCount) return false
    if (this.has(index)) return true

    const { root, size, groupLog } = this
    if (!verifyGroup({ root, size, index, data, proof, groupLog })) return false

    const hash = groupHash(data, index, { groupLog, only: this.groupCount === 1 })
    this._nodes.learn(index, hash, proof)
    this._groups.set(index, b4a.from(data))
    bao.setBit(this._bitfield, index)

    return true
  }

  get tree () {
    return new GroupTree(this._nodes.leaves(), { size: this.size, groupLog: this.groupLog })
  }

  proof (index) {
    return this.has(index) ? this._nodes.proof(index) : null
  }

  async readGroup (index) {
    return this._groups.get(index) ?? null
  }

  /** The whole content, once every group is held. */
  bytes () {
    const parts = []
    for (let i = 0; i < this.groupCount; i++) parts.push(this._groups.get(i))
    return b4a.concat(parts)
  }

  async finish () {}
  async close () {}
}

/**
 * A folder's file list being read. Thenable, like a `Download`: `await listing` resolves to
 * `{ files: [{ path, root, size }], size }`, and `stop()` gives up waiting, which resolves it
 * to `undefined`.
 */
export class Listing {
  /** A read that failed before it began, such as a link that is not a folder. */
  static failed (err) {
    const listing = Object.create(Listing.prototype)
    listing._promise = Promise.reject(err)
    listing._promise.catch(() => {}) // the caller sees it; this only keeps it from being unhandled
    listing.stop = async () => {}
    return listing
  }

  /** A read that needs no network: the list is already known. */
  static known (files) {
    const listing = Object.create(Listing.prototype)
    listing._promise = Promise.resolve({ files, size: totalSize(files) })
    listing.stop = async () => {}
    return listing
  }

  constructor (node, parsed) {
    this._download = null
    this._session = null
    this._stopped = false

    this._promise = this._run(node, parsed)
    this._promise.catch(() => {})
  }

  async stop () {
    this._stopped = true
    await this._download?.stop()
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

  async _run (node, parsed) {
    if (node.downloads.has(parsed.root)) throw new Error('that link is already being downloaded as a file')

    let memory = null

    // Only look: with no server session on the topic this node is never announced for it.
    this._session = node.swarm.join(discoveryTopic(parsed.root, parsed.secret), { server: false, client: true })

    try {
      this._download = node.download({ ...parsed, name: null }, null, {
        announce: false,
        destination: (options) => (memory = new MemoryDestination(options))
      })
      if (this._stopped) await this._download.stop()

      await this._download
      if (this._stopped) return undefined

      const files = decodeManifest(memory.bytes())
      node._learnList(parsed.root, files)

      return { files, size: totalSize(files) }
    } finally {
      await this._session?.destroy?.()
    }
  }
}
