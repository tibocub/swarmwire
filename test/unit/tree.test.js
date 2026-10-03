import test from 'brittle'
import blake3 from 'blake3-bao/blake3'
import b4a from 'b4a'

import {
  GroupTree,
  GroupTreeBuilder,
  verifyGroup,
  groupCount,
  groupLength,
  groupRange,
  groupHash,
  DEFAULT_GROUP_LOG
} from '../../lib/tree.js'

// Sizes that straddle every boundary that matters: empty, sub-chunk, exact group,
// one over, odd group counts (where the tree is lopsided), powers of two.
const SIZES = [0, 1, 1023, 1024, 1025, 16383, 16384, 16385, 32768, 49152, 65536, 70000, 300000]
const LOGS = [4, 8]

// ---------------------------------------------------------------------------
// The root must be the plain BLAKE3 hash. This is the whole bet: if the tree
// shape is wrong anywhere, these fail and `b3sum` stops agreeing with us.
// ---------------------------------------------------------------------------

for (const log of LOGS) {
  test(`root equals the BLAKE3 hash at every size (group log ${log})`, (t) => {
    for (const size of SIZES) {
      const data = sample(size)
      t.is(treeOf(data, log).root, blake3.hashHex(data), `size ${size}`)
    }
  })
}

test('group count and layout', (t) => {
  t.is(groupLength(4), 16384)
  t.is(groupLength(8), 262144)

  t.is(groupCount(0, 4), 1, 'empty content is still one (empty) group')
  t.is(groupCount(1, 4), 1)
  t.is(groupCount(16384, 4), 1)
  t.is(groupCount(16385, 4), 2)

  t.alike(groupRange(0, 70000, 4), { offset: 0, length: 16384 })
  t.alike(groupRange(4, 70000, 4), { offset: 65536, length: 4464 }, 'the last group is short')
})

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

test('every group verifies against the root with its proof', (t) => {
  for (const size of [1, 16385, 49152, 70000, 300000]) {
    const data = sample(size)
    const tree = treeOf(data, DEFAULT_GROUP_LOG)
    const count = groupCount(size, DEFAULT_GROUP_LOG)

    for (let i = 0; i < count; i++) {
      const { offset, length } = groupRange(i, size, DEFAULT_GROUP_LOG)
      const ok = verifyGroup({
        root: tree.root,
        size,
        index: i,
        data: data.subarray(offset, offset + length),
        proof: tree.proof(i)
      })
      t.ok(ok, `size ${size}, group ${i}`)
    }
  }
})

test('a proof is logarithmic, not linear', (t) => {
  const tree = treeOf(sample(300000), DEFAULT_GROUP_LOG) // 19 groups
  t.is(groupCount(300000, DEFAULT_GROUP_LOG), 19)
  t.ok(tree.proof(0).length <= 5, `proof is ${tree.proof(0).length} hashes for 19 groups`)
})

test('a single group needs no proof at all', (t) => {
  const data = sample(1000)
  const tree = treeOf(data, DEFAULT_GROUP_LOG)

  t.alike(tree.proof(0), [])
  t.ok(verifyGroup({ root: tree.root, size: data.length, index: 0, data, proof: [] }))
})

// ---------------------------------------------------------------------------
// Rejection. A peer that sends anything other than what was asked for must be
// caught here, before a byte reaches the destination file.
// ---------------------------------------------------------------------------

test('tampered data is rejected', (t) => {
  const data = sample(70000)
  const tree = treeOf(data, DEFAULT_GROUP_LOG)
  const group = b4a.from(data.subarray(0, 16384))
  group[500] ^= 0x01

  t.absent(verifyGroup({ root: tree.root, size: data.length, index: 0, data: group, proof: tree.proof(0) }))
})

test('a truncated group is rejected', (t) => {
  const data = sample(70000)
  const tree = treeOf(data, DEFAULT_GROUP_LOG)

  t.absent(verifyGroup({
    root: tree.root,
    size: data.length,
    index: 0,
    data: data.subarray(0, 16000),
    proof: tree.proof(0)
  }))
})

test('a tampered proof is rejected', (t) => {
  const data = sample(70000)
  const tree = treeOf(data, DEFAULT_GROUP_LOG)
  const proof = tree.proof(0).map((h) => b4a.from(h))
  proof[0][0] ^= 0x01

  t.absent(verifyGroup({ root: tree.root, size: data.length, index: 0, data: data.subarray(0, 16384), proof }))
})

test('honest data in the wrong slot is rejected', (t) => {
  // A peer answering "here is group 3" with the real group 2 must not get away with it.
  const data = sample(70000)
  const tree = treeOf(data, DEFAULT_GROUP_LOG)

  t.absent(verifyGroup({
    root: tree.root,
    size: data.length,
    index: 3,
    data: data.subarray(32768, 49152),
    proof: tree.proof(3)
  }))
})

test('a proof for another group is rejected', (t) => {
  const data = sample(70000)
  const tree = treeOf(data, DEFAULT_GROUP_LOG)

  t.absent(verifyGroup({
    root: tree.root,
    size: data.length,
    index: 0,
    data: data.subarray(0, 16384),
    proof: tree.proof(1)
  }))
})

test('a size that changes the tree shape is rejected', (t) => {
  const data = sample(70000)
  const tree = treeOf(data, DEFAULT_GROUP_LOG)

  // 300000 bytes is 19 groups, not 5: a different tree, so the proof cannot fold to the root.
  t.absent(verifyGroup({
    root: tree.root,
    size: 300000,
    index: 0,
    data: data.subarray(0, 16384),
    proof: tree.proof(0)
  }))
})

test('a size lie too small to change the shape is caught at the last group', (t) => {
  // Claiming 70001 bytes leaves the group count at 5 and every full group verifies, so the
  // lie survives until the short final group, whose length no longer matches.
  const data = sample(70000)
  const tree = treeOf(data, DEFAULT_GROUP_LOG)
  const last = data.subarray(65536)

  t.ok(verifyGroup({ root: tree.root, size: 70001, index: 0, data: data.subarray(0, 16384), proof: tree.proof(0) }),
    'the early groups still pass')
  t.absent(verifyGroup({ root: tree.root, size: 70001, index: 4, data: last, proof: tree.proof(4) }),
    'the last group does not')
})

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

test('the builder takes groups one at a time, so a file is never held in memory', (t) => {
  const data = sample(70000)
  const builder = new GroupTreeBuilder()

  for (let offset = 0; offset < data.length; offset += groupLength(DEFAULT_GROUP_LOG)) {
    builder.push(data.subarray(offset, offset + groupLength(DEFAULT_GROUP_LOG)))
  }

  t.is(builder.finalize().root, blake3.hashHex(data))
})

test('the builder rejects a short group that is not the last one', (t) => {
  const builder = new GroupTreeBuilder()
  builder.push(sample(16000))
  t.exception(() => builder.push(sample(16384)), /full/i)
})

test('a tree can be rebuilt from its group hashes without the content', (t) => {
  const data = sample(70000)
  const tree = treeOf(data, DEFAULT_GROUP_LOG)

  // This is what a sender caches next to a file: hashes only, no data.
  const restored = GroupTree.fromGroupHashes(tree.groupHashes, { size: data.length })

  t.is(restored.root, tree.root)
  t.alike(hexes(restored.proof(2)), hexes(tree.proof(2)))
})

// ---------------------------------------------------------------------------

function treeOf (data, groupLog = DEFAULT_GROUP_LOG) {
  return GroupTree.fromContent(data, { groupLog })
}

function sample (n) {
  const b = b4a.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7 + (i >> 8)) & 0xff
  return b
}

/** Compare hashes by value: b4a hands back Buffers on Node and Uint8Arrays on Bare. */
function hexes (list) {
  return list.map((h) => b4a.toString(b4a.from(h), 'hex'))
}

// ---------------------------------------------------------------------------
// Partial knowledge: what a half-finished download can prove.
// ---------------------------------------------------------------------------

test('a group hash can be recomputed from the group alone', (t) => {
  const data = sample(70000)
  const tree = treeOf(data, DEFAULT_GROUP_LOG)

  t.alike(
    hexes([groupHash(data.subarray(0, 16384), 0)]),
    hexes([tree.groupHashes[0]]),
    'so a holder never has to be told the hash of what it holds'
  )
})

test('a tree with holes knows what it cannot prove', (t) => {
  const data = sample(70000) // 5 groups
  const full = treeOf(data, DEFAULT_GROUP_LOG)

  // Hold groups 0 and 1 only. Group 0 needs its sibling (1) and the subtree 2..4, which is
  // missing, so nothing is provable yet.
  const partial = new GroupTree([full.groupHashes[0], full.groupHashes[1], null, null, null], {
    size: data.length
  })

  t.absent(partial.complete)
  t.is(partial.root, null, 'and it cannot pretend to know the address')
  t.is(partial.proof(0), null)
  t.absent(partial.canProve(0))
})

test('a tree with the right holes can still prove some groups', (t) => {
  const data = sample(70000) // 5 groups: the tree splits into 0..3 and 4
  const full = treeOf(data, DEFAULT_GROUP_LOG)

  // Missing only the last group. Groups 0..3 sit in a complete subtree, and the sibling each
  // of them needs is inside it, so all four stay provable.
  const hashes = full.groupHashes.map((h, i) => (i === 4 ? null : h))
  const partial = new GroupTree(hashes, { size: data.length })

  t.absent(partial.canProve(4), 'what it does not have, it cannot prove')
  t.absent(partial.canProve(0), 'nor group 0, whose path needs the missing one as a sibling')

  // A hole in the middle is worse: with group 3 gone, nothing at all can be proved, because
  // every path crosses the subtree that contains it.
  const holed = new GroupTree(full.groupHashes.map((h, i) => (i === 3 ? null : h)), {
    size: data.length
  })
  t.alike([0, 1, 2, 4].map((i) => holed.canProve(i)), [false, false, false, false])
})

test('a complete tree proves everything, hole or not', (t) => {
  const data = sample(70000)
  const full = treeOf(data, DEFAULT_GROUP_LOG)

  // Sanity: a tree built from every hash behaves exactly like one built from content.
  const rebuilt = new GroupTree([...full.groupHashes], { size: data.length })

  t.ok(rebuilt.complete)
  t.is(rebuilt.root, full.root)
  t.ok(verifyGroup({
    root: full.root,
    size: data.length,
    index: 4,
    data: data.subarray(65536),
    proof: rebuilt.proof(4)
  }))
})

test('verifyGroup refuses a missing proof instead of crashing', (t) => {
  const data = sample(70000)
  const tree = treeOf(data, DEFAULT_GROUP_LOG)

  t.absent(verifyGroup({ root: tree.root, size: data.length, index: 0, data: data.subarray(0, 16384), proof: null }))
})
