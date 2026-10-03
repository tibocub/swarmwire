/**
 * Peers that hold only part of the content, and peers that have just finished.
 *
 * This is what separates a swarm from a download: content outlives the machine it came from,
 * because everyone who has any of it can hand that part on. A downloader that could only take
 * would leave the original sender carrying every byte forever.
 */

import test from 'brittle'
import path from 'path'

import { Swarmwire } from '../../lib/swarmwire.js'
import { TestNetwork } from '../helpers/network.js'
import { tmpdir, writeSample, read } from '../helpers/tmp.js'

test('a finished download keeps serving what it fetched', async (t) => {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 300000)

  const origin = node(t, net, 'origin')
  const first = node(t, net, 'first')

  const { link } = await origin.serve(file)
  const got = first.download(link, path.join(dir, 'first'))
  await settleUntil(net, () => got.complete)
  await got

  // The original sender goes away entirely.
  origin.swarm.destroy()
  await net.settle()

  const second = node(t, net, 'second')
  const copy = second.download(link, path.join(dir, 'second'))
  await settleUntil(net, () => copy.complete)
  await copy

  t.alike(read(path.join(dir, 'second')), read(file), 'the content outlived its sender')
})

test('a half-finished download serves the groups it can prove', async (t) => {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 300000)

  const origin = node(t, net, 'origin')
  const half = node(t, net, 'half')

  const { link } = await origin.serve(file)
  const partial = half.download(link, path.join(dir, 'half'))

  // Stop the sender mid-transfer, leaving `half` with some of it and nobody else to ask.
  await stepUntil(net, () => partial.have > 0 && partial.have < partial.total)
  origin.swarm.destroy()
  await net.settle()

  t.ok(partial.have > 0 && !partial.complete, `holding ${partial.have}/${partial.total}`)

  // A third peer arrives. The only source in the swarm is a download in progress.
  const late = node(t, net, 'late')
  const second = late.download(link, path.join(dir, 'late'))
  await settleUntil(net, () => second.have > 0)

  t.ok(second.have > 0, `fetched ${second.have} groups from a peer that is itself incomplete`)
  t.ok(second.have <= partial.have, 'and never more than that peer actually holds')
  t.absent(second.complete, 'it cannot finish: nobody in the swarm has the rest')
})

test('what a partial peer serves still verifies', async (t) => {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 300000)

  const origin = node(t, net, 'origin')
  const half = node(t, net, 'half')
  const { link } = await origin.serve(file)

  const partial = half.download(link, path.join(dir, 'half'))
  await stepUntil(net, () => partial.have > 2)
  origin.swarm.destroy()
  await net.settle()

  const late = node(t, net, 'late')
  const second = late.download(link, path.join(dir, 'late'))
  await settleUntil(net, () => second.have > 0)

  // Relayed groups are proved against the root like any other: nothing is taken on trust
  // because it came from a peer rather than the origin.
  t.is(second.rejected, 0, 'nothing relayed was refused')

  const bytes = read(path.join(dir, 'late'))
  const original = read(file)
  for (let i = 0; i < second.have; i++) {
    const at = i * 16384
    t.alike(bytes.subarray(at, at + 16384), original.subarray(at, at + 16384), `group ${i}`)
  }
})

test('a peer announces new groups as it gets them', async (t) => {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 300000)

  const origin = node(t, net, 'origin')
  const middle = node(t, net, 'middle')
  const { link } = await origin.serve(file)

  // `middle` starts fetching, `late` starts fetching from `middle` before it is done.
  const relay = middle.download(link, path.join(dir, 'middle'))
  await stepUntil(net, () => relay.have > 0 && relay.have < relay.total)

  const late = node(t, net, 'late')
  const second = late.download(link, path.join(dir, 'late'))

  // Everything completes: `middle` finishes from the origin and passes each new group on as
  // it lands, which is what the `holds` message is for.
  await settleUntil(net, () => second.complete)
  await second

  t.alike(read(path.join(dir, 'late')), read(file))
  t.ok(second.peersUsed.size >= 1)
})

// ---------------------------------------------------------------------------

function node (t, net, name) {
  // Deliberately shallow: these tests stop a transfer half way, which needs a half way.
  const sw = new Swarmwire({ swarm: net.peer(name), window: 2 })

  t.teardown(() => sw.destroy())
  return sw
}

async function settleUntil (net, done, { rounds = 2000 } = {}) {
  for (let i = 0; i < rounds; i++) {
    if (done()) return
    await net.settle()
  }
  throw new Error('condition never held')
}

async function stepUntil (net, done, { steps = 2000 } = {}) {
  for (let i = 0; i < steps; i++) {
    if (done()) return
    await net.step()
  }
  throw new Error('condition never held while stepping')
}
