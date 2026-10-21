import test from 'brittle'

import { Availability, candidates, rank, SCAN_LIMIT } from '../../lib/select.js'
import { bao } from '../../lib/blake3.js'
import { xorshift } from '../helpers/random.js'

const bits = (count, held) => {
  const field = bao.createBitfield(count)
  for (const i of held) bao.setBit(field, i)
  return field
}

const eligible = { has: () => false, peerHas: () => true, claimed: () => false }

// -- Availability -----------------------------------------------------------

test('availability counts add, set, unset and remove', (t) => {
  const a = new Availability(4)

  a.add(bits(4, [0, 1]))
  a.add(bits(4, [1, 2]))
  t.alike([0, 1, 2, 3].map((i) => a.at(i)), [1, 2, 1, 0])

  a.set(3)
  a.unset(0)
  a.unset(0)
  t.is(a.at(3), 1)
  t.is(a.at(0), 0, 'never below zero')

  a.remove(bits(4, [1, 2]))
  t.alike([0, 1, 2, 3].map((i) => a.at(i)), [0, 1, 0, 1])
})

test('availability always equals a recount, whatever the events', (t) => {
  const random = xorshift(42)
  const groups = 40
  const peers = Array.from({ length: 5 }, () => null) // a bitfield per peer, or null when absent
  const a = new Availability(groups)

  for (let step = 0; step < 200; step++) {
    const p = Math.floor(random() * peers.length)
    const g = Math.floor(random() * groups)
    const have = peers[p]

    if (!have) {
      peers[p] = bits(groups, Array.from({ length: groups }, (_, i) => i).filter(() => random() < 0.3))
      a.add(peers[p])
    } else if (random() < 0.3) {
      a.remove(have)
      peers[p] = null
    } else if (bao.getBit(have, g)) {
      bao.clearBit(have, g)
      a.unset(g)
    } else {
      bao.setBit(have, g)
      a.set(g)
    }

    for (let i = 0; i < groups; i++) {
      t.is(a.at(i), peers.filter((b) => b && bao.getBit(b, i)).length, `step ${step} group ${i}`)
    }
  }
})

// -- candidates -------------------------------------------------------------

test('candidates scan from the start point and wrap', (t) => {
  t.alike(candidates({ count: 6, from: 4, limit: 4, ...eligible }), [4, 5, 0, 1])
})

test('candidates skip what is held, claimed or not offered', (t) => {
  const pool = candidates({
    count: 6,
    from: 0,
    limit: 10,
    has: (i) => i === 1,
    claimed: (i) => i === 2,
    peerHas: (i) => i !== 3
  })
  t.alike(pool, [0, 4, 5])
  t.alike(candidates({ count: 3, from: 0, limit: 5, ...eligible, peerHas: () => false }), [])
})

test('at most the scan limit is returned', (t) => {
  t.is(candidates({ count: 5000, from: 0, ...eligible }).length, SCAN_LIMIT)
})

test('a peer holding only groups far down the file still yields candidates', (t) => {
  const far = (i) => i >= 4000
  t.ok(candidates({ count: 5000, from: 4100, ...eligible, peerHas: far }).length > 0)
  t.ok(candidates({ count: 5000, from: 0, ...eligible, peerHas: far }).length > 0, 'wrapping finds them')
})

// -- rank -------------------------------------------------------------------------------------------------------------------

test('the group fewest peers hold goes first', (t) => {
  const a = new Availability(4)
  for (const [i, n] of [[0, 5], [1, 1], [2, 3], [3, 5]]) for (let k = 0; k < n; k++) a.set(i)

  t.alike(rank([0, 1, 2, 3], a, () => 0).slice(0, 2), [1, 2])
})

test('equally rare groups are ordered by the random source', (t) => {
  const a = new Availability(8)
  const pool = [0, 1, 2, 3, 4, 5, 6, 7]

  t.alike(rank(pool, a, () => 0), pool, 'a constant source keeps scan order')
  t.alike(rank(pool, a, xorshift(1)), rank(pool, a, xorshift(1)), 'same seed, same order')
  t.not(rank(pool, a, xorshift(1)).join(), rank(pool, a, xorshift(2)).join(), 'another seed, another order')
})

test('a group nobody has is still ordered, not dropped', (t) => {
  const a = new Availability(2)
  a.set(1)
  t.alike(rank([0, 1], a, () => 0), [0, 1])
})
