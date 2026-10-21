/**
 * Which group to ask for next.
 *
 * Rarest first, as BitTorrent does it: fetch what few peers have before what everyone has.
 * The reason is not speed on this download but survival of the swarm — a group held by one
 * peer disappears when that peer leaves, and a swarm where every copy of some group lives on
 * one machine is one disconnection away from nobody being able to finish.
 *
 * Two things keep a crowd from asking for the same thing. Equally rare groups are ordered at
 * random rather than by position, and the scan for candidates starts at a random group rather
 * than the start of the file — otherwise a thousand fresh downloaders of a large file would
 * all draw from its first few hundred groups.
 */

import { bao } from './blake3.js'

/** How many candidate groups to weigh at once. */
export const SCAN_LIMIT = 256

/** How many source peers hold each group. Kept up to date by the caller, read in O(1). */
export class Availability {
  constructor (groupCount) {
    this.counts = new Uint16Array(groupCount)
  }

  at (index) { return this.counts[index] }
  set (index) { this.counts[index]++ }
  unset (index) { if (this.counts[index] > 0) this.counts[index]-- }

  add (bitfield) { this._each(bitfield, (i) => this.set(i)) }
  remove (bitfield) { this._each(bitfield, (i) => this.unset(i)) }

  _each (bitfield, fn) {
    const n = Math.min(this.counts.length, bitfield.length * 8)
    for (let i = 0; i < n; i++) if (bao.getBit(bitfield, i)) fn(i)
  }
}

/**
 * The groups worth asking this peer for: wanted, offered, and not already being fetched.
 * Scanning starts at `from` and wraps, so the window is a random stretch of the file.
 */
export function candidates ({ count, has, peerHas, claimed, from = 0, limit = SCAN_LIMIT }) {
  const out = []

  for (let k = 0; k < count && out.length < limit; k++) {
    const i = (from + k) % count
    if (!has(i) && peerHas(i) && !claimed(i)) out.push(i)
  }
  return out
}

/** Fewest holders first; groups equally rare come in the order `random` gives them. */
export function rank (pool, availability, random) {
  return pool
    .map((index) => ({ index, rarity: availability.at(index), tie: random() }))
    .sort((a, b) => a.rarity - b.rarity || a.tie - b.tie)
    .map((entry) => entry.index)
}
