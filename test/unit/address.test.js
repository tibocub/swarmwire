import test from 'brittle'
import blake3 from 'blake3-bao/blake3'
import * as bao from 'blake3-bao/bao'

import { rootOf, formatLink, parseLink, discoveryTopic } from '../../lib/address.js'

// ---------------------------------------------------------------------------
// Addressing. These are the BLAKE3 spec's own vectors: if they ever change,
// every link anyone ever shared has stopped working.
// ---------------------------------------------------------------------------

test('root of empty content is the BLAKE3 empty-input vector', (t) => {
  t.is(rootOf(Buffer.alloc(0)), 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262')
})

test('root of "abc" is the BLAKE3 vector', (t) => {
  t.is(rootOf(Buffer.from('abc')), '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85')
})

test('root is the plain BLAKE3 hash, not a custom tree', (t) => {
  const data = sample(300 * 1024)
  t.is(rootOf(data), blake3.hashHex(new Uint8Array(data)))
})

test('root is independent of chunk group size', (t) => {
  const data = sample(300 * 1024)
  const expected = rootOf(data)

  t.is(hex(bao.baoEncode(new Uint8Array(data), true).hash), expected, 'plain bao')
  t.is(hex(bao.baoEncodeIroh(new Uint8Array(data), true, 4).hash), expected, '16 KiB groups')
  t.is(hex(bao.baoEncodeIroh(new Uint8Array(data), true, 8).hash), expected, '256 KiB groups')
})

test('a range verifies against the root without the whole file', (t) => {
  const data = sample(300 * 1024)
  const encoded = bao.baoEncode(new Uint8Array(data), false)

  const slice = bao.baoSlice(encoded.encoded, 100000, 4096)
  const verified = bao.baoDecodeSlice(slice, encoded.hash, 100000, 4096)

  t.alike(Buffer.from(verified), data.subarray(100000, 104096))
  t.ok(slice.length < data.length / 8, 'proof is small relative to the content')
})

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const ROOT = '10db6398a68dff502d002912f54502fdde9ab55fb30bec32861a2f004d874fc8'
const SECRET = '0'.repeat(63) + '1'

test('a bare link is just the root', (t) => {
  t.is(formatLink({ root: ROOT }), `swarmwire://${ROOT}`)
  t.alike(parseLink(`swarmwire://${ROOT}`), { root: ROOT, size: null, name: null, secret: null })
})

test('hints round-trip', (t) => {
  const link = formatLink({ root: ROOT, size: 1234, name: 'my holidays.mp4', secret: SECRET })
  t.alike(parseLink(link), { root: ROOT, size: 1234, name: 'my holidays.mp4', secret: SECRET })
})

test('names are percent-encoded, so a link is always one token', (t) => {
  const link = formatLink({ root: ROOT, name: 'a b&c=d?e#f.txt' })
  t.absent(/[\s&=?#]/.test(link.split('n=')[1]), 'no raw separators survive in the name')
  t.is(parseLink(link).name, 'a b&c=d?e#f.txt')
})

test('a name that is a path is kept as a hint but never a path', (t) => {
  // Sanitising belongs to the caller; parsing must not silently "fix" it either.
  t.is(parseLink(formatLink({ root: ROOT, name: '../../etc/passwd' })).name, '../../etc/passwd')
})

test('malformed links are rejected', (t) => {
  t.exception(() => parseLink('http://example.com'), /scheme/i)
  t.exception(() => parseLink('swarmwire://nothex'), /root/i)
  t.exception(() => parseLink(`swarmwire://${ROOT.toUpperCase()}`), /root/i, 'roots are lowercase')
  t.exception(() => parseLink(`swarmwire://${ROOT}?s=-1`), /size/i)
  t.exception(() => parseLink(`swarmwire://${ROOT}?s=abc`), /size/i)
  t.exception(() => parseLink(`swarmwire://${ROOT}?k=xyz`), /secret/i)
  t.exception(() => formatLink({ root: 'nothex' }), /root/i)
})

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('topic is derived from the root alone when public', (t) => {
  const topic = discoveryTopic(ROOT)
  t.is(topic.length, 32)
  t.alike(discoveryTopic(ROOT), topic, 'deterministic')
})

test('a secret changes the topic', (t) => {
  t.unlike(hex(discoveryTopic(ROOT, SECRET)), hex(discoveryTopic(ROOT)))
})

test('topic derivation is pinned', (t) => {
  // Changing these strings splits the network: old peers announce elsewhere.
  t.is(hex(discoveryTopic(ROOT)), hex(h('swarmwire/v0/discovery', ROOT)))
  t.is(hex(discoveryTopic(ROOT, SECRET)), hex(h('swarmwire/v0/discovery', ROOT, SECRET)))
})

test('different content lands on different topics', (t) => {
  const other = 'f'.repeat(64)
  t.unlike(hex(discoveryTopic(other)), hex(discoveryTopic(ROOT)))
})

// ---------------------------------------------------------------------------

function sample (n) {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7) & 0xff
  return b
}

function hex (u8) {
  return Buffer.from(u8).toString('hex')
}

function h (prefix, ...hexParts) {
  const parts = [Buffer.from(prefix, 'ascii'), ...hexParts.map((p) => Buffer.from(p, 'hex'))]
  return Buffer.from(blake3.hashHex(new Uint8Array(Buffer.concat(parts))), 'hex')
}
