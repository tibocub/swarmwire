/**
 * Addressing: content roots, links, and the topics content is announced on.
 *
 * This is the part of swarmwire that ends up inside links other people keep, so it changes
 * slowly and deliberately. See docs/format.md; every rule here is pinned by test/unit.
 *
 * Runs on Node and on Bare: no Buffer, no node builtins.
 */

import { blake3 } from './blake3.js'
import b4a from 'b4a'

export const SCHEME = 'swarmwire'

/** Domain separation for topic derivation. Changing these strings splits the network. */
const CONTENT_PREFIX = 'swarmwire/v0/discovery'
const SWARM_PREFIX = 'swarmwire/v0/swarm'

const HEX32 = /^[0-9a-f]{64}$/

/**
 * The content address of a buffer: the plain BLAKE3 hash, as `b3sum` prints it.
 *
 * @param {Uint8Array} content
 * @returns {string} 64 lowercase hex characters
 */
export function rootOf (content) {
  if (!(content instanceof Uint8Array)) throw new TypeError('content must be a Uint8Array')
  return blake3.hashHex(content)
}

/**
 * Build a link.
 *
 * @param {object} opts
 * @param {string} opts.root - 64 hex characters
 * @param {number} [opts.size] - size hint in bytes
 * @param {string} [opts.name] - filename hint, for display only
 * @param {string} [opts.secret] - 64 hex characters: the swarm key for a private swarm
 * @param {'collection'|null} [opts.type] - what the content is, when it is not a plain file
 * @returns {string}
 */
export function formatLink ({ root, size = null, name = null, secret = null, type = null } = {}) {
  assertHex32(root, 'root')
  if (secret !== null) assertHex32(secret, 'secret')
  if (size !== null && !isSize(size)) throw new Error('size must be a non-negative integer')
  if (type !== null && type !== 'collection') throw new Error('unknown link type')

  const params = []
  if (size !== null) params.push('s=' + size)
  if (name !== null) params.push('n=' + encodeURIComponent(name))
  if (secret !== null) params.push('k=' + secret)
  if (type === 'collection') params.push('t=c')

  return `${SCHEME}://${root}` + (params.length ? '?' + params.join('&') : '')
}

/**
 * Parse a link. Hints are returned as given: validating a name against a destination path is
 * the caller's job, and this must not silently "fix" a hostile one.
 *
 * @param {string} link
 * @returns {{root: string, size: number|null, name: string|null, secret: string|null,
 *   type: 'collection'|null}}
 */
export function parseLink (link) {
  if (typeof link !== 'string') throw new TypeError('link must be a string')

  const prefix = `${SCHEME}://`
  if (!link.startsWith(prefix)) throw new Error(`link must use the ${SCHEME}:// scheme`)

  const rest = link.slice(prefix.length)
  const q = rest.indexOf('?')
  const root = q === -1 ? rest : rest.slice(0, q)
  assertHex32(root, 'root')

  const out = { root, size: null, name: null, secret: null, type: null }
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
      case 't':
        // A hint, like the others: the content is checked when it arrives, and a link that
        // lies about this produces a manifest that does not parse, not a wrong folder.
        out.type = value === 'c' ? 'collection' : null
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
 * The topic a single piece of content is announced on — what a link resolves through.
 *
 * With a swarm key, only holders of the link can derive it; without one, anyone who knows the
 * content's address can.
 *
 * @param {string} root - 64 hex characters
 * @param {string|null} [swarmKey] - 64 hex characters
 * @returns {Uint8Array} 32 bytes
 */
export function discoveryTopic (root, swarmKey = null) {
  assertHex32(root, 'root')
  if (swarmKey !== null) assertHex32(swarmKey, 'swarmKey')

  const parts = [b4a.from(CONTENT_PREFIX, 'ascii'), b4a.from(root, 'hex')]
  if (swarmKey !== null) parts.push(b4a.from(swarmKey, 'hex'))

  return hash(parts)
}

/**
 * The topic a *group of peers* meets on, independent of what they hold.
 *
 * Members announce once and then ask each other for roots over the connection, so a shared
 * workspace of a thousand files costs one announce rather than a thousand. Where the swarm key
 * comes from — a link, a workspace, a hypergraph context — is the caller's business.
 *
 * @param {string} swarmKey - 64 hex characters
 * @returns {Uint8Array} 32 bytes
 */
export function swarmTopic (swarmKey) {
  assertHex32(swarmKey, 'swarmKey')
  return hash([b4a.from(SWARM_PREFIX, 'ascii'), b4a.from(swarmKey, 'hex')])
}

function hash (parts) {
  return b4a.from(blake3.hashHex(toU8(b4a.concat(parts))), 'hex')
}

function toU8 (buf) {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf)
}

function assertHex32 (value, what) {
  if (typeof value !== 'string' || !HEX32.test(value)) {
    throw new Error(`${what} must be 64 lowercase hex characters`)
  }
}

function isSize (n) {
  return Number.isInteger(n) && n >= 0
}
