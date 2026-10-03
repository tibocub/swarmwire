import test from 'brittle'
import b4a from 'b4a'
import Protomux from 'protomux'
import c from 'compact-encoding'

import { TestNetwork } from '../helpers/network.js'

const TOPIC = b4a.alloc(32, 1)
const OTHER_TOPIC = b4a.alloc(32, 2)

test('peers that join the same topic meet each other', async (t) => {
  const net = new TestNetwork()
  const alice = net.peer('alice').join(TOPIC)
  const bob = net.peer('bob').join(TOPIC)
  const carol = net.peer('carol').join(TOPIC)

  await net.settle()

  t.is(alice.connections.length, 2, 'alice sees bob and carol')
  t.is(bob.connections.length, 2)
  t.is(carol.connections.length, 2)
  t.alike(alice.connections[0].remotePublicKey, bob.publicKey, 'the remote key is on the stream')
})

test('peers on different topics never meet', async (t) => {
  const net = new TestNetwork()
  const alice = net.peer('alice').join(TOPIC)
  const stranger = net.peer('stranger').join(OTHER_TOPIC)

  await net.settle()

  t.is(alice.connections.length, 0)
  t.is(stranger.connections.length, 0)
})

test('a peer that joins late still meets the others', async (t) => {
  const net = new TestNetwork()
  const alice = net.peer('alice').join(TOPIC)
  await net.settle()
  t.is(alice.connections.length, 0, 'nobody to meet yet')

  const bob = net.peer('bob').join(TOPIC)
  await net.settle()

  t.is(alice.connections.length, 1)
  t.is(bob.connections.length, 1)
})

test('bytes written on one side arrive on the other', async (t) => {
  const net = new TestNetwork()
  const alice = net.peer('alice').join(TOPIC)
  const bob = net.peer('bob').join(TOPIC)

  const heard = collect(bob)
  await net.settle()

  alice.connections[0].write(b4a.from('hello'))
  await net.settle()

  t.alike(heard(), ['hello'])
})

test('nothing is delivered until the test says so', async (t) => {
  const net = new TestNetwork()
  const alice = net.peer('alice').join(TOPIC)
  const bob = net.peer('bob').join(TOPIC)

  const heard = collect(bob)
  await net.settle()

  alice.connections[0].write(b4a.from('hello'))
  await net.pump()

  t.is(net.inflight, 1, 'queued, not delivered')
  t.alike(heard(), [], 'bob has heard nothing')

  await net.settle()
  t.alike(heard(), ['hello'])
})

test('latency decides who arrives first', async (t) => {
  const net = new TestNetwork()
  const alice = net.peer('alice').join(TOPIC)
  const slow = net.peer('slow').join(TOPIC)
  const carol = net.peer('carol').join(TOPIC)

  net.link(slow, carol).setLatency(10)

  const heard = collect(carol)
  await net.settle()

  send(slow, 'carol', 'from the slow peer')
  send(alice, 'carol', 'from alice')
  await net.settle()

  t.alike(heard(), ['from alice', 'from the slow peer'], 'the slow peer lands last')
})

test('dropped frames are lost silently, and the same seed drops the same ones', async (t) => {
  const run = async () => {
    const net = new TestNetwork({ seed: 42 })
    const alice = net.peer('alice').join(TOPIC)
    const bob = net.peer('bob').join(TOPIC)
    net.link(alice, bob).setDropRate(0.5)

    const heard = collect(bob)
    await net.settle()

    for (let i = 0; i < 20; i++) send(alice, 'bob', 'frame ' + i)
    await net.settle()
    return heard()
  }

  const first = await run()
  t.ok(first.length > 0 && first.length < 20, `some frames lost (${first.length}/20 arrived)`)
  t.alike(await run(), first, 'deterministic: the same seed loses the same frames')
})

test('a lying peer can corrupt what it sends', async (t) => {
  const net = new TestNetwork()
  const mallory = net.peer('mallory').join(TOPIC)
  const bob = net.peer('bob').join(TOPIC)

  // This is what the transfer engine must catch: bytes that are not what was asked for.
  mallory.corruptOutgoing((data) => {
    const bad = b4a.from(data)
    bad[0] ^= 0xff
    return bad
  })

  const heard = collect(bob)
  await net.settle()

  send(mallory, 'bob', 'honest payload')
  await net.settle()

  t.not(heard()[0], 'honest payload')
  t.is(heard()[0].length, 'honest payload'.length, 'same length, wrong bytes')
})

test('a peer can swallow frames instead of answering', async (t) => {
  const net = new TestNetwork()
  const silent = net.peer('silent').join(TOPIC)
  const bob = net.peer('bob').join(TOPIC)
  silent.corruptOutgoing(() => null)

  const heard = collect(bob)
  await net.settle()

  send(silent, 'bob', 'never arrives')
  await net.settle()

  t.alike(heard(), [])
})

test('a peer that vanishes takes its connections with it', async (t) => {
  const net = new TestNetwork()
  const alice = net.peer('alice').join(TOPIC)
  const gone = net.peer('gone').join(TOPIC)

  let closed = false
  await net.settle()
  alice.connections[0].on('close', () => { closed = true })

  gone.destroy()
  await net.settle()

  t.ok(closed, 'the other side learns the connection is gone')
  t.is(alice.connections.length, 0)
  t.is(gone.connections.length, 0)
})

test('a partition loses frames without either side being told', async (t) => {
  const net = new TestNetwork()
  const alice = net.peer('alice').join(TOPIC)
  const bob = net.peer('bob').join(TOPIC)

  const heard = collect(bob)
  await net.settle()

  net.link(alice, bob).partition()
  send(alice, 'bob', 'into the void')
  await net.settle()

  t.alike(heard(), [])
  t.is(alice.connections.length, 1, 'alice still believes she is connected')
})

test('real protomux channels work over this transport', async (t) => {
  // The engine will speak protomux over whatever the swarm hands it. If the harness cannot
  // carry a real mux, testing against it proves nothing.
  const net = new TestNetwork()
  const alice = net.peer('alice').join(TOPIC)
  const bob = net.peer('bob').join(TOPIC)

  const received = []
  const open = (peer, onmessage) => {
    peer.on('connection', (stream) => {
      const mux = new Protomux(stream)
      const channel = mux.createChannel({ protocol: 'swarmwire/test' })
      channel.addMessage({ encoding: c.string, onmessage })
      channel.open()
      stream.channel = channel
    })
  }

  open(alice, () => {})
  open(bob, (message) => received.push(message))

  await net.settle()

  alice.connections[0].channel.messages[0].send('wire is up')
  await net.settle()

  t.alike(received, ['wire is up'])
})

test('settle refuses to spin forever', async (t) => {
  const net = new TestNetwork()
  const alice = net.peer('alice').join(TOPIC)
  const bob = net.peer('bob').join(TOPIC)

  await net.settle()

  // Two peers echoing each other: without a guard this never returns.
  for (const peer of [alice, bob]) {
    peer.connections[0].on('data', (data) => peer.connections[0].write(data))
  }

  alice.connections[0].write(b4a.from('ping'))
  await t.exception(net.settle({ maxRounds: 5 }), /did not settle/)
})

// ---------------------------------------------------------------------------

function collect (peer) {
  const seen = []
  const attach = (stream) => stream.on('data', (data) => seen.push(b4a.toString(data)))

  peer.on('connection', attach)
  for (const stream of peer.connections) attach(stream)

  return () => seen
}

function send (peer, to, message) {
  const stream = peer.connections.find((s) => s.remoteName === to)
  stream.write(b4a.from(message))
}
