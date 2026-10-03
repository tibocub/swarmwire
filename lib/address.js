/**
 * Addressing: content roots, links, and the topic a root is announced on.
 *
 * This is the part of swarmwire that ends up inside links other people keep, so it changes
 * slowly and deliberately. See docs/format.md; every rule here is pinned by test/unit.
 */

import blake3 from 'blake3-bao/blake3'

export const SCHEME = 'swarmwire'

/** Domain separation for topic derivation. Changing these strings splits the network. */
const DISCOVERY_PREFIX = 'swarmwire/v0/discovery'

const HEX32 = /^[0-9a-f]{64}$/

/**
 * The content address of a buffer: the plain BLAKE3 hash, as `b3sum` prints it.
 *
 * @param {Buffer|Uint8Array} content
 * @returns {string} 64 lowercase hex characters
 */
export function rootOf (content) {
  if (!(content instanceof Uint8Array)) throw new TypeError('content must be a Buffer or Uint8Array')
  return blake3.hashHex(asUint8(content))
}

/**
 * Build a link.
 *
 * @param {object} opts
 * @param {string} opts.root - 64 hex characters
 * @param {number} [opts.size] - size hint in bytes
 * @param {string} [opts.name] - filename hint, for display only
 * @param {string} [opts.secret] - 64 hex characters, for a private swarm
 * @returns {string}
 */
export function formatLink ({ root, size = null, name = null, secret = null } = {}) {
  assertHex32(root, 'root')
  if (secret !== null) assertHex32(secret, 'secret')
  if (size !== null && !isSize(size)) throw new Error('size must be a non-negative integer')

  const params = []
  if (size !== null) params.push('s=' + size)
  if (name !== null) params.push('n=' + encodeURIComponent(name))
  if (secret !== null) params.push('k=' + secret)

  return `${SCHEME}://${root}` + (params.length ? '?' + params.join('&') : '')
}

/**
 * Parse a link. Hints are returned as given: validating a name against a destination path is
 * the caller's job, and this must not silently "fix" a hostile one.
 *
 * @param {string} link
 * @returns {{root: string, size: number|null, name: string|null, secret: string|null}}
 */
export function parseLink (link) {
  if (typeof link !== 'string') throw new TypeError('link must be a string')

  const prefix = `${SCHEME}://`
  if (!link.startsWith(prefix)) throw new Error(`link must use the ${SCHEME}:// scheme`)

  const rest = link.slice(prefix.length)
  const q = rest.indexOf('?')
  const root = q === -1 ? rest : rest.slice(0, q)
  assertHex32(root, 'root')

  const out = { root, size: null, name: null, secret: null }
  if (q === -1) return out

  for (const pair of rest.slice(q + 1).split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const key = eq === -1 ? pair : pair.slice(0, eq)
    const value = eq === -1 ? '' : pair.slice(eq + 1)

    switch (key) {
      case 's': {
        const size = Number(value)
        if (!isSize(size)) throw new Error('size hint must be a non-negative integer')
        out.size = size
        break
      }
      case 'n':
        out.name = decodeURIComponent(value)
        break
      case 'k':
        assertHex32(value, 'secret')
        out.secret = value
        break
      default:
        // Unknown parameters are ignored, so later versions can add hints without
        // breaking today's parsers.
        break
    }
  }

  return out
}

/**
 * The Hyperswarm topic a root is announced on. With a secret, only holders of the link can
 * derive it; without one, anyone who knows the content's address can.
 *
 * @param {string} root - 64 hex characters
 * @param {string|null} [secret] - 64 hex characters
 * @returns {Buffer} 32 bytes
 */
export function discoveryTopic (root, secret = null) {
  assertHex32(root, 'root')
  if (secret !== null) assertHex32(secret, 'secret')

  const parts = [Buffer.from(DISCOVERY_PREFIX, 'ascii'), Buffer.from(root, 'hex')]
  if (secret !== null) parts.push(Buffer.from(secret, 'hex'))

  return Buffer.from(blake3.hashHex(asUint8(Buffer.concat(parts))), 'hex')
}

function assertHex32 (value, what) {
  if (typeof value !== 'string' || !HEX32.test(value)) {
    throw new Error(`${what} must be 64 lowercase hex characters`)
  }
}

function isSize (n) {
  return Number.isInteger(n) && n >= 0
}

function asUint8 (buf) {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}
