/**
 * The wire: what peers say to each other, and nothing more.
 *
 * Eight messages. A peer asks who has some content, holders say so, the asker requests groups
 * one at a time, and each answer carries the proof that makes it checkable on arrival.
 * Scheduling, windows and peer choice live in swarmwire.js — none of that is on the wire.
 *
 * Unknown message types are ignored rather than treated as errors, so adding a message later
 * never breaks a peer running today's version.
 */

import c from 'compact-encoding'
import Protomux from 'protomux'

export const PROTOCOL = 'swarmwire/0'
export const VERSION = 0

/** @typedef {{version: number, groupLog: number}} Handshake */
/** @typedef {{root: Uint8Array, size: number}} Want - who holds this root? `size` 0 when unknown */
/** @typedef {{root: Uint8Array, size: number, groupLog: number, bitfield: Uint8Array}} Have */
/** @typedef {{root: Uint8Array, index: number}} Request */
/** @typedef {{root: Uint8Array, index: number, proof: Uint8Array[], data: Uint8Array}} Data */
/** @typedef {{root: Uint8Array}} Unavailable */
/** @typedef {{root: Uint8Array, index: number}} Holds */
/** @typedef {{root: Uint8Array, index: number}} Reject */

/**
 * One sender per message.
 *
 * @typedef {object} Send
 * @property {(message: Handshake) => boolean} handshake
 * @property {(message: Want) => boolean} want
 * @property {(message: Have) => boolean} have
 * @property {(message: Request) => boolean} request
 * @property {(message: Data) => boolean} data
 * @property {(message: Unavailable) => boolean} unavailable
 * @property {(message: Holds) => boolean} holds
 * @property {(message: Reject) => boolean} reject
 */

/**
 * @typedef {object} Handlers
 * @property {(message: Handshake) => void} [onhandshake]
 * @property {(message: Want) => void} [onwant]
 * @property {(message: Have) => void} [onhave]
 * @property {(message: Request) => void} [onrequest]
 * @property {(message: Data) => void} [ondata]
 * @property {(message: Unavailable) => void} [onunavailable]
 * @property {(message: Holds) => void} [onholds]
 * @property {(message: Reject) => void} [onreject]
 * @property {() => void} [onclose]
 */

/** Field order is the wire format: append, never reorder. */
const encodings = {
  handshake: record({ version: c.uint, groupLog: c.uint }),
  want: record({ root: c.fixed32, size: c.uint }),
  // A bitfield, because a download in progress serves only part of the content.
  have: record({ root: c.fixed32, size: c.uint, groupLog: c.uint, bitfield: c.buffer }),
  request: record({ root: c.fixed32, index: c.uint }),
  data: record({ root: c.fixed32, index: c.uint, proof: c.array(c.fixed32), data: c.buffer }),
  unavailable: record({ root: c.fixed32 }),
  // One group at a time: a whole bitfield per group would cost kilobytes on a large file.
  holds: record({ root: c.fixed32, index: c.uint }),
  // Faster than silence: a reserved group nobody fetches stalls the download until a timeout.
  reject: record({ root: c.fixed32, index: c.uint })
}

/**
 * Message order is the wire format too: protomux identifies messages by position.
 *
 * @type {(keyof Send)[]}
 */
const ORDER = ['handshake', 'want', 'have', 'request', 'data', 'unavailable', 'holds', 'reject']

/**
 * Open the swarmwire channel on a connection.
 *
 * @param {import('stream').Duplex} stream - a duplex connection from the swarm
 * @param {Handlers} handlers
 * @returns {{channel: Protomux.Channel, send: Send, mux: Protomux}|null} null if the channel is
 *   already open on this connection
 */
export function openChannel (stream, handlers = {}) {
  const mux = Protomux.from(stream)

  const channel = mux.createChannel({
    protocol: PROTOCOL,
    onclose: handlers.onclose
  })

  if (channel === null) return null // someone else already opened it on this stream

  /** @type {Record<string, Protomux.Message>} */
  const messages = {}
  for (const name of ORDER) {
    messages[name] = channel.addMessage({
      encoding: encodings[name],
      onmessage: handlers[/** @type {keyof Handlers} */ ('on' + name)] ?? noop
    })
  }

  channel.open()

  const send = /** @type {Send} */ ({}) // filled in just below
  for (const name of ORDER) {
    send[name] = (payload) => messages[name].send(payload)
  }

  return { channel, send, mux }
}

/**
 * Build an encoding from an ordered set of fields.
 *
 * @template {Record<string, unknown>} T
 * @param {{[K in keyof T]: import('compact-encoding').Encoder<T[K]>}} fields
 * @returns {import('compact-encoding').Encoder<T>}
 */
function record (fields) {
  const keys = /** @type {(keyof T)[]} */ (Object.keys(fields))

  return {
    preencode (state, message) {
      for (const key of keys) fields[key].preencode(state, message[key])
    },
    encode (state, message) {
      for (const key of keys) fields[key].encode(state, message[key])
    },
    decode (state) {
      const message = /** @type {T} */ ({}) // every field is set just below
      for (const key of keys) message[key] = fields[key].decode(state)
      return message
    }
  }
}

function noop () {}
