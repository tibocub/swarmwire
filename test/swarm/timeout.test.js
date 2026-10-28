/**
 * Peers that go quiet.
 *
 * A peer that accepts a request and never answers is worse than one that refuses: it holds a
 * group nobody else is fetching, and the download waits forever. These tests wind the clock by
 * hand, so "the request timed out" is a fact rather than a race.
 */

import test from 'brittle'
import path from 'path'

import { Swarmwire } from '../../lib/swarmwire.js'
import { ContentSource } from '../../lib/source.js'
import { discoveryTopic, parseLink, formatLink } from '../../lib/address.js'
import { TestNetwork } from '../helpers/network.js'
import { TestClock } from '../helpers/clock.js'
import { attachSilent } from '../helpers/liar.js'
import { tmpdir, writeSample, read } from '../helpers/tmp.js'

const TIMEOUT = 5000

test('a silent peer cannot stall a download that has another source', async (t) => {
  const { net, clock, dir, file, link, leecher } = await scenario(t, 300000)
  const silent = addSilent(net, link, 300000)

  const download = leecher.download(link, path.join(dir, 'copy'))
  await run(net, clock, download)

  t.ok(download.complete, 'finished from the honest peer')
  t.ok(silent.requests > 0, `the silent peer was asked ${silent.requests} times`)
  t.ok(download.timedOut > 0, `${download.timedOut} requests timed out and were reassigned`)
  t.alike(read(path.join(dir, 'copy')), read(file))
})

test('requests to a silent peer are given back to the pool', async (t) => {
  const net = new TestNetwork()
  const clock = new TestClock()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 300000)

  // Nobody honest is in this swarm: the only peer answers `have` and then nothing at all.
  const link = await linkOnly(t, file)
  const silent = addSilent(net, link, 300000)

  const leecher = node(t, net, clock, 'leecher')
  const download = leecher.download(link, path.join(dir, 'copy'))
  await until(net, () => download.inflight > 0)

  const stuck = download.inflight
  t.ok(stuck > 0, `${stuck} requests outstanding`)
  t.is(download.timedOut, 0, 'nothing has timed out yet')

  clock.advance(TIMEOUT + 1)
  await net.settle()

  t.is(download.have, 0, 'still nothing, because no honest peer exists')
  t.is(download.timedOut, stuck, 'but every request was given up on rather than left hanging')
  t.ok(silent.requests >= stuck)
})

test('a peer that keeps timing out stops being asked', async (t) => {
  const net = new TestNetwork()
  const clock = new TestClock()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 300000)

  const link = await linkOnly(t, file)
  const silent = addSilent(net, link, 300000)

  const leecher = node(t, net, clock, 'leecher')
  const download = leecher.download(link, path.join(dir, 'copy'))

  await until(net, () => silent.requests > 0)
  const firstRound = silent.requests
  t.ok(firstRound > 0, `asked ${firstRound} times to begin with`)

  // Three strikes and it is dropped, so the asking stops instead of repeating forever.
  for (let i = 0; i < 6; i++) {
    clock.advance(TIMEOUT + 1)
    await net.settle()
  }

  t.ok(silent.requests < firstRound * 4, `asked ${silent.requests} times in total, then dropped`)
  t.is(download.inflight, 0, 'nothing left reserved by a peer that never answers')
  t.absent(download.complete, 'and the download is honestly unfinished, not falsely done')
})

test('a peer that answers in time is never timed out', async (t) => {
  const { net, clock, dir, file, link, leecher } = await scenario(t, 100000)

  const download = leecher.download(link, path.join(dir, 'copy'))
  await until(net, () => download.complete)

  t.is(download.timedOut, 0)
  t.alike(read(path.join(dir, 'copy')), read(file))
})

test('no timer is left waiting once a download ends', async (t) => {
  const { net, clock, dir, link, leecher } = await scenario(t, 100000)

  const download = leecher.download(link, path.join(dir, 'copy'))
  await until(net, () => download.complete)

  // Await the download itself, not just the last group: `complete` flips when the final group
  // lands on disk, while the tidying up happens as the download settles.
  await download

  t.is(clock.waiting, 0)
})

test('when every connected peer says it does not hold it, the download says stalled at once', async (t) => {
  const net = new TestNetwork()
  const clock = new TestClock()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', 50000)
  const other = writeSample(dir, 'other', 40000) // samples of one size are the same bytes

  // Two peers on the topic, neither holding the content: one serves something else there.
  const link = await linkOnly(t, file)
  const { root, secret } = parseLink(link)
  for (const name of ['a', 'b']) {
    const sw = node(t, net, clock, name)
    await sw.serve(other)
    net.peers.get(name).join(discoveryTopic(root, secret))
  }

  const download = node(t, net, clock, 'leecher').download(link, path.join(dir, 'copy'))
  let stalled = 0
  download.on('stalled', () => stalled++)
  await until(net, () => stalled > 0)

  t.is(clock.now, 0, 'without waiting for any timeout')
  t.is(download.have, 0)
  await download.stop()
})

// ---------------------------------------------------------------------------

function node (t, net, clock, name) {
  const sw = new Swarmwire({
    swarm: net.peer(name),
    timers: clock,
    requestTimeout: TIMEOUT,
    // Shallow on purpose: with the default window one peer claims every group of a small
    // file, and a test about what happens when a peer goes quiet needs it to be asked.
    window: 2
  })

  t.teardown(() => sw.destroy())
  return sw
}

/** An honest seeder, and the link to what it serves. */
async function linkFor (t, net, clock, file, name = 'source') {
  const source = node(t, net, clock, name)
  return source.serve(file)
}

/** A link to content that exists on disk but which no honest peer is serving. */
async function linkOnly (t, file) {
  const source = await ContentSource.open(file)
  t.teardown(() => source.close())

  return formatLink({ root: source.root, size: source.size })
}

function addSilent (net, link, size) {
  const { root, secret } = parseLink(link)
  const peer = net.peer('silent').join(discoveryTopic(root, secret))
  return attachSilent(peer, { size })
}

async function scenario (t, size) {
  const net = new TestNetwork()
  const clock = new TestClock()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'original', size)

  const { link } = await linkFor(t, net, clock, file)

  return { net, clock, dir, file, link, leecher: node(t, net, clock, 'leecher') }
}

/** Deliver everything until the condition holds, without touching the clock. */
async function until (net, done) {
  // By time, not rounds: a round is one event-loop turn, and real disk I/O can outlast thousands.
  for (const end = Date.now() + 20000; Date.now() < end;) {
    if (done()) return
    await net.settle()
  }
  throw new Error('condition never held')
}

/**
 * Run a download to completion, moving the clock only when a round delivered nothing new.
 * Advancing it every round would time out honest peers whose answer is still in flight,
 * which would be a fact about the test rather than about the code.
 */
async function run (net, clock, download, { rounds = 2000 } = {}) {
  let last = -1

  for (let i = 0; i < rounds; i++) {
    if (download.complete) return

    await net.settle()

    if (download.have === last) clock.advance(TIMEOUT + 1)
    last = download.have
  }

  throw new Error(`never finished: ${download.have}/${download.total}`)
}
