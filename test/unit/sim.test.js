/**
 * The swarm model that decides which strategies are worth building. It is itself checked here:
 * a model that cannot repeat itself, or finishes without everyone holding everything, would
 * make every verdict meaningless.
 */

import test from 'brittle'

import { simulate } from '../../bench/sim/model.js'
import { STRATEGIES } from '../../bench/sim/strategies.js'

const SMALL = { peers: 40, seeders: 1, groups: 64, neighbours: 16, seed: 1 }

test('the same settings and seed give the same result, another seed another', (t) => {
  t.alike(simulate(SMALL), simulate(SMALL))
  t.not(simulate(SMALL).last + ':' + simulate(SMALL).median, simulate({ ...SMALL, seed: 2 }).last + ':' + simulate({ ...SMALL, seed: 2 }).median)
})

test('every strategy ends with every downloader holding every group', (t) => {
  for (const strategy of Object.keys(STRATEGIES)) {
    const result = simulate({ ...SMALL, strategy })
    t.ok(result.complete, strategy)
    t.ok(result.last >= result.median && result.median > 0, strategy + ' times make sense')
  }
})

test('changing one setting leaves the rest alone', (t) => {
  const slow = simulate(SMALL)
  const fast = simulate({ ...SMALL, uplink: 2 })

  t.is(fast.edges, slow.edges, 'the same graph')
  t.ok(fast.last <= slow.last, `a faster uplink is no slower: ${fast.last} vs ${slow.last}`)
})

test('a swarm too big to run is refused, an unreachable one reported', (t) => {
  t.exception(() => simulate({ ...SMALL, peers: 20001 }), /more than the model will run/)
  t.exception(() => simulate({ ...SMALL, neighbours: 0 }), /swarm stalled/)
})

test('one downloader is served completely by every strategy', (t) => {
  for (const strategy of Object.keys(STRATEGIES)) {
    t.ok(simulate({ ...SMALL, peers: 1, strategy }).complete, strategy)
  }
})

test('the model agrees with real nodes on the crowd effect', (t) => {
  // test/swarm/spread.test.js: one sender, a crowd of newcomers, 200 groups. After three files'
  // worth of uploads, random choices have shown nearly the whole file, file order has not.
  const crowd = { peers: 60, groups: 200, neighbours: 60, seederUplink: 8, window: 8 }

  t.ok(simulate({ ...crowd, strategy: 'random-ties' }).coverage3 >= 0.9)
  t.ok(simulate({ ...crowd, strategy: 'file-order' }).coverage3 < 0.5)
})
