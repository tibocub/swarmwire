/**
 * What connected peers hold, and how many of them are seeders or leechers.
 *
 * Pure bookkeeping: bytes in, numbers out. The wire and the network are tested elsewhere.
 */

import test from 'brittle'
import { bao } from '../../lib/blake3.js'
import { DEFAULT_GROUP_LOG, groupLength } from '../../lib/tree.js'
import { Holdings } from '../../lib/holdings.js'

const LOG = DEFAULT_GROUP_LOG
const GROUP = groupLength(LOG)

const A = 'a'.repeat(64) // three roots
const B = 'b'.repeat(64)
const M = 'c'.repeat(64) // a manifest

function bitfield (groups, held) {
  const bits = bao.createBitfield(groups)
  for (const i of held) bao.setBit(bits, i)
  return bits
}

/** Tell the store peer `id` holds groups `held` of a root of `groups` groups. */
function have (holdings, id, root, groups, held) {
  holdings.set(id, root, { size: groups * GROUP, groupLog: LOG, bitfield: bitfield(groups, held) })
}

test('a peer holding every group is a seeder, one holding some is a leecher', (t) => {
  const h = new Holdings()
  have(h, 'all', A, 4, [0, 1, 2, 3])
  have(h, 'half', A, 4, [0, 1])

  t.alike(h.count(['all', 'half', 'none'], [A]), { peers: 3, seeders: 1, leechers: 1 })
})

test('a peer that said nothing is in the total and in neither group', (t) => {
  const h = new Holdings()
  t.alike(h.count(['x', 'y'], [A]), { peers: 2, seeders: 0, leechers: 0 })
})

test('a have with no bits set counts as nothing held', (t) => {
  const h = new Holdings()
  have(h, 'empty', A, 4, [])

  t.alike(h.count(['empty'], [A]), { peers: 1, seeders: 0, leechers: 0 })
})

test('holds grows a holding, and a repeated holds changes nothing', (t) => {
  const h = new Holdings()
  have(h, 'p', A, 2, [])

  h.grow('p', A, 0)
  t.alike(h.count(['p'], [A]), { peers: 1, seeders: 0, leechers: 1 })

  h.grow('p', A, 0)
  t.is(h.get('p', A).count, 1, 'count rises only if the bit was clear')

  h.grow('p', A, 1)
  t.alike(h.count(['p'], [A]), { peers: 1, seeders: 1, leechers: 0 }, 'the leecher finished')
})

test('holds for something the peer never described needs a known size to count', (t) => {
  const h = new Holdings()

  h.grow('p', A, 0)
  t.is(h.get('p', A), undefined, 'no size, nothing to build a holding from')

  // A peer that answered "unavailable" and then began downloading only ever sends holds.
  h.grow('p', A, 0, 2 * GROUP)
  t.alike(h.count(['p'], [A]), { peers: 1, seeders: 0, leechers: 1 })

  h.grow('p', A, 5, 2 * GROUP)
  t.is(h.get('p', A).count, 1, 'an index past the end is ignored')
})

test('unavailable and leaving both forget a peer', (t) => {
  const h = new Holdings()
  have(h, 'p', A, 1, [0])
  have(h, 'q', A, 1, [0])

  h.remove('p', A)
  t.alike(h.count(['p', 'q'], [A]), { peers: 2, seeders: 1, leechers: 0 })

  h.dropPeer('q')
  t.alike(h.count(['p'], [A]), { peers: 1, seeders: 0, leechers: 0 })
  t.is(h.get('q', A), undefined)
})

test('a granularity we do not speak is not recorded', (t) => {
  const h = new Holdings()
  h.set('p', A, { size: GROUP, groupLog: LOG + 1, bitfield: bitfield(1, [0]) })

  t.is(h.get('p', A), undefined, 'unknown holdings, not guessed ones')
})

test('an empty file is held by anyone who says they have it', (t) => {
  const h = new Holdings()
  h.set('p', A, { size: 0, groupLog: LOG, bitfield: bitfield(1, [0]) })

  t.alike(h.count(['p'], [A]), { peers: 1, seeders: 1, leechers: 0 })
})

test('a folder seeder holds the list and every file, a leecher any part of it', (t) => {
  const h = new Holdings()
  const roots = [M, A, B]

  have(h, 'seed', M, 1, [0])
  have(h, 'seed', A, 2, [0, 1])
  have(h, 'seed', B, 1, [0])

  have(h, 'list-only', M, 1, [0]) // holds the list and nothing else
  have(h, 'partial', M, 1, [0])
  have(h, 'partial', A, 2, [0, 1])
  have(h, 'partial', B, 1, [])

  t.alike(h.count(['seed', 'list-only', 'partial', 'quiet'], roots), {
    peers: 4,
    seeders: 1,
    leechers: 2
  })
})

test('unknown content, or a folder whose list is not known, gives zeros', (t) => {
  const h = new Holdings()
  have(h, 'p', A, 1, [0])

  t.alike(h.count(['p'], []), { peers: 1, seeders: 0, leechers: 0 })
  t.alike(h.count([], [A]), { peers: 0, seeders: 0, leechers: 0 })
})

test('seeders and leechers never exceed the peers asked about', (t) => {
  const h = new Holdings()
  have(h, 'gone', A, 1, [0]) // still on record, but no longer connected
  have(h, 'here', A, 1, [0])

  const counts = h.count(['here'], [A])
  t.alike(counts, { peers: 1, seeders: 1, leechers: 0 })
  t.ok(counts.seeders + counts.leechers <= counts.peers)
})
