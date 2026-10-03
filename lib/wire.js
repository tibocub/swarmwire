/**
 * The wire: what peers say to each other, and nothing more.
 *
 * Six messages. A peer asks who has some content, holders say so, the asker requests groups
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

/** Field order is the wire format: append, never reorder. */
const encodings = {
  handshake: record({ version: c.uint, groupLog: c.uint }),
  want: record({ root: c.fixed32, size: c.uint }),
  have: record({ root: c.fixed32, size: c.uint, groupLog: c.uint }),
  request: record({ root: c.fixed32, index: c.uint }),
  data: record({ root: c.fixed32, index: c.uint, proof: c.array(c.fixed32), data: c.buffer }),
  unavailable: record({ root: c.fixed32 })
}

/** Message order is the wire format too: protomux identifies messages by position. */
const ORDER = ['handshake', 'want', 'have', 'request', 'data', 'unavailable']

/**
 * Open the swarmwire channel on a connection.
 *
 * @param {object} stream - a duplex connection from the swarm
 * @param {Record<string, Function>} handlers - onhandshake, onwant, onhave, onrequest,
 *   ondata, onunavailable, onclose; all optional
 * @returns {{channel: object, send: Record<string, Function>}|null} null if the channel is
 *   already open on this connection
 */
export function openChannel (stream, handlers = {}) {
  const mux = Protomux.from(stream)

  const channel = mux.createChannel({
    protocol: PROTOCOL,
    onclose: handlers.onclose
  })

  if (channel === null) return null // someone else already opened it on this stream

  const messages = {}
  for (const name of ORDER) {
    messages[name] = channel.addMessage({
      encoding: encodings[name],
      onmessage: handlers['on' + name] ?? noop
    })
  }

  channel.open()

  const send = {}
  for (const name of ORDER) {
    send[name] = (payload) => messages[name].send(payload)
  }

  return { channel, send }
}

/** Build an encoding from an ordered set of fields. */
function record (fields) {
  const keys = Object.keys(fields)

  return {
    preencode (state, message) {
      for (const key of keys) fields[key].preencode(state, message[key])
    },
    encode (state, message) {
      for (const key of keys) fields[key].encode(state, message[key])
    },
    decode (state) {
      const message = {}
      for (const key of keys) message[key] = fields[key].decode(state)
      return message
    }
  }
}

function noop () {}
