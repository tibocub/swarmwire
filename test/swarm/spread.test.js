/**
 * A crowd of new downloaders must not all ask for the same thing.
 *
 * With every downloader starting from nothing and the file in one place, asking for groups in
 * file order makes the original sender upload the first few groups a hundred times over while
 * the rest of the file waits. Random choices spread the sender's uploads, so downloaders can
 * start serving each other from what they have.
 */

import test from 'brittle'
import path from 'path'

import { Swarmwire } from '../../lib/swarmwire.js'
import { TestNetwork } from '../helpers/network.js'
import { xorshift } from '../helpers/random.js'
import { tmpdir, writeSample, read } from '../helpers/tmp.js'

const GROUPS = 200
const GROUP_LOG = 0 // 1 KiB groups, so a small file is many groups

test('a hundred fresh downloaders spread the sender\'s uploads over the whole file', async (t) => {
  const { net, seen } = await crowd(t, { downloaders: 100, seed: 1 })

  for (let i = 0; i < 20000 && seen.length < 3 * GROUPS; i++) await net.step()
  t.ok(seen.length >= 3 * GROUPS, 'three files\' worth of uploads')

  const first = (n) => new Set(seen.slice(0, n).map((request) => request.index)).size
  t.ok(first(GROUPS) < GROUPS, 'one file\'s worth is not everything: repeats happen')
  t.ok(first(3 * GROUPS) >= 0.9 * GROUPS, `distinct groups after three files' worth: ${first(3 * GROUPS)}`)

  const firsts = new Set()
  const byPeer = new Map()
  for (const request of seen) if (!byPeer.has(request.from)) byPeer.set(request.from, request.index)
  for (const index of byPeer.values()) firsts.add(index)
  t.ok(byPeer.size >= 50 && firsts.size >= 20, `first requests differ: ${firsts.size} distinct over ${byPeer.size} peers`)
})

test('the same seeds give the same first requests, other seeds other ones', async (t) => {
  // Only the first request of each downloader is compared: later ones depend on when real
  // disk writes finish, which the deterministic network does not control.
  const run = async (seed) => {
    const { net, seen, downloads } = await crowd(t, { downloaders: 8, seed, groups: 40 })
    await settleUntil(net, () => downloads.every((download) => download.complete))

    const first = new Map()
    for (const request of seen) if (!first.has(request.from)) first.set(request.from, request.index)
    return [...first].sort().join()
  }

  t.is(await run(3), await run(3))
  t.not(await run(3), await run(4))
})

test('a resumed download asks only for what it does not hold', async (t) => {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 100 * 1024)
  const seeder = node(t, net, 'seeder')
  const { link } = await seeder.serve(file)
  const seen = record(seeder)

  const receiver = node(t, net, 'receiver', { window: 2, random: xorshift(5) })
  const out = path.join(dir, 'got')

  const first = receiver.download(link, out)
  await first.ready()
  for (let i = 0; i < 2000 && !(first.have > 0 && first.have < first.total); i++) await net.step()
  const held = new Set()
  for (let i = 0; i < first.total; i++) if (first.bitfield()[i >> 3] & (1 << (i & 7))) held.add(i)
  t.ok(held.size > 0 && held.size < first.total, `stopped holding ${held.size}`)
  await first.stop()

  seen.length = 0
  const again = receiver.download(link, out)
  await settleUntil(net, () => again.complete)
  await again

  t.ok(seen.every((request) => !held.has(request.index)), 'nothing it held was asked for again')
  t.alike(read(out), read(file))
})

test('one group, and a few dozen, arrive byte-identical', async (t) => {
  for (const size of [1000, 40 * 1024 + 7]) {
    const net = new TestNetwork()
    const dir = tmpdir(t)
    const file = writeSample(dir, 'original', size)
    const seeder = node(t, net, 'seeder')
    const { link } = await seeder.serve(file)

    const receiver = node(t, net, 'receiver')
    const got = receiver.download(link, path.join(dir, 'got'))
    await settleUntil(net, () => got.complete)
    await got

    t.alike(read(path.join(dir, 'got')), read(file), `${size} bytes`)
  }
})

// -- helpers ----------------------------------------------------------------

function node (t, net, name, { random, ...options } = {}) {
  const sw = new Swarmwire({ swarm: net.peer(name), groupLog: GROUP_LOG, ...options })
  if (random) sw.random = random
  t.teardown(() => sw.destroy())
  return sw
}

/** One sender and a crowd, all joined before the network first runs. */
async function crowd (t, { downloaders, seed, groups = GROUPS }) {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', groups * 1024)

  const seeder = node(t, net, 'seeder')
  const { link } = await seeder.serve(file)
  const seen = record(seeder)

  const downloads = []
  for (let i = 0; i < downloaders; i++) {
    const peer = node(t, net, 'p' + i, { window: 8, random: xorshift(seed * 1000 + i) })
    downloads.push(peer.download(link, path.join(dir, 'p' + i)))
  }

  return { net, seen, downloads }
}

/** Every request the node is asked to serve, as `{ from, index }`. */
function record (sw) {
  const seen = []
  const original = sw._onRequest.bind(sw)

  sw._onRequest = (id, message) => {
    seen.push({ from: id, index: message.index })
    return original(id, message)
  }
  return seen
}

async function settleUntil (net, done) {
  // By time, not rounds: a round is one event-loop turn, and real disk I/O can outlast thousands.
  for (const end = Date.now() + 20000; Date.now() < end;) {
    if (done()) return
    await net.settle()
  }
  throw new Error('condition never held')
}
