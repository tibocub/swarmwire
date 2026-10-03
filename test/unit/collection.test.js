import test from 'brittle'
import b4a from 'b4a'

import {
  encodeManifest,
  decodeManifest,
  normalisePath,
  isSafePath,
  totalSize,
  MANIFEST_TYPE
} from '../../lib/collection.js'
import { rootOf } from '../../lib/address.js'

const ROOT_A = 'a'.repeat(64)
const ROOT_B = 'b'.repeat(64)

test('a manifest round-trips', (t) => {
  const files = [
    { path: 'notes.txt', root: ROOT_A, size: 12 },
    { path: 'photos/one.jpg', root: ROOT_B, size: 900 }
  ]

  t.alike(decodeManifest(encodeManifest(files)), files)
})

test('the same folder has the same address whatever order it was listed in', (t) => {
  // The manifest's bytes are its identity, so entry order must not leak into the hash.
  const one = encodeManifest([
    { path: 'b.txt', root: ROOT_B, size: 2 },
    { path: 'a.txt', root: ROOT_A, size: 1 }
  ])
  const two = encodeManifest([
    { path: 'a.txt', root: ROOT_A, size: 1 },
    { path: 'b.txt', root: ROOT_B, size: 2 }
  ])

  t.alike(one, two)
  t.is(rootOf(one), rootOf(two))
})

test('windows separators do not change the address', (t) => {
  const windows = encodeManifest([{ path: 'photos\\one.jpg', root: ROOT_A, size: 1 }])
  const posix = encodeManifest([{ path: 'photos/one.jpg', root: ROOT_A, size: 1 }])

  t.is(rootOf(windows), rootOf(posix), 'a folder packed on either platform is the same folder')
})

test('a manifest says what it is', (t) => {
  const decoded = JSON.parse(b4a.toString(encodeManifest([{ path: 'a', root: ROOT_A, size: 0 }])))
  t.is(decoded.swarmwire, MANIFEST_TYPE)
})

test('total size is the sum of the parts', (t) => {
  t.is(totalSize([{ size: 10 }, { size: 5 }]), 15)
  t.is(totalSize([]), 0)
})

// ---------------------------------------------------------------------------
// Everything below arrived from a stranger.
// ---------------------------------------------------------------------------

test('a path that climbs out of the destination is refused', (t) => {
  t.absent(isSafePath('../escape.txt'))
  t.absent(isSafePath('photos/../../escape.txt'))
  t.exception(() => encodeManifest([{ path: '../escape.txt', root: ROOT_A, size: 1 }]), /unsafe path/)
  t.exception(() => decodeManifest(manifest([{ path: '../escape.txt', root: ROOT_A, size: 1 }])), /unsafe path/)
})

test('an absolute path is refused', (t) => {
  t.absent(isSafePath('/etc/passwd'), 'leading slash')
  t.absent(isSafePath('C:/Windows/system32'), 'drive letter')
  t.exception(() => decodeManifest(manifest([{ path: '/etc/passwd', root: ROOT_A, size: 1 }])), /unsafe path/)
})

test('control characters and reserved characters are refused', (t) => {
  t.absent(isSafePath('a\u0000b'))
  t.absent(isSafePath('what?.txt'))
  t.absent(isSafePath('a:b.txt'), 'a path that works on Linux and not Windows is not portable')
})

test('an empty path is refused', (t) => {
  t.absent(isSafePath(''))
  t.exception(() => decodeManifest(manifest([{ path: '', root: ROOT_A, size: 1 }])), /unsafe path/)
})

test('two entries for the same path are refused', (t) => {
  // Otherwise which one wins depends on the order files happen to arrive.
  t.exception(
    () => decodeManifest(manifest([
      { path: 'a.txt', root: ROOT_A, size: 1 },
      { path: 'a.txt', root: ROOT_B, size: 2 }
    ])),
    /duplicate path/
  )
})

test('a bad root or size is refused', (t) => {
  t.exception(() => decodeManifest(manifest([{ path: 'a', root: 'nothex', size: 1 }])), /bad root/)
  t.exception(() => decodeManifest(manifest([{ path: 'a', root: ROOT_A, size: -1 }])), /bad size/)
  t.exception(() => decodeManifest(manifest([{ path: 'a', root: ROOT_A, size: 1.5 }])), /bad size/)
})

test('something that is not a manifest is refused', (t) => {
  t.exception(() => decodeManifest(b4a.from('not json at all')), /valid JSON/)
  t.exception(() => decodeManifest(b4a.from('{"hello":"world"}')), /not a swarmwire collection/)
  t.exception(() => decodeManifest(b4a.from(`{"swarmwire":"${MANIFEST_TYPE}"}`)), /no file list/)
})

test('normalising is idempotent', (t) => {
  t.is(normalisePath('./a//b/'), 'a/b')
  t.is(normalisePath(normalisePath('./a//b/')), 'a/b')
})

// ---------------------------------------------------------------------------

/** Build manifest bytes directly, bypassing the checks in encodeManifest. */
function manifest (files) {
  return b4a.from(JSON.stringify({ swarmwire: MANIFEST_TYPE, files }), 'utf8')
}
