import test from 'brittle'
import b4a from 'b4a'
import path from 'path'

import { Destination } from '../../lib/destination.js'
import { ContentSource } from '../../lib/source.js'
import { groupRange, DEFAULT_GROUP_LOG } from '../../lib/tree.js'
import { tmpdir, writeSample, read, exists } from '../helpers/tmp.js'

test('verified groups land in the file, and the result is the original', async (t) => {
  const { source, out, dir } = await fixture(t, 70000)

  const dest = await Destination.open(out, { root: source.root, size: source.size })
  t.teardown(() => dest.close())

  for (let i = 0; i < source.groupCount; i++) {
    t.ok(await dest.put(i, await source.readGroup(i), source.proof(i)), `group ${i} accepted`)
  }

  t.ok(dest.complete)
  await dest.finish()

  t.alike(read(out), read(path.join(dir, 'original')), 'byte for byte')
})

test('groups may arrive in any order', async (t) => {
  const { source, out } = await fixture(t, 70000)

  const dest = await Destination.open(out, { root: source.root, size: source.size })
  t.teardown(() => dest.close())

  for (const i of [4, 1, 3, 0, 2]) {
    await dest.put(i, await source.readGroup(i), source.proof(i))
  }

  t.ok(dest.complete)
})

// ---------------------------------------------------------------------------
// The whole point: nothing unverified reaches the file.
// ---------------------------------------------------------------------------

test('tampered data is refused and never written', async (t) => {
  const { source, out } = await fixture(t, 70000)

  const dest = await Destination.open(out, { root: source.root, size: source.size })
  t.teardown(() => dest.close())

  const lie = b4a.from(await source.readGroup(0))
  lie[10] ^= 0xff

  t.absent(await dest.put(0, lie, source.proof(0)), 'refused')
  t.absent(dest.has(0), 'not recorded as held')

  const written = read(out).subarray(0, 16384)
  t.absent(b4a.equals(written, lie), 'and the bytes never reached the file')
})

test('a group offered for the wrong slot is refused', async (t) => {
  const { source, out } = await fixture(t, 70000)

  const dest = await Destination.open(out, { root: source.root, size: source.size })
  t.teardown(() => dest.close())

  t.absent(await dest.put(1, await source.readGroup(0), source.proof(0)))
  t.absent(dest.has(1))
})

test('a refused group does not count as progress', async (t) => {
  const { source, out } = await fixture(t, 70000)

  const dest = await Destination.open(out, { root: source.root, size: source.size })
  t.teardown(() => dest.close())

  await dest.put(0, b4a.alloc(16384), source.proof(0))

  t.is(dest.have, 0)
  t.alike(dest.missing(), [0, 1, 2, 3, 4])
})

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

test('a half-finished download resumes where it stopped', async (t) => {
  const { source, out, dir } = await fixture(t, 70000)

  const first = await Destination.open(out, { root: source.root, size: source.size })
  await first.put(0, await source.readGroup(0), source.proof(0))
  await first.put(1, await source.readGroup(1), source.proof(1))
  await first.close()

  const second = await Destination.open(out, { root: source.root, size: source.size })
  t.teardown(() => second.close())

  t.is(second.have, 2, 'it remembered')
  t.alike(second.missing(), [2, 3, 4])

  for (const i of second.missing()) {
    await second.put(i, await source.readGroup(i), source.proof(i))
  }
  await second.finish()

  t.alike(read(out), read(path.join(dir, 'original')))
})

test('finishing clears the resume state', async (t) => {
  const { source, out } = await fixture(t, 20000)

  const dest = await Destination.open(out, { root: source.root, size: source.size })
  for (let i = 0; i < source.groupCount; i++) {
    await dest.put(i, await source.readGroup(i), source.proof(i))
  }

  t.ok(exists(out + '.swarmwire-part'), 'the sidecar exists while downloading')
  await dest.finish()
  t.absent(exists(out + '.swarmwire-part'), 'and is gone once complete')
})

test('resume state for different content is discarded, not trusted', async (t) => {
  const { source, out } = await fixture(t, 70000)

  const first = await Destination.open(out, { root: source.root, size: source.size })
  await first.put(0, await source.readGroup(0), source.proof(0))
  await first.close()

  // The same destination path, a different file: the old bitfield must not be believed.
  const other = await ContentSource.open(writeSample(tmpdir(t), 'other.bin', 70000 + 1))
  t.teardown(() => other.close())

  const second = await Destination.open(out, { root: other.root, size: other.size })
  t.teardown(() => second.close())

  t.is(second.have, 0, 'started over')
})

test('the file is preallocated, so writes can land anywhere', async (t) => {
  const { source, out } = await fixture(t, 70000)

  const dest = await Destination.open(out, { root: source.root, size: source.size })
  t.teardown(() => dest.close())

  t.is(read(out).length, 70000, 'full size from the start')

  const last = source.groupCount - 1
  await dest.put(last, await source.readGroup(last), source.proof(last))

  const { offset, length } = groupRange(last, source.size, DEFAULT_GROUP_LOG)
  t.alike(
    b4a.from(read(out).subarray(offset, offset + length)),
    b4a.from(await source.readGroup(last)),
    'the last group is at the right offset'
  )
})

// ---------------------------------------------------------------------------

async function fixture (t, size) {
  const dir = tmpdir(t)
  const source = await ContentSource.open(writeSample(dir, 'original', size))
  t.teardown(() => source.close())
  return { dir, source, out: path.join(dir, 'downloaded') }
}
