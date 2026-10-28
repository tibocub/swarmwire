/**
 * Who is connected, and what they hold.
 *
 * An application showing "3 peers, 1 seeding" needs to be told when that changes, and a node
 * that only serves never asks anyone for anything, so it has to learn what its peers hold
 * without being asked. All of it is counted over direct connections: there is no tracker here.
 */

import test from 'brittle'
import b4a from 'b4a'
import { Duplex } from 'streamx'
import Protomux from 'protomux'
import fs from 'fs'
import path from 'path'

import { Swarmwire } from '../../lib/swarmwire.js'
import { openChannel, VERSION } from '../../lib/wire.js'
import { discoveryTopic, parseLink } from '../../lib/address.js'
import { DEFAULT_GROUP_LOG, groupCount, groupLength } from '../../lib/tree.js'
import { bao } from '../../lib/blake3.js'
import { TestNetwork } from '../helpers/network.js'
import { tmpdir, writeSample, sample } from '../helpers/tmp.js'

const GROUP = groupLength(DEFAULT_GROUP_LOG)

test('a peer is announced once it connects, and once it leaves', async (t) => {
  const { net, sender, topic, events } = setup(t)

  const a = holder(net, 'a', topic, {})
  const b = holder(net, 'b', topic, {})
  await net.settle()

  t.alike(events, [['+', idOf(a)], ['+', idOf(b)]], 'in the order they arrived')
  t.is(sender.peerCount, 2)

  a.destroy() // power cut: no goodbye
  await net.settle()

  t.alike(events.slice(2), [['-', idOf(a)]])
  t.is(sender.peerCount, 1)
})

test('the count is already right when the departure is announced', async (t) => {
  const { net, sender, topic } = setup(t)
  const seen = []
  sender.on('peer-disconnected', () => seen.push(sender.peerCount))

  holder(net, 'a', topic, {})
  const b = holder(net, 'b', topic, {})
  await net.settle()

  b.destroy()
  await net.settle()

  t.alike(seen, [1])
})

test('a closed connection is announced like a lost peer', async (t) => {
  const { net, sender, topic, events } = setup(t)

  const a = holder(net, 'a', topic, {})
  await net.settle()

  for (const stream of sender.swarm.connections) stream.destroy()
  await net.settle()

  t.alike(events, [['+', idOf(a)], ['-', idOf(a)]])
  t.is(sender.peerCount, 0)
})

test('something that never speaks the protocol is neither announced nor counted', async (t) => {
  const { net, sender, topic, events } = setup(t)

  const mute = net.peer('mute') // connects, says nothing
  mute.join(topic)
  await net.settle()

  t.is(sender.peerCount, 0)

  mute.destroy()
  await net.settle()

  t.alike(events, [], 'no connect and no disconnect')
})

test('two connections from one peer are one peer', async (t) => {
  const { sender, events } = setup(t)
  const key = b4a.alloc(32, 7)

  const first = remote(sender, key)
  await settleStreams()
  const second = remote(sender, key)
  await settleStreams()

  t.is(sender.peerCount, 1)
  t.is(events.length, 1, 'announced once')

  first.destroy() // the stale connection goes first
  await settleStreams()

  t.is(sender.peerCount, 1, 'the live connection is still there')
  t.is(events.length, 1, 'and nobody was told it left')

  second.destroy()
  await settleStreams()

  t.is(sender.peerCount, 0)
  t.alike(events.map((e) => e[0]), ['+', '-'])
})

test('a stream handed to one side later than the other still connects', async (t) => {
  // An app that muxes the stream itself (hypergraph's member streams) hands it to each side
  // at its own moment: the first side's open arrives before the second side is listening.
  const net = new TestNetwork()
  const a = new Swarmwire({ swarm: net.peer('a') })
  const b = new Swarmwire({ swarm: net.peer('b') })
  t.teardown(() => Promise.all([a.destroy(), b.destroy()]))

  const [sa, sb] = pair()
  sa.userData = sb.userData = null // like Hyperswarm's streams: Protomux.from keeps one mux per stream
  Protomux.from(sa)
  Protomux.from(sb)
  t.teardown(() => { sa.destroy(); sb.destroy() })

  a._onPeer(sa, { publicKey: b4a.alloc(32, 2) })
  await settleStreams()
  b._onPeer(sb, { publicKey: b4a.alloc(32, 1) })
  await settleStreams()

  t.is(a.peerCount, 1)
  t.is(b.peerCount, 1)
})

test('seeders, leechers, and a peer that has said nothing', async (t) => {
  const { net, dir, sender } = setup(t)
  const file = writeSample(dir, 'file', 8 * GROUP - 5)
  const { link, size } = await sender.serve(file)
  const groups = groupCount(size, DEFAULT_GROUP_LOG)

  const all = range(groups)
  const t1 = topicOf(link)

  holder(net, 'seed', t1, { [parseLink(link).root]: { size, held: all } })
  holder(net, 'half', t1, { [parseLink(link).root]: { size, held: all.slice(0, groups / 2) } })

  // A real node with nothing: it answers "unavailable", and is a peer all the same.
  const quiet = new Swarmwire({ swarm: net.peer('quiet') })
  quiet.swarm.join(t1)
  t.teardown(() => quiet.destroy())

  await net.settle()

  t.alike(sender.counts(link), { peers: 3, seeders: 1, leechers: 1 })
})

test('a leecher that finishes becomes a seeder and the total does not move', async (t) => {
  const { net, dir, sender } = setup(t)
  const file = writeSample(dir, 'file', 20 * GROUP)
  const { link } = await sender.serve(file)

  const late = new Swarmwire({ swarm: net.peer('late'), window: 2 })
  t.teardown(() => late.destroy())
  const got = late.download(link, path.join(dir, 'late'))

  let midway = null
  for (let i = 0; i < 2000 && !midway; i++) {
    await net.step()
    const counts = sender.counts(link)
    if (counts.leechers === 1) midway = counts
  }
  t.alike(midway, { peers: 1, seeders: 0, leechers: 1 })

  await settleUntil(net, () => got.complete)
  await got
  await net.settle()

  t.alike(sender.counts(link), { peers: 1, seeders: 1, leechers: 0 })
})

test('a peer that leaves stops counting at once', async (t) => {
  const { net, dir, sender } = setup(t)
  const file = writeSample(dir, 'file', 4 * GROUP)
  const { link, size } = await sender.serve(file)
  const root = parseLink(link).root

  const seed = holder(net, 'seed', topicOf(link), { [root]: { size, held: range(4) } })
  await net.settle()
  t.alike(sender.counts(link), { peers: 1, seeders: 1, leechers: 0 })

  seed.destroy()
  await net.settle()

  t.alike(sender.counts(link), { peers: 0, seeders: 0, leechers: 0 })
})

test('content nobody asked about counts as zeros, not an error', async (t) => {
  const { net, sender, topic } = setup(t)
  holder(net, 'a', topic, {})
  await net.settle()

  const unknown = { root: 'f'.repeat(64), size: 10, secret: null, name: null }
  t.alike(sender.counts(unknown), { peers: 1, seeders: 0, leechers: 0 })
})

test('a folder seeder holds the list and every file; the list alone is a leecher', async (t) => {
  const { net, dir, sender } = setup(t)
  const source = path.join(dir, 'folder')
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, 'a.bin'), sample(3 * GROUP))
  fs.writeFileSync(path.join(source, 'b.bin'), sample(GROUP + 10))

  const { link } = await sender.serveCollection(source)
  const manifest = parseLink(link).root
  const everything = {}
  for (const [root, content] of sender.serving) {
    everything[root] = { size: content.size, held: range(groupCount(content.size, DEFAULT_GROUP_LOG)) }
  }

  const topic = topicOf(link)
  holder(net, 'seed', topic, everything)
  holder(net, 'list-only', topic, { [manifest]: everything[manifest] })
  await net.settle()

  t.alike(sender.counts(link), { peers: 2, seeders: 1, leechers: 1 })
})

// -- helpers ----------------------------------------------------------------

function setup (t) {
  const net = new TestNetwork()
  const dir = tmpdir(t)
  const sender = new Swarmwire({ swarm: net.peer('sender') })
  t.teardown(() => sender.destroy())

  const events = []
  sender.on('peer-connected', ({ id }) => events.push(['+', id]))
  sender.on('peer-disconnected', ({ id }) => events.push(['-', id]))

  // A topic to meet on when a test serves nothing.
  const topic = discoveryTopic('e'.repeat(64), null)
  sender.swarm.join(topic)

  return { net, dir, sender, events, topic }
}

/**
 * A peer that speaks the protocol and holds exactly what it is told to, so a test can set up
 * "half of this file" without running a download to the right place and stopping it there.
 */
function holder (net, name, topic, holdings) {
  const peer = net.peer(name)

  peer.on('connection', (stream) => {
    const channel = openChannel(stream, {
      onwant: ({ root }) => {
        const rootHex = b4a.toString(root, 'hex')
        const held = holdings[rootHex]
        if (!held) return channel.send.unavailable({ root })

        const groups = groupCount(held.size, DEFAULT_GROUP_LOG)
        const bits = bao.createBitfield(groups)
        for (const i of held.held) bao.setBit(bits, i)
        channel.send.have({ root, size: held.size, groupLog: DEFAULT_GROUP_LOG, bitfield: bits })
      }
    })

    channel?.send.handshake({ version: VERSION, groupLog: DEFAULT_GROUP_LOG })
  })

  peer.join(topic)
  return peer
}

/** A connection handed straight to the node, for cases the test network cannot produce. */
function remote (node, key) {
  const [local, far] = pair()
  node._onPeer(local, { publicKey: key })

  const channel = openChannel(far, {})
  channel.send.handshake({ version: VERSION, groupLog: node.groupLog })

  return local
}

function pair () {
  const a = new Duplex({ write (data, cb) { b.push(data); cb() } })
  const b = new Duplex({ write (data, cb) { a.push(data); cb() } })
  return [a, b]
}

const idOf = (peer) => b4a.toString(peer.publicKey, 'hex')
const topicOf = (link) => discoveryTopic(parseLink(link).root, parseLink(link).secret)
const range = (n) => Array.from({ length: n }, (_, i) => i)

async function settleStreams () {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function settleUntil (net, done) {
  // By time, not rounds: a round is one event-loop turn, and real disk I/O can outlast thousands.
  for (const end = Date.now() + 20000; Date.now() < end;) {
    if (done()) return
    await net.settle()
  }
  throw new Error('condition never held')
}
