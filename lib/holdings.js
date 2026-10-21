/**
 * What connected peers say they hold, and the counts that follow from it.
 *
 * A node only hears about a peer's holdings if it asked: `want` is answered with `have`, and
 * the peer then pushes `holds` as it gains groups. A node that only serves never asks, so it
 * keeps a watch set — the roots it serves — and sends `want` for those to every peer. That is
 * the whole mechanism; there is no message for it.
 *
 * Counts are of direct connections. Nothing here knows about the rest of the swarm.
 */

import b4a from 'b4a'

import { bao } from './blake3.js'
import { DEFAULT_GROUP_LOG, groupCount } from './tree.js'

export class Holdings {
  constructor ({ groupLog = DEFAULT_GROUP_LOG } = {}) {
    this.groupLog = groupLog
    this.peers = new Map() // peer id → Map(root hex → { size, total, bits, count })
    this.watched = new Map() // root hex → size: roots we ask every peer about
  }

  /** A peer described what it holds (`have`). Replaces whatever we knew. */
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

  /** The peer says it has none of this (`unavailable`). */
  remove (peerId, root) {
    this.peers.get(peerId)?.delete(root)
  }

  dropPeer (peerId) {
    this.peers.delete(peerId)
  }

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

  // -- the watch set ---------------------------------------------------------

  /** Ask every peer about a root we hold or follow, now and whenever a new peer connects. */
  watch (root, size, peers, skip) {
    this.watched.set(root, size)
    for (const peer of peers) this._want(peer, root, size, skip)
  }

  unwatch (root) {
    this.watched.delete(root)
  }

  /** A peer just connected: tell it what we are watching. */
  wantAll (peer, skip) {
    for (const [root, size] of this.watched) this._want(peer, root, size, skip)
  }

  _want (peer, root, size, skip) {
    // shortcut: wants for every file of a served folder; watch lazily if folders grow past ~10k files
    if (skip(root)) return // a download already asked this peer
    peer.send.want({ root: b4a.from(root, 'hex'), size })
  }

  _of (peerId) {
    let held = this.peers.get(peerId)
    if (!held) this.peers.set(peerId, held = new Map())
    return held
  }
}
