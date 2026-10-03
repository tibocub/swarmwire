/**
 * Serving content that already exists somewhere on disk.
 *
 * There is no import step and no store: a file is addressed where it lies, read where it lies,
 * and nothing is written next to it. The only state kept is its group hashes, which are derived
 * on first use and remembered for as long as the file keeps its size and mtime.
 */

import { GroupTree, GroupTreeBuilder, groupRange, groupLength, DEFAULT_GROUP_LOG } from './tree.js'
import * as fsx from './fs.js'

/** path+size+mtime → group hashes. Process-local; a persistent cache can come later. */
const hashes = new Map()

export function clearHashCache () {
  hashes.clear()
}

export class ContentSource {
  /**
   * @param {string} path
   * @param {{groupLog?: number}} [opts]
   * @returns {Promise<ContentSource>}
   */
  static async open (path, { groupLog = DEFAULT_GROUP_LOG } = {}) {
    const info = await fsx.stat(path)
    if (info === null) throw new Error(`no such file: ${path}`)

    const file = await fsx.openRead(path)

    try {
      const key = `${path}\u0000${info.size}\u0000${info.mtimeMs}\u0000${groupLog}`
      const remembered = hashes.get(key)

      const tree = remembered
        ? GroupTree.fromGroupHashes(remembered, { size: info.size, groupLog })
        : await hashFile(file, info.size, groupLog)

      if (!remembered) hashes.set(key, tree.groupHashes)

      return new ContentSource(path, file, tree, { cached: !!remembered })
    } catch (err) {
      await file.close()
      throw err
    }
  }

  /**
   * Take over a file whose tree is already known — a download that just finished. Re-hashing
   * it would be pointless work: every group was hashed on the way in.
   *
   * @param {string} path
   * @param {import('./tree.js').GroupTree} tree
   * @returns {Promise<ContentSource>}
   */
  static async adopt (path, tree) {
    return new ContentSource(path, await fsx.openRead(path), tree, { cached: true })
  }

  constructor (path, file, tree, { cached }) {
    this.path = path
    this.tree = tree
    this.cached = cached

    this._file = file
  }

  /** The content address: the plain BLAKE3 hash, hex encoded. */
  get root () {
    return this.tree.root
  }

  get size () {
    return this.tree.size
  }

  get groupLog () {
    return this.tree.groupLog
  }

  get groupCount () {
    return this.tree.groupCount
  }

  /**
   * Read one group straight from the file.
   *
   * @param {number} index
   * @returns {Promise<Uint8Array>}
   */
  async readGroup (index) {
    const { offset, length } = groupRange(index, this.size, this.groupLog)
    return this._file.read(offset, length)
  }

  /**
   * The hashes proving a group belongs to this root.
   *
   * @param {number} index
   * @returns {Uint8Array[]}
   */
  proof (index) {
    return this.tree.proof(index)
  }

  close () {
    return this._file.close()
  }
}

async function hashFile (file, size, groupLog) {
  const builder = new GroupTreeBuilder({ groupLog })
  const len = groupLength(groupLog)

  for (let offset = 0; offset < size; offset += len) {
    builder.push(await file.read(offset, Math.min(len, size - offset)))
  }

  return builder.finalize()
}
