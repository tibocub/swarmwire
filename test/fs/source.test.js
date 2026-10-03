import test from 'brittle'
import blake3 from 'blake3-bao/blake3'
import b4a from 'b4a'
import fs from 'fs'

import { ContentSource, clearHashCache } from '../../lib/source.js'
import { verifyGroup, groupRange, groupLength, DEFAULT_GROUP_LOG } from '../../lib/tree.js'
import { tmpdir, writeSample, sample, read } from '../helpers/tmp.js'

test('a file is addressed by its plain BLAKE3 hash', async (t) => {
  const dir = tmpdir(t)
  const file = writeSample(dir, 'holidays.mp4', 70000)

  const source = await ContentSource.open(file)
  t.teardown(() => source.close())

  t.is(source.root, blake3.hashHex(read(file)), 'the root is what b3sum would print')
  t.is(source.size, 70000)
})

test('the file is served from where it already is', async (t) => {
  const dir = tmpdir(t)
  const file = writeSample(dir, 'holidays.mp4', 70000)
  const before = fs.readdirSync(dir)

  const source = await ContentSource.open(file)
  t.teardown(() => source.close())
  await source.readGroup(0)

  t.alike(fs.readdirSync(dir), before, 'no copy, no store, no sidecar appeared')
})

test('every group it serves verifies against its own root', async (t) => {
  const dir = tmpdir(t)
  const file = writeSample(dir, 'holidays.mp4', 70000)

  const source = await ContentSource.open(file)
  t.teardown(() => source.close())

  for (let i = 0; i < source.groupCount; i++) {
    const data = await source.readGroup(i)
    t.ok(verifyGroup({
      root: source.root,
      size: source.size,
      index: i,
      data,
      proof: source.proof(i)
    }), `group ${i}`)
  }
})

test('group bytes are the file bytes', async (t) => {
  const dir = tmpdir(t)
  const file = writeSample(dir, 'holidays.mp4', 70000)
  const content = read(file)

  const source = await ContentSource.open(file)
  t.teardown(() => source.close())

  const { offset, length } = groupRange(2, 70000, DEFAULT_GROUP_LOG)
  t.alike(b4a.from(await source.readGroup(2)), b4a.from(content.subarray(offset, offset + length)))
})

test('an empty file still has an address', async (t) => {
  const dir = tmpdir(t)
  const file = writeSample(dir, 'empty', 0)

  const source = await ContentSource.open(file)
  t.teardown(() => source.close())

  t.is(source.root, 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262')
  t.is(source.groupCount, 1)
})

test('a file larger than one group spans several', async (t) => {
  const dir = tmpdir(t)
  const file = writeSample(dir, 'big', groupLength() * 3 + 10)

  const source = await ContentSource.open(file)
  t.teardown(() => source.close())

  t.is(source.groupCount, 4)
  t.is((await source.readGroup(3)).length, 10, 'the last group is short')
})

// ---------------------------------------------------------------------------
// Hashing on demand: there is no `add` step, so the second send must be cheap.
// ---------------------------------------------------------------------------

test('hashing is cached, so sending the same file twice rehashes nothing', async (t) => {
  clearHashCache()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'holidays.mp4', 70000)

  const first = await ContentSource.open(file)
  t.teardown(() => first.close())
  t.absent(first.cached, 'the first open had to hash it')

  const second = await ContentSource.open(file)
  t.teardown(() => second.close())
  t.ok(second.cached, 'the second did not')
  t.is(second.root, first.root)
})

test('a file edited behind our back is rehashed', async (t) => {
  clearHashCache()
  const dir = tmpdir(t)
  const file = writeSample(dir, 'notes.txt', 5000)

  const before = await ContentSource.open(file)
  await before.close()

  fs.writeFileSync(file, sample(6000))
  fs.utimesSync(file, new Date(), new Date(Date.now() + 2000))

  const after = await ContentSource.open(file)
  t.teardown(() => after.close())

  t.absent(after.cached, 'size and mtime changed, so the cache was not trusted')
  t.not(after.root, before.root)
  t.is(after.root, blake3.hashHex(read(file)))
})

test('opening something that is not there fails cleanly', async (t) => {
  const dir = tmpdir(t)
  await t.exception(ContentSource.open(`${dir}/nope.bin`), /no such file|ENOENT/i)
})
