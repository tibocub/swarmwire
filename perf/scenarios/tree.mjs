// One big file's verification tree (hypergraph specs/research/scale-audit.md #5, perf
// scenario 12; from hypergraph's bench/scale-audit/swarmwire-tree.mjs). Size = the file in GiB;
// one 32 B hash per 16 KB group:
//   wire.tree-memory  a served file's GroupTree (lib/tree.js), bytes per group. flat; the audit
//                     measured ~205 B: 1.3 GB for an open 100 GB file
//   wire.store-memory a download's NodeStore (lib/nodes.js) holding every group, bytes per group
//   wire.proof        one proof from that tree (ms)
// The other half of #5, re-hashing a reopened file over the 32 MB hash cache, is size divided
// by wire.hash (transfer.mjs): not timed here (it would need files of 16 GB and more).

import b4a from 'b4a'
import { record, mem, time, sizes } from '../harness.mjs'
import { GroupTree } from '../../lib/tree.js'
import { NodeStore } from '../../lib/nodes.js'

const GROUP = 16384

const hash = (i) => { const h = b4a.alloc(32); h.writeUInt32LE(i, 0); return h }

for (const gib of sizes([1, 4, 16])) {
  const g = gib * 2 ** 30 / GROUP
  const trees = []
  const stores = []
  let tree = null
  for (let r = 0; r < 3; r++) { // three builds, each measured alone
    let before = mem()
    const hashes = []
    for (let i = 0; i < g; i++) hashes.push(hash(i))
    tree = GroupTree.fromGroupHashes(hashes, { size: g * GROUP })
    hashes.length = 0
    trees.push((mem().heap - before.heap) / g)
    before = mem()
    let store = new NodeStore(g)
    for (let i = 0; i < g; i++) store.set(i, i + 1, hash(i))
    stores.push((mem().heap - before.heap) / g)
    if (!tree.groupCount || !store.count) throw new Error('unreachable') // alive until measured
    store = null
    if (r < 2) tree = null
  }
  record('wire.tree-memory', gib, 'B/group', trees, { flat: true })
  record('wire.store-memory', gib, 'B/group', stores, { flat: true })
  let k = 0
  record('wire.proof', gib, 'ms', await time(() => tree.proof((k = (k * 1103515245 + 12345) >>> 0) % g), 10, { batch: 100 }))
}
