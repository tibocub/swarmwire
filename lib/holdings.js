/**
 * What connected peers say they hold, and the counts that follow from it.
 *
 * A node only hears a peer's holdings if it asked (`want` → `have`, then `holds`). A node that
 * only serves never asks, so it sends `want` for the roots it serves to every peer.
 * Counts are of direct connections. Nothing here knows about the rest of the swarm.
 */

import b4a from 'b4a'

import { bao } from './blake3.js'
import { DEFAULT_GROUP_LOG, groupCount } from './tree.js'

/**
 * What one peer holds of one root.
 *
 * @typedef {object} Held
 * @property {number} size - bytes
 * @property {number} total - groups
 * @property {Uint8Array} bits - the groups it holds
 * @property {number} count - how many
 */

export class Holdings {
  /** @param {{groupLog?: number}} [opts] */
  constructor ({ groupLog = DEFAULT_GROUP_LOG } = {}) {
    this.groupLog = groupLog
    /** @type {Map<string, Map<string, Held>>} */
    this.peers = new Map() // peer id → Map(root hex → { size, total, bits, count })
    /** @type {Map<string, number>} */
    this.watched = new Map() // root hex → size: roots we ask every peer about
  }

  /**
   * A peer described what it holds (`have`). Replaces whatever we knew.
   *
   * @param {string} peerId
   * @param {string} root
   * @param {{size: number, groupLog: number, bitfield: Uint8Array|null}} have
   */
  set (peerId, root, { size, groupLog, bitfield }) {
    if (groupLog !== this.groupLog) return // we cannot read that granularity: unknown, not guessed

    const total = groupCount(size, this.groupLog)
    const bits = bao.createBitfield(total)
    bits.set(b4a.from(bitfield ?? []).subarray(0, bits.length))

    this._of(peerId).set(root, { size, total, bits, count: bao.countSetBits(bits, total) })
  }

  /**
   * A peer gained one group (`holds`). Without a `have` to build on, a known `size` stands in:
   * a peer that first said "unavailable" and then began downloading only ever sends this.
   *
   * @param {string} peerId
   * @param {string} root
   * @param {number} index
   * @param {number} [size] - bytes, when known
   */
  grow (peerId, root, index, size) {
    let held = this.get(peerId, root)

    if (!held) {
      if (size === undefined) return
      const total = groupCount(size, this.groupLog)
      held = { size, total, bits: bao.createBitfield(total), count: 0 }
      this._of(peerId).set(root, held)
    }

    if (index < 0 || index >= held.total || bao.getBit(held.bits, index)) return

    bao.setBit(held.bits, index)
    held.count++
  }

  /**
   * @param {string} peerId
   * @param {string} root
   */
  remove (peerId, root) {
    this.peers.get(peerId)?.delete(root)
  }

  /** @param {string} peerId */
  dropPeer (peerId) {
    this.peers.delete(peerId)
  }

  /**
   * @param {string} peerId
   * @param {string} root
   * @returns {Held|undefined}
   */
  get (peerId, root) {
    return this.peers.get(peerId)?.get(root)
  }

  /**
   * @param {Iterable<string>} peerIds - the connected peers to count among
   * @param {string[]} roots - one root for a file; the manifest and every file for a folder
   * @returns {{peers: number, seeders: number, leechers: number}} a seeder holds every group
   *   of every root, a leecher holds some but not all, anyone else is in neither
   */
  count (peerIds, roots) {
    const counts = { peers: 0, seeders: 0, leechers: 0 }

    for (const id of peerIds) {
      counts.peers++
      if (roots.length === 0) continue

      let complete = true
      let any = false

      for (const root of roots) {
        const held = this.get(id, root)
        if (!held || held.count < held.total) complete = false
        if (held && held.count > 0) any = true
      }

      if (complete) counts.seeders++
      else if (any) counts.leechers++
    }

    return counts
  }

  /**
   * Ask every peer about a root we hold or follow, now and whenever a new peer connects.
   *
   * @param {string} root
   * @param {number} size
   * @param {Iterable<import('./swarmwire.js').Peer>} peers
   * @param {(root: string) => boolean} skip - not asked about, for now
   */
  watch (root, size, peers, skip) {
    this.watched.set(root, size)
    for (const peer of peers) this._want(peer, root, size, skip)
  }

  /** @param {string} root */
  unwatch (root) {
    this.watched.delete(root)
  }

  /**
   * @param {import('./swarmwire.js').Peer} peer
   * @param {(root: string) => boolean} skip
   */
  wantAll (peer, skip) {
    for (const [root, size] of this.watched) this._want(peer, root, size, skip)
  }

  /**
   * @param {import('./swarmwire.js').Peer} peer
   * @param {string} root
   * @param {number} size
   * @param {(root: string) => boolean} skip
   */
  _want (peer, root, size, skip) {
    // shortcut: wants for every file of a served folder; watch lazily if folders grow past ~10k files
    if (skip(root)) return
    peer.send.want({ root: b4a.from(root, 'hex'), size })
  }

  /** @param {string} peerId */
  _of (peerId) {
    /** @type {Map<string, Held>|undefined} */
    let held = this.peers.get(peerId)
    if (!held) this.peers.set(peerId, held = new Map())
    return held
  }
}
