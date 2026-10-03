/**
 * Where a download lands — and, while it is still going, something other peers can fetch from.
 *
 * Three rules, and everything else follows:
 *
 *   1. A group is verified against the root *before* it is written. A peer that sends anything
 *      else is refused and gains nothing: not a byte in the file, not a bit in the bitfield.
 *   2. Progress survives a crash. Every accepted group appends a 36-byte record to the part
 *      file beside the destination, so resuming costs nothing and rehashes nothing.
 *   3. What is held can be proved. Those records carry each group's hash, which is what lets a
 *      half-finished download serve its groups to somebody else instead of only taking.
 */

import { bao } from './blake3.js'
import b4a from 'b4a'

import { GroupTree, groupHash, verifyGroup, groupCount, groupRange, DEFAULT_GROUP_LOG } from './tree.js'
import { NodeStore } from './nodes.js'
import { PartFile, SUFFIX } from './partfile.js'
import * as fsx from './fs.js'

export const SIDECAR_SUFFIX = SUFFIX

export class Destination {
  /**
   * @param {string} path - where the content is being written
   * @param {{root: string, size: number, groupLog?: number}} opts
   * @returns {Promise<Destination>}
   */
  static async open (path, { root, size, groupLog = DEFAULT_GROUP_LOG }) {
    const count = groupCount(size, groupLog)
    const { part, nodes } = await PartFile.open(path, { root, size, groupLog })

    try {
      const file = await fsx.openWrite(path, { size })
      return new Destination(path, file, part, { root, size, groupLog, count, nodes })
    } catch (err) {
      await part.close()
      throw err
    }
  }

  constructor (path, file, part, { root, size, groupLog, count, nodes }) {
    this.path = path
    this.root = root
    this.size = size
    this.groupLog = groupLog
    this.groupCount = count

    this._file = file
    this._part = part
    this._writing = new Set()
    this._pending = new Set() // puts still running, which must land before anything closes
    this._closed = false

    this._bitfield = bao.createBitfield(count)
    this._nodes = new NodeStore(count)
    this._have = 0

    for (const { start, end, hash, held } of nodes) {
      if (start >= count || end > count || end <= start) continue

      this._nodes.set(start, end, hash)

      // Only a group we received is on disk. Knowing a hash from somebody else's proof says
      // nothing about whether we have the bytes.
      if (held && !bao.getBit(this._bitfield, start)) {
        bao.setBit(this._bitfield, start)
        this._have++
      }
    }
  }

  /** Groups held so far. */
  get have () {
    return this._have
  }

  get complete () {
    return this._have === this.groupCount
  }

  has (index) {
    return bao.getBit(this._bitfield, index)
  }

  /** @returns {number[]} indices still wanted */
  missing () {
    const out = []
    for (let i = 0; i < this.groupCount; i++) {
      if (!this.has(i)) out.push(i)
    }
    return out
  }

  /** The bitfield as advertised to peers. */
  bitfield () {
    return this._bitfield
  }

  /**
   * Offer a group. Returns false if it does not verify — in which case nothing is written and
   * nothing is recorded, so a lying peer makes no progress by trying again.
   *
   * @param {number} index
   * @param {Uint8Array} data
   * @param {Uint8Array[]} proof
   * @returns {Promise<boolean>}
   */
  async put (index, data, proof) {
    if (this._closed) throw new Error('destination is closed')

    const op = this._put(index, data, proof)
    this._pending.add(op)

    try {
      return await op
    } finally {
      this._pending.delete(op)
    }
  }

  async _put (index, data, proof) {
    if (!Number.isInteger(index) || index < 0 || index >= this.groupCount) return false
    if (this.has(index)) return true

    const ok = verifyGroup({
      root: this.root,
      size: this.size,
      index,
      data,
      proof,
      groupLog: this.groupLog
    })
    if (!ok) return false

    // Two peers can answer the same request at once. Both copies are valid — they verified —
    // but the group must be counted once, or `have` overshoots and the download calls itself
    // finished with a hole in it.
    if (this._writing.has(index)) return true
    this._writing.add(index)

    try {
      const { offset } = groupRange(index, this.size, this.groupLog)
      await this._file.write(offset, data)
    } finally {
      this._writing.delete(index)
    }

    if (this.has(index)) return true

    const hash = groupHash(data, index, {
      groupLog: this.groupLog,
      only: this.groupCount === 1
    })

    // Keep the proof as well as the group: those sibling hashes are exactly what we will need
    // to prove this group to the next peer that asks for it.
    const learned = this._nodes.learn(index, hash, proof)

    bao.setBit(this._bitfield, index)
    this._have++

    // The group itself is marked as held; the proof hashes are knowledge, not data.
    const records = learned.map((node) => ({ ...node, held: node.start === index && node.end === index + 1 }))
    if (!records.some((node) => node.held)) {
      records.push({ start: index, end: index + 1, hash, held: true })
    }

    await this._part.record(records)

    return true
  }

  // -- serving what we already have ------------------------------------------

  /** Wait for puts that started before the close. */
  async _drain () {
    while (this._pending.size > 0) {
      await Promise.allSettled([...this._pending])
    }
  }

  /** The finished tree. Only meaningful once every group is held. */
  get tree () {
    return new GroupTree(this._nodes.leaves(), { size: this.size, groupLog: this.groupLog })
  }

  /** Can this group be served with a proof right now? */
  canProve (index) {
    return this._nodes.canProve(index)
  }

  /** @returns {Uint8Array[]|null} null when some hash the proof needs was never learned */
  proof (index) {
    return this.has(index) ? this._nodes.proof(index) : null
  }

  /** Read a group back out of the destination file. */
  async readGroup (index) {
    if (!this.has(index)) return null

    const { offset, length } = groupRange(index, this.size, this.groupLog)
    return this._file.read(offset, length)
  }

  // -- lifecycle -------------------------------------------------------------

  /** Complete the download: flush, drop the resume state, close. */
  async finish () {
    if (!this.complete) throw new Error('download is not complete')

    // Closed before awaiting anything, so a group arriving now is refused cleanly rather
    // than writing into a handle that is about to shut.
    this._closed = true
    await this._drain()

    await this._file.sync()
    await this._file.close()
    await this._part.close()
    await PartFile.remove(this.path)
  }

  /** Stop for now, keeping the resume state. */
  async close () {
    if (this._closed) return
    this._closed = true

    await this._drain()

    try {
      await this._part.close()
    } finally {
      await this._file.close() // never leak the handle, whatever else fails
    }
  }
}
