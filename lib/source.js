/**
 * Serving content that already exists somewhere on disk.
 *
 * No import step and no store: the only state kept is each file's group hashes, remembered while
 * its size and mtime are unchanged. Those can lie, so every group is checked again as it is read.
 */

import b4a from 'b4a'
import { GroupTree, GroupTreeBuilder, groupRange, groupLength, groupHash, DEFAULT_GROUP_LOG } from './tree.js'
import * as fsx from './fs.js'

/**
 * path+size+mtime → group hashes, least recently used first. Process-local.
 *
 * @type {Map<string, Uint8Array[]>}
 */
const hashes = new Map()

/** `limit` bounds the bytes of group hashes kept: 32 MiB is 32 GiB of content at the default group size. */
export const hashCache = { limit: 32 * 1024 * 1024, bytes: 0 }

/** Forget every remembered file's hashes. */
export function clearHashCache () {
  hashes.clear()
  hashCache.bytes = 0
}

/**
 * @param {string} key
 * @param {Uint8Array[]} groupHashes
 */
function remember (key, groupHashes) {
  forget(key)
  if (groupHashes.length * 32 > hashCache.limit) return // would push out everything else
  hashes.set(key, groupHashes)
  hashCache.bytes += groupHashes.length * 32

  for (const oldest of hashes.keys()) {
    if (hashCache.bytes <= hashCache.limit) break
    forget(oldest)
  }
}

/** @param {string} key */
function forget (key) {
  const old = hashes.get(key)
  if (!old) return
  hashes.delete(key)
  hashCache.bytes -= old.length * 32
}

/**
 * The content address of a file: its plain BLAKE3 hash, hex encoded, read a group at a time.
 *
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function hashFile (path) {
  const source = await ContentSource.open(path)
  await source.close()
  return source.root
}

/**
 * A file on disk, served in place: its group tree, and reads checked against it.
 * Properties: `path`, `tree`, `root`, `size`, `groupLog`, `groupCount`, and `cached` (true
 * when the hashes came from memory rather than reading the file).
 */
export class ContentSource {
  /**
   * Open and hash a file, or reuse its remembered hashes if its size and mtime are unchanged.
   *
   * @param {string} path - a file path, or `fd:N` for an already-open descriptor
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
        : await buildTree(file, info.size, groupLog)

      remember(key, /** @type {Uint8Array[]} */ (tree.groupHashes)) // a tree of a whole file has every hash; again on a hit: it is now the most recently used

      return new ContentSource(path, file, tree, { cached: !!remembered, key })
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

  /**
   * @param {string} path
   * @param {import('./fs.js').ReadHandle} file
   * @param {GroupTree} tree - complete
   * @param {{cached: boolean, key?: string|null}} opts
   */
  constructor (path, file, tree, { cached, key = null }) {
    this.path = path
    this.tree = tree
    this.cached = cached

    this._file = file
    this._key = key
  }

  /**
   * The content address: the plain BLAKE3 hash, hex encoded.
   *
   * @returns {string}
   */
  get root () {
    return /** @type {string} */ (this.tree.root) // the tree is complete
  }

  /** @returns {number} bytes */
  get size () {
    return this.tree.size
  }

  /** @returns {number} */
  get groupLog () {
    return this.tree.groupLog
  }

  /** @returns {number} */
  get groupCount () {
    return this.tree.groupCount
  }

  /**
   * Read one group straight from the file, checked against the tree first: a file changed on
   * disk (even keeping its size and mtime) fails with code `CHANGED` rather than give wrong
   * bytes, and its remembered hashes are forgotten.
   *
   * @param {number} index
   * @returns {Promise<Uint8Array>}
   */
  async readGroup (index) {
    const { offset, length } = groupRange(index, this.size, this.groupLog)
    const data = await this._file.read(offset, length)

    const only = this.groupCount === 1
    if (data.length !== length || !b4a.equals(groupHash(data, index, { groupLog: this.groupLog, only }), /** @type {Uint8Array} */ (this.tree.groupHashes[index]))) {
      if (this._key) forget(this._key)
      throw Object.assign(new Error(`changed on disk: ${this.path}`), { code: 'CHANGED' })
    }

    return data
  }

  /**
   * The hashes proving a group belongs to this root.
   *
   * @param {number} index
   * @returns {Uint8Array[]}
   */
  proof (index) {
    return /** @type {Uint8Array[]} */ (this.tree.proof(index)) // a complete tree proves every group
  }

  /** @returns {Promise<void>} */
  close () {
    return this._file.close()
  }
}

/**
 * Content held in memory rather than on disk, with the same shape as a ContentSource.
 *
 * A collection's manifest is content like any other and has to be served, but writing it
 * beside the folder it describes would mean the act of sharing a folder changed it.
 */
export class MemorySource {
  /**
   * @param {Uint8Array} bytes
   * @param {{groupLog?: number}} [opts]
   * @returns {MemorySource}
   */
  static from (bytes, { groupLog = DEFAULT_GROUP_LOG } = {}) {
    return new MemorySource(bytes, GroupTree.fromContent(bytes, { groupLog }))
  }

  /**
   * @param {Uint8Array} bytes
   * @param {GroupTree} tree - of `bytes`
   */
  constructor (bytes, tree) {
    /** @type {string|null} */
    this.path = null // held in memory, not at a path
    this.tree = tree
    this.cached = true

    this._bytes = bytes
  }

  /** @returns {string} */
  get root () {
    return /** @type {string} */ (this.tree.root) // the tree is complete
  }

  /** @returns {number} bytes */
  get size () {
    return this.tree.size
  }

  /** @returns {number} */
  get groupLog () {
    return this.tree.groupLog
  }

  /** @returns {number} */
  get groupCount () {
    return this.tree.groupCount
  }

  /**
   * @param {number} index
   * @returns {Promise<Uint8Array>}
   */
  async readGroup (index) {
    const { offset, length } = groupRange(index, this.size, this.groupLog)
    return this._bytes.subarray(offset, offset + length)
  }

  /**
   * @param {number} index
   * @returns {Uint8Array[]}
   */
  proof (index) {
    return /** @type {Uint8Array[]} */ (this.tree.proof(index)) // a complete tree proves every group
  }

  /** @returns {Promise<void>} */
  async close () {}
}

/**
 * @param {import('./fs.js').ReadHandle} file
 * @param {number} size
 * @param {number} groupLog
 */
async function buildTree (file, size, groupLog) {
  const builder = new GroupTreeBuilder({ groupLog })
  const len = groupLength(groupLog)

  for (let offset = 0; offset < size; offset += len) {
    builder.push(await file.read(offset, Math.min(len, size - offset)))
  }

  return builder.finalize()
}
