/**
 * The group tree: BLAKE3's own hash tree, read at the granularity of chunk groups instead of
 * single 1 KiB chunks.
 *
 * The shape must match BLAKE3's exactly: it splits at the largest power of two *below* the
 * leaf count, so the tree is lopsided when that count is not a power of two.
 */

import { bao } from './blake3.js'
import b4a from 'b4a'

/** BLAKE3's chunk size. Not ours to choose. */
export const CHUNK_LEN = 1024

/** log2 of the chunks per group: 4 → 16 KiB. See docs/format.md §2. */
export const DEFAULT_GROUP_LOG = 4

/**
 * Bytes per group.
 *
 * @param {number} [groupLog]
 * @returns {number}
 */
export function groupLength (groupLog = DEFAULT_GROUP_LOG) {
  return CHUNK_LEN << groupLog
}

/**
 * How many groups content of this size has. Empty content is one empty group.
 *
 * @param {number} size - bytes
 * @param {number} [groupLog]
 * @returns {number}
 */
export function groupCount (size, groupLog = DEFAULT_GROUP_LOG) {
  if (size === 0) return 1
  return Math.ceil(size / groupLength(groupLog))
}

/**
 * Where a group lives in the content.
 *
 * @param {number} index
 * @param {number} size - content size in bytes
 * @param {number} [groupLog]
 * @returns {{offset: number, length: number}}
 */
export function groupRange (index, size, groupLog = DEFAULT_GROUP_LOG) {
  const len = groupLength(groupLog)
  const offset = index * len
  if (offset > size) throw new RangeError('group index is past the end of the content')
  return { offset, length: Math.min(len, size - offset) }
}

/**
 * Builds a tree one group at a time, so hashing a file never means holding it in memory.
 */
export class GroupTreeBuilder {
  /** @param {{groupLog?: number}} [opts] */
  constructor ({ groupLog = DEFAULT_GROUP_LOG } = {}) {
    this.groupLog = groupLog
    this.size = 0

    /** @type {Uint8Array[]} */
    this._hashes = []
    this._full = groupLength(groupLog)
    this._short = false
    /** @type {Uint8Array|null} */
    this._firstGroup = null // kept only until we know whether it is the only one
  }

  /**
   * Add the next group. Every group but the last must be exactly `groupLength()` bytes.
   *
   * @param {Uint8Array} data
   * @returns {this}
   */
  push (data) {
    if (this._short) throw new Error('a short group must be the last one: previous group was not full')
    if (data.length > this._full) throw new Error('group is longer than the group length')
    if (data.length < this._full) this._short = true

    const index = this._hashes.length

    // A lone group is the root, which BLAKE3 finalises differently: hold the first until we know.
    if (index === 0) this._firstGroup = b4a.from(data)
    else this._firstGroup = null

    this._hashes.push(bao.chunkGroupCV(data, index << this.groupLog, false))
    this.size += data.length

    return this
  }

  /** @returns {GroupTree} */
  finalize () {
    if (this._hashes.length === 0) this.push(b4a.alloc(0))

    const hashes = this._hashes
    if (hashes.length === 1) {
      hashes[0] = bao.chunkGroupCV(/** @type {Uint8Array} */ (this._firstGroup), 0, true) // set by the push of group 0
    }

    return new GroupTree(hashes, { size: this.size, groupLog: this.groupLog })
  }
}

/**
 * The hash of one group: its chaining value in the tree.
 *
 * @param {Uint8Array} data
 * @param {number} index
 * @param {{groupLog?: number, only?: boolean}} [opts] - `only` when the group is the whole
 *   content, which BLAKE3 finalises differently
 * @returns {Uint8Array} 32 bytes
 */
export function groupHash (data, index, { groupLog = DEFAULT_GROUP_LOG, only = false } = {}) {
  return bao.chunkGroupCV(data, index << groupLog, only)
}

export class GroupTree {
  /**
   * @param {(Uint8Array|null)[]} groupHashes - holes are allowed: a partial holder knows only
   *   the groups it has, and can prove a group only when the siblings it needs are present
   * @param {{size: number, groupLog?: number}} opts
   */
  constructor (groupHashes, { size, groupLog = DEFAULT_GROUP_LOG }) {
    if (groupHashes.length !== groupCount(size, groupLog)) {
      throw new Error('group hashes do not match the content size')
    }

    this.groupHashes = groupHashes
    this.size = size
    this.groupLog = groupLog
    /** @type {Map<string, Uint8Array>} */
    this._known = new Map() // 'start:end' → hash of a larger subtree; a hash once known never changes
  }

  /**
   * Hash content held in memory. For files, stream it through GroupTreeBuilder instead.
   *
   * @param {Uint8Array} content
   * @param {{groupLog?: number}} [opts]
   * @returns {GroupTree}
   */
  static fromContent (content, { groupLog = DEFAULT_GROUP_LOG } = {}) {
    const builder = new GroupTreeBuilder({ groupLog })
    const len = groupLength(groupLog)

    for (let offset = 0; offset < content.length; offset += len) {
      builder.push(content.subarray(offset, Math.min(offset + len, content.length)))
    }

    return builder.finalize()
  }

  /**
   * Rebuild from cached group hashes — what a sender keeps next to a file.
   *
   * @param {Uint8Array[]} groupHashes
   * @param {{size: number, groupLog?: number}} opts
   * @returns {GroupTree}
   */
  static fromGroupHashes (groupHashes, { size, groupLog = DEFAULT_GROUP_LOG } = /** @type {{size: number}} */ ({})) {
    return new GroupTree(groupHashes.map((h) => b4a.from(h)), { size, groupLog })
  }

  /** @returns {number} */
  get groupCount () {
    return this.groupHashes.length
  }

  /**
   * True when every group's hash is known, so the root can be computed.
   *
   * @returns {boolean}
   */
  get complete () {
    return this.groupHashes.every((hash) => hash !== null && hash !== undefined)
  }

  /**
   * The content address: the plain BLAKE3 hash, hex encoded. Null if any group is missing.
   *
   * @returns {string|null}
   */
  get root () {
    if (!this.complete) return null
    // complete: no hash is missing, so neither is null
    if (this.groupCount === 1) return b4a.toString(/** @type {Uint8Array} */ (this.groupHashes[0]), 'hex')

    return b4a.toString(/** @type {Uint8Array} */ (subtree(this.groupHashes, 0, this.groupCount, true, this._known)), 'hex')
  }

  /**
   * The sibling hashes proving `index` belongs to the root, nearest sibling first.
   *
   * @param {number} index
   * @returns {Uint8Array[]|null} null when a sibling subtree has a hole in it
   */
  proof (index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.groupCount) {
      throw new RangeError('group index out of range')
    }

    const siblings = []
    let start = 0
    let end = this.groupCount

    while (end - start > 1) {
      const mid = start + splitPoint(end - start)
      const sibling = index < mid
        ? subtree(this.groupHashes, mid, end, false, this._known)
        : subtree(this.groupHashes, start, mid, false, this._known)

      if (sibling === null) return null
      siblings.push(sibling)

      if (index < mid) end = mid
      else start = mid
    }

    return siblings.reverse()
  }

  /**
   * Can this group be proved with what is known?
   *
   * @param {number} index
   * @returns {boolean}
   */
  canProve (index) {
    return this.groupHashes[index] != null && this.proof(index) !== null
  }
}

/**
 * Check that `data` really is group `index` of the content addressed by `root`.
 *
 * Everything a peer sends goes through here before it reaches a destination file. Returns
 * false rather than throwing: a lying peer is an expected condition, not an exception.
 *
 * @param {object} opts
 * @param {string} opts.root - 64 hex characters
 * @param {number} opts.size - content size in bytes
 * @param {number} opts.index - group index
 * @param {Uint8Array} opts.data - the group's bytes
 * @param {Uint8Array[]} opts.proof - sibling hashes, nearest first
 * @param {number} [opts.groupLog]
 * @returns {boolean}
 */
export function verifyGroup ({ root, size, index, data, proof, groupLog = DEFAULT_GROUP_LOG }) {
  const count = groupCount(size, groupLog)
  if (!Number.isInteger(index) || index < 0 || index >= count) return false

  // The size a group must have is fixed by the content size: a peer cannot pad or truncate.
  const expected = groupRange(index, size, groupLog)
  if (data.length !== expected.length) return false

  const path = descend(count, index)
  if (!Array.isArray(proof) || proof.length !== path.length) return false

  let cv = bao.chunkGroupCV(data, index << groupLog, count === 1)

  for (let i = 0; i < proof.length; i++) {
    const sibling = proof[i]
    if (!sibling || sibling.length !== 32) return false

    const isRoot = i === proof.length - 1
    const goesLeft = path[path.length - 1 - i] === LEFT

    cv = goesLeft ? bao.parentCV(cv, sibling, isRoot) : bao.parentCV(sibling, cv, isRoot)
  }

  return bao.constantTimeEqual(cv, b4a.from(root, 'hex'))
}

const LEFT = 0
const RIGHT = 1

/**
 * BLAKE3 splits at the largest power of two strictly below the leaf count.
 *
 * @param {number} count
 * @returns {number}
 */
export function splitPoint (count) {
  let p = 1
  while (p * 2 < count) p *= 2
  return p
}

// shortcut: only subtrees of at least this many groups are remembered, so the memory is about n/16
// hashes and a proof recomputes at most ~15 per level; lower it if proofs ever show up in a profile.
const REMEMBER = 16

/**
 * Null when any leaf under this subtree is unknown. `known` remembers the bigger ones.
 *
 * @param {(Uint8Array|null)[]} hashes
 * @param {number} start
 * @param {number} end
 * @param {boolean} isRoot
 * @param {Map<string, Uint8Array>} known
 * @returns {Uint8Array|null}
 */
function subtree (hashes, start, end, isRoot, known) {
  if (end - start === 1) return hashes[start] ?? null

  const key = !isRoot && end - start >= REMEMBER ? start + ':' + end : null
  const remembered = key && known.get(key)
  if (remembered) return remembered

  const mid = start + splitPoint(end - start)
  const left = subtree(hashes, start, mid, false, known)
  if (left === null) return null

  const right = subtree(hashes, mid, end, false, known)
  if (right === null) return null

  const hash = bao.parentCV(left, right, isRoot)
  if (key) known.set(key, hash)
  return hash
}

/**
 * The subtree ranges a proof for `index` is made of, nearest sibling first — the same order
 * the proof itself uses.
 *
 * @param {number} count - total groups
 * @param {number} index
 * @returns {{start: number, end: number}[]}
 */
export function siblingRanges (count, index) {
  const ranges = []
  let start = 0
  let end = count

  while (end - start > 1) {
    const mid = start + splitPoint(end - start)

    if (index < mid) {
      ranges.push({ start: mid, end })
      end = mid
    } else {
      ranges.push({ start, end: mid })
      start = mid
    }
  }

  return ranges.reverse()
}

/**
 * The path from the root down to `index`: which side it is on at each level.
 *
 * @param {number} count
 * @param {number} index
 * @returns {number[]}
 */
function descend (count, index) {
  const path = []
  let start = 0
  let end = count

  while (end - start > 1) {
    const mid = start + splitPoint(end - start)
    if (index < mid) {
      path.push(LEFT)
      end = mid
    } else {
      path.push(RIGHT)
      start = mid
    }
  }

  return path
}
