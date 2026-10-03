/**
 * Which group to ask for next.
 *
 * Rarest first, as BitTorrent does it: fetch what few peers have before what everyone has.
 * The reason is not speed on this download but survival of the swarm — a group held by one
 * peer disappears when that peer leaves, and a swarm where every copy of some group lives on
 * one machine is one disconnection away from nobody being able to finish.
 */

/** How many missing groups to consider at once. */
export const SCAN_LIMIT = 256

/**
 * Order candidate groups by how few peers hold them, keeping file order as the tie-break so
 * a transfer still roughly streams.
 *
 * Only the first `limit` missing groups are considered: on a large file, sorting every
 * outstanding group on every request would cost more than it saves, and rarity among the next
 * few hundred is what actually decides the next request.
 *
 * @param {number[]} missing - group indices still wanted, in ascending order
 * @param {(index: number) => number} holders - how many peers hold this group
 * @param {{limit?: number}} [opts]
 * @returns {number[]}
 */
export function rarestFirst (missing, holders, { limit = SCAN_LIMIT } = {}) {
  const candidates = missing.length > limit ? missing.slice(0, limit) : missing.slice()

  return candidates
    .map((index) => ({ index, holders: holders(index) }))
    .sort((a, b) => a.holders - b.holders || a.index - b.index)
    .map((candidate) => candidate.index)
}
