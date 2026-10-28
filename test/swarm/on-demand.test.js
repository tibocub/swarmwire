/**
 * Serving what a device holds without announcing or opening any of it up front.
 *
 * The application owns the connections (here: one topic it joins itself, standing in for a
 * workspace) and hands swarmwire a network whose `join` goes nowhere. Files are found through
 * `resolve(root)` only when a connected peer asks for them.
 */

import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import b4a from 'b4a'

import { Swarmwire } from '../../lib/swarmwire.js'
import { ContentSource } from '../../lib/source.js'
import { formatLink } from '../../lib/address.js'
import { TestNetwork } from '../helpers/network.js'
import { TestClock } from '../helpers/clock.js'
import { tmpdir, writeSample, read, exists } from '../helpers/tmp.js'

const SPACE = b4a.alloc(32, 7) // the one topic the application joins for the whole workspace

test('a file is opened only when a peer asks for it, and arrives intact', async (t) => {
  const { net, dir, make } = setup(t)
  const file = writeSample(dir, 'held', 70000)
  const link = await linkTo(t, file)

  const asked = []
  const holder = make('holder', { resolve: (root) => { asked.push(root); return file } })
  const fetcher = make('fetcher')

  t.is(asked.length, 0, 'nothing resolved before anyone asks')
  t.is(holder.serving.size, 0, 'and nothing served up front')

  const download = fetcher.download(link, path.join(dir, 'copy'))
  await settleUntil(net, () => download.complete)
  await download

  t.alike(read(path.join(dir, 'copy')), read(file))
  t.is(new Set(asked).size, 1, 'resolved for the one root asked for')
})

test('an asynchronous resolver works the same', async (t) => {
  const { net, dir, make } = setup(t)
  const file = writeSample(dir, 'held', 40000)
  const link = await linkTo(t, file)

  make('holder', { resolve: async () => file })
  const download = make('fetcher').download(link, path.join(dir, 'copy'))
  await settleUntil(net, () => download.complete)
  await download

  t.alike(read(path.join(dir, 'copy')), read(file))
})

test('a file that changed since it was recorded is answered as not held', async (t) => {
  const { net, dir, make } = setup(t)
  const file = writeSample(dir, 'held', 40000)
  const link = await linkTo(t, file)
  fs.writeFileSync(file, b4a.alloc(40000, 1)) // same size, other bytes
  fs.utimesSync(file, 1, 1) // and surely another mtime: the hash cache keys on it, to the millisecond

  make('holder', { resolve: () => file })
  const fetcher = make('fetcher')
  const download = fetcher.download(link, path.join(dir, 'copy'))

  let stalled = 0
  download.on('stalled', () => stalled++)
  await settleUntil(net, () => stalled > 0)

  t.is(download.have, 0, 'not one byte of the changed file was taken')
  t.is(download.rejected, 0, 'and none was even offered')
  t.ok(stalled > 0, 'the fetch learned at once that nobody holds it')
})

test('a resolver that says null, or throws, means not held', async (t) => {
  for (const resolve of [() => null, () => { throw new Error('no') }, async () => { throw new Error('no') }]) {
    const { net, dir, make } = setup(t)
    const file = writeSample(dir, 'held', 20000)
    const link = await linkTo(t, file)

    make('holder', { resolve })
    const download = make('fetcher').download(link, path.join(dir, 'copy'))
    let stalled = false
    download.on('stalled', () => { stalled = true })
    await settleUntil(net, () => stalled)

    t.is(download.have, 0)
    t.ok(stalled, 'answered as not held')
  }
})

test('only a bounded number of files are kept open, and an evicted one is reopened on demand', async (t) => {
  const { net, dir, make } = setup(t)
  const files = [1, 2, 3].map((n) => writeSample(dir, 'f' + n, 30000 + n))
  const links = await Promise.all(files.map((file) => linkTo(t, file)))
  const roots = await Promise.all(files.map(async (file) => {
    const source = await ContentSource.open(file)
    await source.close()
    return source.root
  }))

  const holder = make('holder', { resolve: (root) => files[roots.indexOf(root)] ?? null, maxOpen: 2 })
  const fetcher = make('fetcher')

  let most = 0
  for (const [i, link] of [...links, links[0]].entries()) {
    const download = fetcher.download(link, path.join(dir, 'copy' + i))
    await settleUntil(net, () => { most = Math.max(most, holder.onDemand.open.size); return download.complete })
    await download
    t.alike(read(path.join(dir, 'copy' + i)), read(files[i % 3]))
  }

  t.ok(most <= 2, `at most ${most} files open at once`)
})

test('a served file is closed once idle, so its folder can be renamed, and reopened when asked again', async (t) => {
  const { net, dir, make } = setup(t)
  let folder = path.join(dir, 'album')
  fs.mkdirSync(folder)
  writeSample(folder, 'one', 40000)
  const link = await linkTo(t, path.join(folder, 'one'))

  const clock = new TestClock()
  const holder = make('holder', { resolve: () => path.join(folder, 'one'), timers: clock })
  const fetcher = make('fetcher')

  const first = fetcher.download(link, path.join(dir, 'copy'))
  await settleUntil(net, () => first.complete)
  await first

  const [root] = holder.onDemand.open.keys()
  const source = holder.onDemand.open.get(root)
  let closed = 0
  const close = source.close.bind(source)
  source.close = () => { closed++; return close() }

  // On Windows a folder holding an open file cannot be renamed. Elsewhere it can, open or not.
  if (os.platform() === 'win32') {
    t.exception(() => fs.renameSync(folder, path.join(dir, 'early')), /EPERM|EBUSY|EACCES/, 'the open file holds its folder')
  }

  clock.advance(4999)
  t.is(closed, 0, 'still open just before the idle time')
  clock.advance(1)
  t.is(closed, 1, 'closed once idle')
  t.absent(holder.onDemand.open.has(root))

  const moved = path.join(dir, 'holiday')
  // the handle closes asynchronously: retry by time, like every other wait here
  await settleUntil(net, () => { try { fs.renameSync(folder, moved); return true } catch { return false } })
  folder = moved
  t.ok(exists(path.join(moved, 'one')), 'the folder was renamed')

  const second = fetcher.download(link, path.join(dir, 'again'))
  await settleUntil(net, () => second.complete)
  await second
  t.alike(read(path.join(dir, 'again')), read(path.join(moved, 'one')), 'reopened through resolve, from where it is now')
})

test('with a network that never joins, nothing serves, fetches or lists through a topic', async (t) => {
  const { net, dir, make } = setup(t)
  const file = writeSample(dir, 'held', 30000)
  const folder = path.join(dir, 'folder')
  fs.mkdirSync(folder)
  writeSample(folder, 'a', 10000)
  writeSample(folder, 'b', 12000)

  const holder = make('holder', { resolve: () => file })
  const fetcher = make('fetcher', { temporary: true }) // and a list read is not a file to rename

  const { link } = await holder.serve(file)
  const { link: folderLink } = await holder.serveCollection(folder)

  const one = fetcher.download(link, path.join(dir, 'copy'))
  await settleUntil(net, () => one.complete)
  await one

  const list = await drive(net, () => fetcher.readList(folderLink))
  const single = fetcher.downloadFile(folderLink, list.files[0], path.join(dir, 'one'))
  await settleUntil(net, () => single.complete)
  await single

  await drive(net, () => fetcher.downloadCollection(folderLink, path.join(dir, 'all')))

  t.alike(read(path.join(dir, 'all', 'b')), read(path.join(folder, 'b')))
  for (const peer of net.peers.values()) t.alike([...peer.topics], [b4a.toString(SPACE, 'hex')], `${peer.name} is on the workspace topic only`)
})

test('a temporary download never leaves a half file at the target, and resumes from its .part', async (t) => {
  const { net, dir, make } = setup(t)
  const file = writeSample(dir, 'held', 300000)
  const link = await linkTo(t, file)
  const out = path.join(dir, 'copy')

  make('holder', { resolve: () => file })
  const fetcher = make('fetcher', { temporary: true, window: 2 })

  const first = fetcher.download(link, out)
  for (const end = Date.now() + 20000; Date.now() < end && !(first.have > 0 && first.have < first.total);) await net.step()
  t.ok(first.have > 0 && first.have < first.total, 'stopped mid-way')
  t.absent(exists(out), 'nothing at the target while partial')
  t.ok(exists(out + '.part'), 'the bytes are in the .part file')
  t.ok(exists(out + '.part.swarmwire-part'), 'with the resume record beside it')
  const got = first.have
  await first.stop()
  t.absent(exists(out), 'and still nothing after stop')

  const second = fetcher.download(link, out)
  await second.ready()
  t.ok(second.have >= got, 'resumed from the .part file')
  await settleUntil(net, () => second.complete)
  await second

  t.alike(read(out), read(file), 'renamed into place once verified')
  t.absent(exists(out + '.part'))
  t.absent(exists(out + '.part.swarmwire-part'))
  t.is(fetcher.onDemand?.open.get(second.root)?.path ?? fetcher.serving.get(second.root)?.path, out, 'served from where it landed')
})

test('a file changed in place while served, same size and mtime, is never sent: not held', async (t) => {
  for (const how of ['resolve', 'serve']) {
    const { net, dir, make } = setup(t)
    const file = writeSample(dir, 'held', 300000)
    const link = await linkTo(t, file)
    const { mtime } = fs.statSync(file)

    const holder = make('holder', how === 'resolve' ? { resolve: () => file } : {})
    if (how === 'serve') await holder.serve(file)
    const fetcher = make('fetcher', { window: 2 })

    const download = fetcher.download(link, path.join(dir, 'copy'))
    for (let i = 0; i < 2000 && !(download.have > 0 && download.have < download.total); i++) await net.step()
    t.ok(download.have > 0 && download.have < download.total, `${how}: mid-way`)

    fs.writeFileSync(file, b4a.alloc(300000, 1)) // the open file rewritten under the holder
    fs.utimesSync(file, mtime, mtime) // and its mtime put back: no stat can tell

    let stalled = false
    download.on('stalled', () => { stalled = true })
    await settleUntil(net, () => stalled)

    t.is(download.rejected, 0, `${how}: not one wrong byte was sent`)
    t.ok(download.have < download.total, `${how}: and the fetch learned nobody holds the rest`)
    t.absent(holder.serving.has(download.root) || holder.onDemand?.open.has(download.root), `${how}: no longer served`)
  }
})

test('a file rewritten with the same size and mtime after it was hashed is answered as not held', async (t) => {
  const { net, dir, make } = setup(t)
  const file = writeSample(dir, 'held', 40000)
  const link = await linkTo(t, file) // hashes it, and remembers the hashes by path, size, mtime
  const { mtime } = fs.statSync(file)
  fs.writeFileSync(file, b4a.alloc(40000, 1))
  fs.utimesSync(file, mtime, mtime)

  make('holder', { resolve: () => file })
  const download = make('fetcher').download(link, path.join(dir, 'copy'))
  let stalled = false
  download.on('stalled', () => { stalled = true })
  await settleUntil(net, () => stalled)

  t.is(download.have, 0)
  t.is(download.rejected, 0, 'the remembered hashes did not let a wrong byte through')
})

// ---------------------------------------------------------------------------

/**
 * Nodes whose network is the application's: swarmwire sees every connection the workspace
 * topic brings, and its own `join` calls go nowhere.
 */
function setup (t) {
  const net = new TestNetwork()
  const dir = tmpdir(t)

  function make (name, opts = {}) {
    const peer = net.peer(name).join(SPACE)
    const swarm = {
      join () {},
      on: (event, fn) => peer.on(event, fn),
      removeListener: (event, fn) => peer.removeListener(event, fn)
    }

    const node = new Swarmwire({ swarm, ...opts })
    t.teardown(() => node.destroy())
    return node
  }

  return { net, dir, make }
}

async function linkTo (t, file) {
  const source = await ContentSource.open(file)
  await source.close()
  return formatLink({ root: source.root, size: source.size })
}

/** By time, not rounds: opening a just-written file can be slow (virus scanners, a busy disk). */
async function settleUntil (net, done) {
  for (const end = Date.now() + 20000; Date.now() < end;) {
    if (done()) return
    await net.settle()
  }
  if (!done()) throw new Error('condition never held')
}

async function drive (net, operation) {
  let done = false
  const result = operation().finally(() => { done = true })
  result.catch(() => {})

  // By time, not rounds: a round is one event-loop turn, and real disk I/O can outlast thousands.
  for (const end = Date.now() + 20000; !done && Date.now() < end;) await net.settle()

  return result
}
