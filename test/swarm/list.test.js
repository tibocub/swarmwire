/**
 * Reading what is in a folder without taking any of it.
 *
 * An application that wants to offer "pick the files you want" needs the list first, and
 * fetching the list must not fetch the files, write anything down, or make this machine look
 * like a provider of a folder it has not got.
 */

import test from 'brittle'
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'
import process from 'process'

import { Swarmwire } from '../../lib/swarmwire.js'
import { MemorySource } from '../../lib/source.js'
import { encodeManifest, MAX_MANIFEST_BYTES } from '../../lib/collection.js'
import { discoveryTopic, formatLink, parseLink } from '../../lib/address.js'
import { TestNetwork } from '../helpers/network.js'
import { attachLiar } from '../helpers/liar.js'
import { tmpdir, sample } from '../helpers/tmp.js'

test('a folder\'s list is read from its link alone', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = folder(dir, 'original', { 'a.txt': 400, 'photos/one.jpg': 70000, 'photos/two.jpg': 30000 })
  const { link, files } = await sender.serveCollection(source)
  t.is(files, 3)

  const requests = recordRequests(sender)
  const before = [listing(dir), fs.readdirSync(process.cwd()).sort()]

  const result = await drive(net, () => receiver.readList(link))

  t.alike(result.files.map(({ path, size }) => [path, size]), [
    ['a.txt', 400],
    ['photos/one.jpg', 70000],
    ['photos/two.jpg', 30000]
  ])
  t.is(result.size, 100400)
  t.ok(result.files.every((file) => /^[0-9a-f]{64}$/.test(file.root)))

  const manifest = parseLink(link).root
  t.ok(requests.length > 0)
  t.ok(requests.every((request) => request.startsWith(manifest)), 'only the list was requested, no file')
  t.alike([listing(dir), fs.readdirSync(process.cwd()).sort()], before, 'nothing was written')
})

test('a folder can be served from an explicit list of files', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = folder(dir, 'original', { 'a.txt': 400, 'photos/one.jpg': 70000 })
  const { link, files } = await sender.serveCollection(null, {
    name: 'original',
    files: [{ path: 'a.txt', from: path.join(source, 'a.txt') }, { path: 'photos/one.jpg', from: path.join(source, 'photos/one.jpg') }]
  })
  t.is(files, 2)

  const result = await drive(net, () => receiver.readList(link))
  t.alike(result.files.map(({ path, size }) => [path, size]), [['a.txt', 400], ['photos/one.jpg', 70000]])
})

test('a link to a single file is not a folder', async (t) => {
  const { dir, sender, receiver } = setup(t)
  const file = path.join(dir, 'one.bin')
  fs.writeFileSync(file, sample(100))
  const { link } = await sender.serve(file)

  await t.exception(async () => receiver.readList(link), /not a folder/)
})

test('a list with an unsafe path is refused, not repaired', async (t) => {
  const entry = (p) => ({ path: p, root: 'a'.repeat(64), size: 1 })
  const bad = {
    absolute: [entry('/etc/passwd')],
    parent: [entry('../escape')],
    'drive letter': [entry('C:/windows')],
    duplicate: [entry('same.txt'), entry('same.txt')]
  }

  for (const [name, files] of Object.entries(bad)) {
    const { net, sender, receiver } = setup(t, name)
    const raw = b4a.from(JSON.stringify({ swarmwire: 'collection/v0', files }), 'utf8')
    const link = serveRaw(sender, raw)

    await t.exception(drive(net, () => receiver.readList(link)), /unsafe path|duplicate path/, name)
  }
})

test('a peer sending the wrong list gains nothing, and an honest one still supplies it', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = folder(dir, 'original', { 'a.txt': 100, 'b.txt': 200 })
  const { link } = await sender.serveCollection(source)
  const { root, size, secret } = parseLink(link)

  const liarPeer = net.peer('liar').join(discoveryTopic(root, secret))
  attachLiar(liarPeer, { size })

  const result = await drive(net, () => receiver.readList(link))

  t.alike(result.files.map((f) => f.path), ['a.txt', 'b.txt'])
})

test('with nobody to ask it waits, and can be told to stop', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = folder(dir, 'original', { 'a.txt': 100 })
  const { link } = await sender.serveCollection(source)
  await sender.destroy() // the only provider is gone

  const reading = receiver.readList(link)
  let settled = false
  reading.then(() => { settled = true })

  await net.settle()
  t.absent(settled, 'still waiting')

  await reading.stop()
  await reading
  t.ok(true, 'the awaited read settles once stopped')
})

test('a reader looks for the folder without announcing itself', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = folder(dir, 'original', { 'a.txt': 100 })
  const { link } = await sender.serveCollection(source)

  const topic = discoveryTopic(parseLink(link).root, parseLink(link).secret)
  const key = b4a.toString(topic, 'hex')

  // Another peer that is only looking. If the reader announced, this one would find it.
  const other = net.peer('other')
  other.join(topic, { server: false, client: true })
  const met = []
  other.on('connection', (stream, info) => met.push(info.name))

  const reading = receiver.readList(link)
  await drive(net, () => reading)

  t.alike(met, ['sender'], 'it found the sender and nobody else')
  t.absent(receiver.swarm.serves(key), 'the reader never announced')
  t.absent(receiver.swarm.topics.has(key), 'and left the topic when it was done')
})

test('an empty folder has an empty list', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const { link } = await sender.serveCollection(folder(dir, 'empty', {}))

  const result = await drive(net, () => receiver.readList(link))
  t.alike(result, { files: [], size: 0 })
})

test('a folder of twenty thousand files comes back whole', async (t) => {
  const { net, sender, receiver } = setup(t)
  const entries = []
  for (let i = 0; i < 20000; i++) entries.push({ path: `d${i % 50}/f${i}.bin`, root: 'b'.repeat(64), size: i })

  const link = serveRaw(sender, encodeManifest(entries))
  const result = await drive(net, () => receiver.readList(link))

  t.is(result.files.length, 20000)
  t.is(result.size, entries.reduce((sum, e) => sum + e.size, 0))
})

test('a list claiming to be enormous is refused before anything is allocated', async (t) => {
  const { net, receiver } = setup(t)
  const link = formatLink({ root: 'a'.repeat(64), size: MAX_MANIFEST_BYTES + 1, type: 'collection' })

  await t.exception(drive(net, () => receiver.readList(link)), /implausibly large/)
})

test('reading the list while downloading the folder fetches the list once', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = folder(dir, 'original', { 'a.txt': 100, 'b.txt': 200 })
  const { link } = await sender.serveCollection(source)
  const requests = recordRequests(sender)

  const manifest = parseLink(link).root
  const [listed, got] = await drive(net, () => Promise.all([
    receiver.readList(link),
    receiver.downloadCollection(link, path.join(dir, 'received'))
  ]))

  t.is(listed.files.length, 2)
  t.is(got.files, 2)

  const lists = requests.filter((request) => request.startsWith(manifest))
  t.is(new Set(lists).size, lists.length, 'no group of the list was requested twice')
})

test('once the list is known the folder can be counted', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = folder(dir, 'original', { 'a.txt': 100, 'b.txt': 200 })
  const { link } = await sender.serveCollection(source)

  t.alike(receiver.counts(link), { peers: 0, seeders: 0, leechers: 0 }, 'before: nobody, no list')

  await drive(net, () => receiver.readList(link))
  await net.settle()

  t.alike(receiver.counts(link), { peers: 1, seeders: 1, leechers: 0 })
})

test('two chosen files of five arrive intact and the others are never requested', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const names = { 'a.bin': 50000, 'b.bin': 60000, 'c.bin': 70000, 'd.bin': 80000, 'e.bin': 90000 }
  const source = folder(dir, 'original', names)
  const { link } = await sender.serveCollection(source)
  const requests = recordRequests(sender)

  const { files } = await drive(net, () => receiver.readList(link))
  const chosen = files.filter((file) => ['b.bin', 'd.bin'].includes(file.path))
  const unchosen = files.filter((file) => !chosen.includes(file))

  for (const file of chosen) {
    const out = path.join(dir, 'got-' + file.path)
    await drive(net, () => receiver.downloadFile(link, file, out))
    t.alike(fs.readFileSync(out), fs.readFileSync(path.join(source, file.path)), file.path)
  }

  const asked = (file) => requests.filter((request) => request.startsWith(file.root))
  t.ok(chosen.every((file) => asked(file).length > 0), 'the chosen files were requested')
  t.alike(unchosen.map((file) => asked(file).length), [0, 0, 0], 'the others never were')

  const { secret } = parseLink(link)
  const joined = chosen.map((file) => b4a.toString(discoveryTopic(file.root, secret), 'hex'))
  t.ok(joined.every((key) => !receiver.swarm.topics.has(key)), 'not announced on their own')
})

test('a chosen file that was partly fetched resumes where it stopped', async (t) => {
  const { net, dir, sender } = setup(t)
  const receiver = new Swarmwire({ swarm: net.peer('slow'), window: 2 })
  t.teardown(() => receiver.destroy())

  const source = folder(dir, 'original', { 'big.bin': 400000 })
  const { link } = await sender.serveCollection(source)
  const { files } = await drive(net, () => receiver.readList(link))

  const out = path.join(dir, 'got.bin')
  const first = receiver.downloadFile(link, files[0], out)
  await first.ready()
  for (let i = 0; i < 2000 && !(first.have > 0 && first.have < first.total); i++) await net.step()
  t.ok(first.have > 0 && first.have < first.total, `stopped holding ${first.have}/${first.total}`)

  const held = new Set()
  for (let i = 0; i < first.total; i++) if (first.bitfield()[i >> 3] & (1 << (i & 7))) held.add(i)
  await first.stop()

  const requests = recordRequests(sender)
  await drive(net, () => receiver.downloadFile(link, files[0], out))

  const again = requests
    .filter((request) => request.startsWith(files[0].root))
    .map((request) => Number(request.split(':')[1]))
  t.ok(again.length > 0)
  t.ok(again.every((index) => !held.has(index)), 'nothing it already held was asked for again')
  t.alike(fs.readFileSync(out), fs.readFileSync(path.join(source, 'big.bin')))
})

// -- helpers ----------------------------------------------------------------

function setup (t, label = '') {
  const net = new TestNetwork()
  const dir = tmpdir(t)

  const sender = new Swarmwire({ swarm: net.peer('sender' + label) })
  const receiver = new Swarmwire({ swarm: net.peer('receiver' + label) })

  t.teardown(() => sender.destroy())
  t.teardown(() => receiver.destroy())

  return { net, dir, sender, receiver }
}

function folder (dir, name, files) {
  const root = path.join(dir, name)
  fs.mkdirSync(root, { recursive: true })

  for (const [relative, size] of Object.entries(files)) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, sample(size))
  }

  return root
}

function listing (dir) {
  const out = []

  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative)
      else out.push(relative)
    }
  }

  walk(dir, '')
  return out.sort()
}

/** Serve bytes as a folder's list exactly as given, however unwise they are. */
function serveRaw (node, bytes) {
  const source = MemorySource.from(bytes, { groupLog: node.groupLog })
  node.serving.set(source.root, source)
  node.swarm.join(discoveryTopic(source.root, null))

  return formatLink({ root: source.root, size: source.size, type: 'collection' })
}

/** Which groups of which content this node was asked for, as `root:index`. */
function recordRequests (node) {
  const seen = []
  const original = node._onRequest.bind(node)

  node._onRequest = (id, message) => {
    seen.push(b4a.toString(message.root, 'hex') + ':' + message.index)
    return original(id, message)
  }

  return seen
}

/** Run the network while an operation runs against it. */
async function drive (net, operation) {
  let done = false
  const result = operation().finally(() => { done = true })
  result.catch(() => {}) // the caller sees the rejection; this only keeps it from being unhandled

  for (let i = 0; i < 5000 && !done; i++) await net.settle()

  return result
}
