/**
 * End to end over a real Hyperswarm, on a local DHT testnet rather than the public network.
 *
 * Everything else is tested against the in-memory harness, which is deterministic and proves
 * the logic. This proves the other half: that a Hyperswarm connection is a swarm swarmwire can
 * actually use — real protomux framing, real backpressure, real peer discovery by topic.
 *
 * Slow and timing-dependent by nature. Logic belongs in test/swarm, not here.
 */

import test from 'brittle'
import Hyperswarm from 'hyperswarm'
import createTestnet from '@hyperswarm/testnet'
import path from 'path'

import { Swarmwire } from '../../lib/swarmwire.js'
import { tmpdir, writeSample, read } from '../helpers/tmp.js'

test('a file crosses a real swarm, from a link alone', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 400000)

  const seeder = node(t, testnet)
  const leecher = node(t, testnet)

  const { link } = await seeder.serve(file)
  const out = path.join(dir, 'copy')

  await leecher.download(link, out)

  t.alike(read(out), read(file), 'byte for byte, over the wire')
})

test('a third peer joins the swarm and also gets it', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 200000)

  const seeder = node(t, testnet)
  const first = node(t, testnet)
  const second = node(t, testnet)

  const { link } = await seeder.serve(file)

  await first.download(link, path.join(dir, 'first'))
  await second.download(link, path.join(dir, 'second'))

  t.alike(read(path.join(dir, 'first')), read(file))
  t.alike(read(path.join(dir, 'second')), read(file))
})

function node (t, testnet) {
  // Reachable nodes: the default testnet node is firewalled, so nothing can be announced to it.
  const swarm = new Hyperswarm({ dht: testnet.createNode({ ephemeral: false, firewalled: false }) })
  const sw = new Swarmwire({ swarm })

  t.teardown(async () => {
    await sw.destroy()
    await swarm.destroy()
  })

  return sw
}
