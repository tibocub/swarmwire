/**
 * A peer that speaks the protocol correctly and answers dishonestly.
 *
 * It claims to hold whatever is asked for and replies to every request with plausible rubbish:
 * right message, right length, wrong bytes. This is the attack the verification layer exists
 * to stop, so it is worth testing against a real liar rather than a corrupted connection —
 * garbled framing would be caught by the transport and prove nothing.
 */

import b4a from 'b4a'
import { bao } from '../../lib/blake3.js'

import { openChannel, VERSION } from '../../lib/wire.js'
import { groupRange, groupCount, DEFAULT_GROUP_LOG } from '../../lib/tree.js'

/**
 * @param {object} peer - a TestNetwork peer
 * @param {{size: number, groupLog?: number, proofLength?: number}} opts - what to claim
 */
export function attachLiar (peer, { size, groupLog = DEFAULT_GROUP_LOG }) {
  const state = { requests: 0 }

  peer.on('connection', (stream) => {
    const channel = openChannel(stream, {
      onwant: ({ root }) => {
        channel.send.have({ root, size, groupLog, bitfield: everything(size, groupLog) })
      },

      onrequest: ({ root, index }) => {
        state.requests++

        const count = groupCount(size, groupLog)
        if (index >= count) return

        const { length } = groupRange(index, size, groupLog)
        channel.send.data({
          root,
          index,
          proof: plausibleProof(index, count),
          data: b4a.alloc(length, 0x41) // the right shape, none of the right bytes
        })
      }
    })

    if (channel === null) return
    channel.send.handshake({ version: VERSION, groupLog })
  })

  return state
}

/**
 * A peer that claims to have the content and then never answers a request.
 *
 * Worse than a refusal: each request it accepts is a group nobody else is fetching. This is
 * what request timeouts exist for.
 *
 * @param {object} peer - a TestNetwork peer
 * @param {{size: number, groupLog?: number}} opts - what to claim
 */
export function attachSilent (peer, { size, groupLog = DEFAULT_GROUP_LOG }) {
  const state = { requests: 0 }

  peer.on('connection', (stream) => {
    const channel = openChannel(stream, {
      onwant: ({ root }) => {
        channel.send.have({ root, size, groupLog, bitfield: everything(size, groupLog) })
      },
      onrequest: () => { state.requests++ } // ...and nothing else, ever
    })

    if (channel === null) return
    channel.send.handshake({ version: VERSION, groupLog })
  })

  return state
}

/** Claims to hold every group. */
function everything (size, groupLog) {
  const count = groupCount(size, groupLog)
  const bitfield = bao.createBitfield(count)

  for (let i = 0; i < count; i++) bao.setBit(bitfield, i)
  return bitfield
}

/** A proof of the right length, made of hashes that prove nothing. */
function plausibleProof (index, count) {
  const proof = []
  let start = 0
  let end = count

  while (end - start > 1) {
    let split = 1
    while (split * 2 < end - start) split *= 2
    const mid = start + split

    proof.push(b4a.alloc(32, proof.length + 1))
    if (index < mid) end = mid
    else start = mid
  }

  return proof
}
