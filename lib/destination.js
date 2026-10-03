/**
 * Where a download lands.
 *
 * Two rules, and everything else follows from them:
 *
 *   1. A group is verified against the root *before* it is written. A peer that sends anything
 *      else is refused and gains nothing — not a byte in the file, not a bit in the bitfield.
 *   2. Progress survives a crash. The bitfield lives in a sidecar beside the destination, so
 *      resuming costs nothing and never rehashes what is already there.
 */

import * as bao from 'blake3-bao/bao'
import b4a from 'b4a'

import { verifyGroup, groupCount, groupRange, DEFAULT_GROUP_LOG } from './tree.js'
import * as fsx from './fs.js'

export const SIDECAR_SUFFIX = '.swarmwire-part'

/** Groups accepted between sidecar writes. A crash costs at most this much re-downloading. */
const PERSIST_EVERY = 64

export class Destination {
  /**
   * @param {string} path - where the content is being written
   * @param {{root: string, size: number, groupLog?: number}} opts
   * @returns {Promise<Destination>}
   */
  static async open (path, { root, size, groupLog = DEFAULT_GROUP_LOG }) {
    const count = groupCount(size, groupLog)
    const sidecar = path + SIDECAR_SUFFIX

    const resumed = await loadSidecar(sidecar, { root, size, groupLog, count })
    const file = await fsx.openWrite(path, { size })

    return new Destination(path, file, {
      root,
      size,
      groupLog,
      count,
      bitfield: resumed ?? bao.createBitfield(count)
    })
  }

  constructor (path, file, { root, size, groupLog, count, bitfield }) {
    this.path = path
    this.root = root
    this.size = size
    this.groupLog = groupLog
    this.groupCount = count

    this._file = file
    this._bitfield = bitfield
    this._have = countBits(bitfield, count)
    this._writing = new Set()
    this._sincePersist = 0
    this._closed = false
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

  /** The bitfield as it would be advertised to peers. */
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

    bao.setBit(this._bitfield, index)
    this._have++
    this._sincePersist++

    // Write the sidecar as soon as there is anything to resume, so an interrupted download is
    // visible on disk and never starts from nothing; after that, every PERSIST_EVERY groups.
    if (this._have === 1 || this._sincePersist >= PERSIST_EVERY) await this._persist()

    return true
  }

  /** Complete the download: flush, drop the resume state, close. */
  async finish () {
    if (!this.complete) throw new Error('download is not complete')

    await this._file.sync()
    await this._file.close()
    await fsx.unlink(this.path + SIDECAR_SUFFIX)
    this._closed = true
  }

  /** Stop for now, keeping the resume state. */
  async close () {
    if (this._closed) return
    this._closed = true

    try {
      if (!this.complete) await this._persist()
    } finally {
      await this._file.close() // never leak the handle, even if the sidecar cannot be written
    }
  }

  async _persist () {
    this._sincePersist = 0

    await fsx.writeFile(this.path + SIDECAR_SUFFIX, JSON.stringify({
      swarmwire: 1,
      root: this.root,
      size: this.size,
      groupLog: this.groupLog,
      have: b4a.toString(b4a.from(this._bitfield), 'hex')
    }))
  }
}

/**
 * Read resume state, but only believe it if it describes the same content. A sidecar left by a
 * different download of the same destination path is discarded, never merged.
 */
async function loadSidecar (path, { root, size, groupLog, count }) {
  const raw = await fsx.readFile(path)
  if (raw === null) return null

  try {
    const state = JSON.parse(b4a.toString(raw))
    if (state.swarmwire !== 1) return null
    if (state.root !== root || state.size !== size || state.groupLog !== groupLog) return null

    const bitfield = b4a.from(state.have, 'hex')
    if (bitfield.length !== bao.createBitfield(count).length) return null

    return bitfield
  } catch {
    return null // unreadable resume state is not worth a failed download
  }
}

function countBits (bitfield, count) {
  let n = 0
  for (let i = 0; i < count; i++) {
    if (bao.getBit(bitfield, i)) n++
  }
  return n
}
