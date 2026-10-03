import test from 'brittle'
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'

import { Swarmwire } from '../../lib/swarmwire.js'
import { discoveryTopic, parseLink } from '../../lib/address.js'
import { TestNetwork } from '../helpers/network.js'
import { attachLiar } from '../helpers/liar.js'
import { tmpdir, writeSample, read, exists } from '../helpers/tmp.js'

test('a file moves from one peer to another', async (t) => {
  const { net, dir, seeder, leecher, file } = await twoPeers(t, 70000)

  const { link } = await seeder.serve(file)
  const download = leecher.download(link, path.join(dir, 'copy'))

  await settleUntil(net, () => download.complete)
  await download

  t.alike(read(path.join(dir, 'copy')), read(file), 'byte for byte')
})

test('the receiver only needs the link', async (t) => {
  const { net, dir, seeder, leecher, file } = await twoPeers(t, 40000)

  const { link } = await seeder.serve(file)
  t.ok(link.startsWith('swarmwire://'), link)

  // No topic joined by hand, no peer named, no metadata exchanged out of band.
  const download = leecher.download(link, path.join(dir, 'copy'))
  await settleUntil(net, () => download.complete)
  await download

  t.alike(read(path.join(dir, 'copy')), read(file))
})

test('nothing is copied on the sending side', async (t) => {
  const { net, dir, seeder, leecher, file } = await twoPeers(t, 40000)
  const before = listing(dir)

  const { link } = await seeder.serve(file)
  const download = leecher.download(link, path.join(dir, 'copy'))
  await settleUntil(net, () => download.complete)
  await download

  t.alike(listing(dir).filter((n) => n !== 'copy'), before, 'only the destination appeared')
})

test('progress is reported as it goes', async (t) => {
  const { net, dir, seeder, leecher, file } = await twoPeers(t, 200000)

  const { link } = await seeder.serve(file)
  const download = leecher.download(link, path.join(dir, 'copy'))

  const seen = []
  download.on('progress', ({ have, total }) => seen.push(have / total))

  await settleUntil(net, () => download.complete)
  await download

  t.ok(seen.length > 1, `progress fired ${seen.length} times`)
  t.is(seen[seen.length - 1], 1)
})

test('the resume sidecar is gone once the download completes', async (t) => {
  const { net, dir, seeder, leecher, file } = await twoPeers(t, 40000)
  const out = path.join(dir, 'copy')

  const { link } = await seeder.serve(file)
  const download = leecher.download(link, out)
  await settleUntil(net, () => download.complete)
  await download

  t.absent(exists(out + '.swarmwire-part'))
})

// ---------------------------------------------------------------------------
// Several peers
// ---------------------------------------------------------------------------

test('two seeders both contribute', async (t) => {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 300000)

  const one = node(t, net, 'one')
  const two = node(t, net, 'two')
  const leecher = node(t, net, 'leecher')

  const { link } = await one.serve(file)
  await two.serve(file) // the same content, independently addressed

  const download = leecher.download(link, path.join(dir, 'copy'))
  await settleUntil(net, () => download.complete)
  await download

  t.alike(read(path.join(dir, 'copy')), read(file))
  t.is(download.peersUsed.size, 2, 'groups came from both')
})

test('a peer that does not have the content is simply not used', async (t) => {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 70000)

  const seeder = node(t, net, 'seeder')
  const bystander = node(t, net, 'bystander')
  const leecher = node(t, net, 'leecher')

  const { link } = await seeder.serve(file)
  await bystander.serve(writeSample(dir, 'something-else', 50000))

  const download = leecher.download(link, path.join(dir, 'copy'))
  await settleUntil(net, () => download.complete)
  await download

  t.alike(read(path.join(dir, 'copy')), read(file))
  t.alike([...download.peersUsed], [idOf(seeder.swarm)])
})

// ---------------------------------------------------------------------------
// Peers behaving badly. This is what the whole verification layer is for.
// ---------------------------------------------------------------------------

test('a lying peer cannot corrupt the download, and the honest one finishes it', async (t) => {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 300000)

  const honest = node(t, net, 'honest')
  const leecher = node(t, net, 'leecher')

  const { link } = await honest.serve(file)

  // Claims to have it, answers every request with rubbish of exactly the right shape.
  const liarPeer = net.peer('liar').join(discoveryTopic(parseLink(link).root, parseLink(link).secret))
  const liar = attachLiar(liarPeer, { size: 300000 })

  const download = leecher.download(link, path.join(dir, 'copy'))
  await settleUntil(net, () => download.complete, { rounds: 400 })
  await download

  t.alike(read(path.join(dir, 'copy')), read(file), 'the file is correct')
  t.ok(liar.requests > 0, `the liar was asked ${liar.requests} times`)
  t.ok(download.rejected > 0, `${download.rejected} bad groups refused`)
  t.absent(download.peersUsed.has(idOf(liarPeer)), 'nothing it sent was used')
})

test('a liar is dropped rather than retried forever', async (t) => {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 300000)

  const honest = node(t, net, 'honest')
  const leecher = node(t, net, 'leecher')
  const { link } = await honest.serve(file)

  const liarPeer = net.peer('liar').join(discoveryTopic(parseLink(link).root, null))
  const liar = attachLiar(liarPeer, { size: 300000 })

  const download = leecher.download(link, path.join(dir, 'copy'))
  await settleUntil(net, () => download.complete, { rounds: 400 })
  await download

  // 19 groups: a liar that kept being asked would rack up far more than a window's worth.
  t.ok(liar.requests <= 8, `asked ${liar.requests} times, then dropped`)
})

test('a seeder that vanishes mid-transfer does not corrupt anything', async (t) => {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 300000)
  const out = path.join(dir, 'copy')

  const seeder = node(t, net, 'seeder')
  const leecher = node(t, net, 'leecher')

  const { link } = await seeder.serve(file)
  const download = leecher.download(link, out)

  // Step rather than settle: settling runs the transfer to a standstill, and the point here
  // is to pull the plug while it is still going.
  await stepUntil(net, () => download.have > 0 && download.have < download.total)
  const partial = download.have
  seeder.swarm.destroy()
  await net.settle()

  t.ok(partial > 0 && !download.complete, `stopped with ${partial}/${download.total} groups`)

  // What did arrive is verified and still on disk, ready to resume.
  t.ok(exists(out + '.swarmwire-part'))
  t.is(read(out).length, 300000)
})

test('a download resumes from what is already on disk', async (t) => {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 300000)
  const out = path.join(dir, 'copy')

  const seeder = node(t, net, 'seeder')
  const leecher = node(t, net, 'leecher')
  const { link } = await seeder.serve(file)

  const first = leecher.download(link, out)
  await stepUntil(net, () => first.have > 0 && first.have < first.total)
  const got = first.have
  await first.stop()

  const second = leecher.download(link, out)
  await second.ready()

  // At least what it had: stopping drains writes that were already in flight rather than
  // discarding a group that verified, so the resumed download may hold one or two more.
  t.ok(second.have >= got, `picked up ${second.have} groups, having stopped with ${got}`)
  t.ok(second.have < second.total, 'and it is genuinely a resume, not a finished download')

  await settleUntil(net, () => second.complete, { rounds: 400 })
  await second

  t.alike(read(out), read(file))
  t.ok(second.received < second.total, 'and did not re-download what it had')
})

// ---------------------------------------------------------------------------

function node (t, net, name) {
  const peer = net.peer(name)
  const sw = new Swarmwire({ swarm: peer })
  t.teardown(() => sw.destroy())
  return sw
}

async function twoPeers (t, size) {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', size)

  return { net, dir, file, seeder: node(t, net, 'seeder'), leecher: node(t, net, 'leecher') }
}

/**
 * Run the network until `done()`. A round is an attempt, not a unit of time: real file reads
 * resolve on their own schedule, so most rounds do nothing and the budget is generous.
 */
async function settleUntil (net, done, { rounds = 2000 } = {}) {
  for (let i = 0; i < rounds; i++) {
    if (done()) return
    await net.settle()
  }
  if (!done()) throw new Error('transfer did not finish')
}

/** Deliver one batch at a time, so the test can act in the middle of a transfer. */
async function stepUntil (net, done, { steps = 2000 } = {}) {
  for (let i = 0; i < steps; i++) {
    if (done()) return
    await net.step()
  }
  throw new Error('condition never held while stepping')
}

function idOf (peer) {
  return b4a.toString(b4a.from(peer.publicKey), 'hex')
}

function listing (dir) {
  return fs.readdirSync(dir).sort()
}
