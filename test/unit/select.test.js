import test from 'brittle'

import { rarestFirst, SCAN_LIMIT } from '../../lib/select.js'

test('the group fewest peers hold goes first', (t) => {
  const holders = { 0: 5, 1: 1, 2: 3, 3: 5 }

  t.alike(rarestFirst([0, 1, 2, 3], (i) => holders[i]), [1, 2, 0, 3])
})

test('equally rare groups keep file order, so a transfer still roughly streams', (t) => {
  t.alike(rarestFirst([4, 1, 7], () => 2), [1, 4, 7])
})

test('a group nobody has is still ordered, not dropped', (t) => {
  // A peer may announce it later; the caller skips what no peer can serve.
  t.alike(rarestFirst([0, 1], (i) => (i === 0 ? 0 : 4)), [0, 1])
})

test('only the next few hundred missing groups are weighed', (t) => {
  // On a large file, ranking every outstanding group on every request would cost more than
  // it saves, and rarity among what comes next is what decides the next request.
  const missing = Array.from({ length: 5000 }, (_, i) => i)
  const ordered = rarestFirst(missing, (i) => (i === 4000 ? 0 : 9))

  t.is(ordered.length, SCAN_LIMIT)
  t.absent(ordered.includes(4000), 'the rare one far ahead is left for later')
  t.is(ordered[0], 0)
})
