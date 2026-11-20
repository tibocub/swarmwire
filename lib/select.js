/**
 * Which group to ask for next.
 *
 * Rarest first, for the swarm's survival rather than this download's speed: a group held by one
 * peer disappears when it leaves.
 * Ties are broken at random and the scan starts at a random group, so a crowd of fresh
 * downloaders does not all ask for the same first groups.
 */

import { bao } from './blake3.js'

/** How many candidate groups to weigh at once. */
export const SCAN_LIMIT = 256

/** How many source peers hold each group. Kept up to date by the caller, read in O(1). */
export class Availability {
  /** @param {number} groupCount */
  constructor (groupCount) {
    this.counts = new Uint16Array(groupCount)
  }

  /** @param {number} index */
  at (index) { return this.counts[index] }
  /** @param {number} index */
  set (index) { this.counts[index]++ }
  /** @param {number} index */
  unset (index) { if (this.counts[index] > 0) this.counts[index]-- }

  /** @param {Uint8Array} bitfield - one peer's */
  add (bitfield) { this._each(bitfield, (i) => this.set(i)) }
  /** @param {Uint8Array} bitfield - one peer's */
  remove (bitfield) { this._each(bitfield, (i) => this.unset(i)) }

  /**
   * @param {Uint8Array} bitfield
   * @param {(index: number) => void} fn
   */
  _each (bitfield, fn) {
    const n = Math.min(this.counts.length, bitfield.length * 8)
    for (let i = 0; i < n; i++) if (bao.getBit(bitfield, i)) fn(i)
  }
}

/**
 * The groups worth asking this peer for: wanted, offered, and not already being fetched.
 * Scanning starts at `from` and wraps, so the window is a random stretch of the file.
 *
 * @param {object} opts
 * @param {number} opts.count - groups in the content
 * @param {(index: number) => boolean} opts.has - we hold it
 * @param {(index: number) => boolean} opts.peerHas - the peer holds it
 * @param {(index: number) => boolean} opts.claimed - already requested
 * @param {number} [opts.from] - where the scan starts
 * @param {number} [opts.limit]
 * @returns {number[]}
 */
export function candidates ({ count, has, peerHas, claimed, from = 0, limit = SCAN_LIMIT }) {
  const out = []

  for (let k = 0; k < count && out.length < limit; k++) {
    const i = (from + k) % count
    if (!has(i) && peerHas(i) && !claimed(i)) out.push(i)
  }
  return out
}

/**
 * Fewest holders first; groups equally rare come in the order `random` gives them.
 *
 * @param {number[]} pool
 * @param {Availability} availability
 * @param {() => number} random
 * @returns {number[]}
 */
export function rank (pool, availability, random) {
  return pool
    .map((index) => ({ index, rarity: availability.at(index), tie: random() }))
    .sort((a, b) => a.rarity - b.rarity || a.tie - b.tie)
    .map((entry) => entry.index)
}
