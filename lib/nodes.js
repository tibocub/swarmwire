/**
 * Every tree node a download has learned.
 *
 * Verifying a group teaches you more than the group: the proof that came with it names the
 * hash of each sibling subtree along the way. Keeping those is what makes a half-finished
 * download useful to anyone else — it can hand over a group it holds *with the proof it was
 * given*, instead of being able to prove nothing until it is nearly complete.
 *
 * Nodes are keyed by the range of groups they cover, so a hash learned once is shared by every
 * proof that needs it.
 */

import { bao } from './blake3.js'
import b4a from 'b4a'

import { siblingRanges, splitPoint } from './tree.js'

export class NodeStore {
  /** @param {number} count - total groups in the content */
  constructor (count) {
    this.count = count
    this._nodes = new Map()
  }

  /**
   * @param {number} start - first group covered
   * @param {number} end - one past the last
   * @param {Uint8Array} hash
   * @returns {boolean} false when this node was already known
   */
  set (start, end, hash) {
    const key = rangeKey(start, end)
    if (this._nodes.has(key)) return false

    this._nodes.set(key, b4a.from(hash))
    return true
  }

  /** The hash of a subtree, directly known or derived from its halves. Null if unknown. */
  get (start, end) {
    const known = this._nodes.get(rangeKey(start, end))
    if (known) return known
    if (end - start === 1) return null

    const mid = start + splitPoint(end - start)
    const left = this.get(start, mid)
    if (left === null) return null

    const right = this.get(mid, end)
    if (right === null) return null

    return bao.parentCV(left, right, false)
  }

  has (index) {
    return this.get(index, index + 1) !== null
  }

  /**
   * A proof that group `index` belongs to the root, built from what is known.
   *
   * @param {number} index
   * @returns {Uint8Array[]|null} null when some sibling has never been learned
   */
  proof (index) {
    const proof = []

    for (const { start, end } of siblingRanges(this.count, index)) {
      const hash = this.get(start, end)
      if (hash === null) return null

      proof.push(hash)
    }

    return proof
  }

  /** Can this group be handed to another peer with a proof? */
  canProve (index) {
    return this.has(index) && this.proof(index) !== null
  }

  /**
   * Record everything a verified group taught us: its own hash, and the sibling hashes from
   * the proof that came with it.
   *
   * @param {number} index
   * @param {Uint8Array} hash - the group's own hash
   * @param {Uint8Array[]} proof
   * @returns {{start: number, end: number, hash: Uint8Array}[]} the nodes that were new
   */
  learn (index, hash, proof) {
    const learned = []

    if (this.set(index, index + 1, hash)) {
      learned.push({ start: index, end: index + 1, hash })
    }

    const ranges = siblingRanges(this.count, index)
    for (let i = 0; i < ranges.length && i < proof.length; i++) {
      const { start, end } = ranges[i]
      if (this.set(start, end, proof[i])) learned.push({ start, end, hash: proof[i] })
    }

    return learned
  }

  /** Leaf hashes, with holes where groups are unknown. For building a finished tree. */
  leaves () {
    const out = new Array(this.count).fill(null)
    for (let i = 0; i < this.count; i++) out[i] = this.get(i, i + 1)
    return out
  }
}

function rangeKey (start, end) {
  return start * 0x100000000 + end
}
