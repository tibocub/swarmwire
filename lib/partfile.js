/**
 * The `.swarmwire-part` file: what a half-finished download knows.
 *
 * A fixed header, then one 41-byte record per tree node learned, appended as groups arrive, so
 * a crash loses at most the last group. A leaf is the range [i, i+1); proof hashes are wider.
 *
 *   header   "SWPT" | version u8 | groupLog u8 | size u64 | root 32B
 *   record   start u32 | end u32 | held u8 | hash 32B
 *
 * `held` separates the two things a record can mean. A hash learned from somebody's proof
 * tells you what a group *would* hash to; only a group you actually received is on disk.
 * Confusing the two would have a resumed download claim data it never had.
 *
 * A trailing partial record is ignored: a crash mid-append costs that one node.
 */

import b4a from 'b4a'

import * as fsx from './fs.js'

export const SUFFIX = '.swarmwire-part'

const MAGIC = 'SWPT'
const VERSION = 2
const HEADER_SIZE = 4 + 1 + 1 + 8 + 32
const RECORD_SIZE = 4 + 4 + 1 + 32

export class PartFile {
  /**
   * Open the part file for this download, reusing it only if it describes the same content.
   *
   * @param {string} path - the destination path (the suffix is added here)
   * @param {{root: string, size: number, groupLog: number}} content
   * @returns {Promise<{part: PartFile, nodes: {start: number, end: number, hash: Uint8Array}[]}>}
   */
  static async open (path, { root, size, groupLog }) {
    const file = await fsx.openAppend(path + SUFFIX)
    const part = new PartFile(file)

    try {
      const header = file.size >= HEADER_SIZE ? decodeHeader(await file.read(0, HEADER_SIZE)) : null
      const matches = header &&
        header.root === root &&
        header.size === size &&
        header.groupLog === groupLog

      if (!matches) {
        // Someone else's progress, or ours from before the content changed. Never merge it.
        await file.truncate(0)
        await file.append(encodeHeader({ root, size, groupLog }))
        return { part, nodes: [] }
      }

      return { part, nodes: await readRecords(file) }
    } catch (err) {
      await file.close()
      throw err
    }
  }

  constructor (file) {
    this._file = file
  }

  /**
   * Append the nodes learned from one verified group.
   *
   * @param {{start: number, end: number, hash: Uint8Array, held?: boolean}[]} nodes
   */
  async record (nodes) {
    if (nodes.length === 0) return

    const batch = b4a.alloc(RECORD_SIZE * nodes.length)

    nodes.forEach(({ start, end, hash, held = false }, i) => {
      const at = i * RECORD_SIZE
      writeUint32(batch, at, start)
      writeUint32(batch, at + 4, end)
      batch[at + 8] = held ? 1 : 0
      b4a.copy(b4a.from(hash), batch, at + 9)
    })

    await this._file.append(batch)
  }

  close () {
    return this._file.close()
  }

  static remove (path) {
    return fsx.unlink(path + SUFFIX)
  }
}

async function readRecords (file) {
  const nodes = []
  const count = Math.floor((file.size - HEADER_SIZE) / RECORD_SIZE)
  if (count <= 0) return nodes

  const body = await file.read(HEADER_SIZE, count * RECORD_SIZE)

  for (let i = 0; i < count; i++) {
    const at = i * RECORD_SIZE
    nodes.push({
      start: readUint32(body, at),
      end: readUint32(body, at + 4),
      held: body[at + 8] === 1,
      hash: b4a.from(body.subarray(at + 9, at + RECORD_SIZE))
    })
  }

  return nodes
}

function encodeHeader ({ root, size, groupLog }) {
  const header = b4a.alloc(HEADER_SIZE)

  b4a.write(header, MAGIC, 0, 'ascii')
  header[4] = VERSION
  header[5] = groupLog
  writeUint64(header, 6, size)
  b4a.copy(b4a.from(root, 'hex'), header, 14)

  return header
}

function decodeHeader (bytes) {
  if (bytes.length < HEADER_SIZE) return null
  if (b4a.toString(bytes.subarray(0, 4), 'ascii') !== MAGIC) return null
  if (bytes[4] !== VERSION) return null

  return {
    groupLog: bytes[5],
    size: readUint64(bytes, 6),
    root: b4a.toString(bytes.subarray(14, 46), 'hex')
  }
}

function writeUint32 (buffer, offset, value) {
  buffer[offset] = value & 0xff
  buffer[offset + 1] = (value >>> 8) & 0xff
  buffer[offset + 2] = (value >>> 16) & 0xff
  buffer[offset + 3] = (value >>> 24) & 0xff
}

function readUint32 (buffer, offset) {
  return buffer[offset] |
    (buffer[offset + 1] << 8) |
    (buffer[offset + 2] << 16) |
    (buffer[offset + 3] << 24)
}

/** Sizes stay well inside 2^53, so splitting into two 32-bit halves is enough. */
function writeUint64 (buffer, offset, value) {
  writeUint32(buffer, offset, value >>> 0)
  writeUint32(buffer, offset + 4, Math.floor(value / 0x100000000))
}

function readUint64 (buffer, offset) {
  return (readUint32(buffer, offset) >>> 0) + (readUint32(buffer, offset + 4) >>> 0) * 0x100000000
}
