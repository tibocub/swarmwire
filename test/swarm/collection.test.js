/**
 * Folders.
 *
 * A collection is a manifest of content addresses, and the manifest is itself content — so
 * sharing a folder is sharing one link, and nothing is written next to the folder to do it.
 */

import test from 'brittle'
import fs from 'fs'
import path from 'path'

import { Swarmwire } from '../../lib/swarmwire.js'
import { decodeManifest } from '../../lib/collection.js'
import { TestNetwork } from '../helpers/network.js'
import { tmpdir, sample, read } from '../helpers/tmp.js'

test('a folder crosses as one link', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = folder(dir, 'original', {
    'notes.txt': 400,
    'photos/one.jpg': 70000,
    'photos/holiday/two.jpg': 30000
  })

  const { link, files } = await sender.serveCollection(source)
  t.is(files, 3)

  const out = path.join(dir, 'received')
  const result = await drive(net, () => receiver.downloadCollection(link, out))

  t.is(result.files, 3)
  t.alike(listing(out), ['notes.txt', 'photos/holiday/two.jpg', 'photos/one.jpg'])

  for (const relative of listing(out)) {
    t.alike(read(path.join(out, relative)), read(path.join(source, relative)), relative)
  }
})

test('sharing a folder does not change it', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = folder(dir, 'original', { 'a.txt': 100, 'b/c.txt': 200 })
  const before = listing(source)

  const { link } = await sender.serveCollection(source)
  await drive(net, () => receiver.downloadCollection(link, path.join(dir, 'received')))

  t.alike(listing(source), before, 'no manifest file, no sidecar, nothing')
})

test('the manifest is content like anything else', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = folder(dir, 'original', { 'a.txt': 100 })

  const { link, root } = await sender.serveCollection(source)

  // Fetched as a plain file, the link yields the manifest itself.
  const out = path.join(dir, 'manifest.json')
  const download = receiver.download(link, out)
  await drive(net, () => download)

  const files = decodeManifest(read(out))
  t.is(files.length, 1)
  t.is(files[0].path, 'a.txt')
  t.is(files[0].size, 100)
  t.ok(root.length === 64)
})

test('an empty folder is a valid, if dull, collection', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = folder(dir, 'empty', {})

  const { link, files } = await sender.serveCollection(source)
  t.is(files, 0)

  const out = path.join(dir, 'received')
  const result = await drive(net, () => receiver.downloadCollection(link, out))

  t.is(result.files, 0)
  t.alike(listing(out), [])
})

test('identical files in a folder are stored once and still arrive twice', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = path.join(dir, 'original')
  fs.mkdirSync(path.join(source, 'copies'), { recursive: true })
  fs.writeFileSync(path.join(source, 'copies/first.bin'), sample(5000))
  fs.writeFileSync(path.join(source, 'copies/second.bin'), sample(5000))

  const { link } = await sender.serveCollection(source)
  const out = path.join(dir, 'received')
  await drive(net, () => receiver.downloadCollection(link, out))

  t.alike(read(path.join(out, 'copies/first.bin')), read(path.join(out, 'copies/second.bin')))
  t.alike(read(path.join(out, 'copies/first.bin')), read(path.join(source, 'copies/first.bin')))
})

test('progress is reported file by file', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = folder(dir, 'original', { 'a.txt': 100, 'b.txt': 200, 'c.txt': 300 })

  const { link } = await sender.serveCollection(source)
  const seen = []

  await drive(net, () => receiver.downloadCollection(link, path.join(dir, 'received'), {
    onfile: (file) => seen.push(file.path)
  }))

  t.alike(seen, ['a.txt', 'b.txt', 'c.txt'])
})

test('byte progress covers the whole folder, from nothing to everything', async (t) => {
  const { net, dir, sender, receiver } = setup(t)
  const source = folder(dir, 'original', { 'a.bin': 70000, 'b.bin': 100, 'c.bin': 40000 })

  const { link } = await sender.serveCollection(source)
  const seen = []

  await drive(net, () => receiver.downloadCollection(link, path.join(dir, 'received'), {
    onprogress: (progress) => seen.push(progress)
  }))

  t.alike(seen[0], { bytes: 0, total: 110100 }, 'the total is known before the first byte')
  t.alike(seen.at(-1), { bytes: 110100, total: 110100 })
  t.ok(seen.every((p, i) => i === 0 || p.bytes >= seen[i - 1].bytes), 'never goes backwards')
})

// ---------------------------------------------------------------------------

function setup (t) {
  const net = new TestNetwork()
  const dir = tmpdir(t)

  const sender = new Swarmwire({ swarm: net.peer('sender') })
  const receiver = new Swarmwire({ swarm: net.peer('receiver') })

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

/**
 * Run the network while an operation runs against it. The collection API awaits each file in
 * turn, so the test cannot settle between steps the way single transfers do.
 */
async function drive (net, operation) {
  let done = false
  const result = operation().finally(() => { done = true })

  // By time, not rounds: a round is one event-loop turn, and real disk I/O can outlast thousands.
  for (const end = Date.now() + 20000; !done && Date.now() < end;) await net.settle()

  return result
}
