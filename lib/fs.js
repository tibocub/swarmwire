/**
 * The only module that touches a filesystem.
 *
 * Everything else goes through here so that Bare can supply `bare-fs` without the rest of the
 * library knowing. Keep this thin: open, read at an offset, write at an offset, stat, unlink.
 */

import fs from 'fs'
import b4a from 'b4a'

/**
 * A file opened for reading ranges.
 *
 * @typedef {object} ReadHandle
 * @property {(offset: number, length: number) => Promise<Uint8Array>} read - fewer bytes at the end of the file
 * @property {() => Promise<void>} close
 */

/**
 * A file opened for writing ranges, at its final size.
 *
 * @typedef {object} WriteHandle
 * @property {(offset: number, data: Uint8Array) => Promise<void>} write
 * @property {(offset: number, length: number) => Promise<Uint8Array>} read
 * @property {() => Promise<void>} sync
 * @property {() => Promise<void>} close
 */

/**
 * A file opened for appending, readable too.
 *
 * @typedef {object} AppendHandle
 * @property {number} size - bytes written so far
 * @property {(offset: number, length: number) => Promise<Uint8Array>} read
 * @property {(data: Uint8Array) => Promise<void>} append
 * @property {(size: number) => Promise<void>} truncate
 * @property {() => Promise<void>} close
 */

/**
 * `fd:N` names an already-open descriptor instead of a path (Android hands out descriptors
 * for picked files, with no path). Read-only, files only; the caller keeps it open.
 * shortcut: sync fstat/read on the fd, upgrade if the blocking reads ever show up in profiles.
 */
const fdOf = (/** @type {string} */ path) => (/^fd:\d+$/.test(path) ? Number(path.slice(3)) : null)

/**
 * @param {string} path
 * @returns {Promise<{size: number, mtimeMs: number, directory: boolean}|null>} null if it
 *   does not exist
 */
export async function stat (path) {
  const fd = fdOf(path)
  if (fd !== null) {
    const st = fs.fstatSync(fd)
    return { size: st.size, mtimeMs: Math.floor(st.mtimeMs), directory: false }
  }

  try {
    const st = await fs.promises.stat(path)
    return { size: st.size, mtimeMs: Math.floor(st.mtimeMs), directory: st.isDirectory() }
  } catch (err) {
    if (/** @type {{code?: string}} */ (err).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Open a file for reading byte ranges out of it, in place.
 *
 * @param {string} path - a file path, or `fd:N`
 * @returns {Promise<ReadHandle>}
 */
export async function openRead (path) {
  const fd = fdOf(path)
  if (fd !== null) {
    return {
      async read (offset, length) {
        const buffer = b4a.alloc(length)
        const bytesRead = length === 0 ? 0 : fs.readSync(fd, buffer, 0, length, offset)
        return bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
      },

      async close () {} // not ours to close; async like the other: callers chain .catch() on it
    }
  }

  const handle = await fs.promises.open(path, 'r')

  return {
    async read (offset, length) {
      const buffer = b4a.alloc(length)
      if (length === 0) return buffer

      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
    },

    close () {
      return handle.close()
    }
  }
}

/**
 * Open a file for writing byte ranges into it, creating it and giving it its final size up
 * front so ranges can land in any order.
 *
 * @param {string} path
 * @param {{size: number}} opts
 * @returns {Promise<WriteHandle>}
 */
export async function openWrite (path, { size }) {
  const handle = await fs.promises.open(path, (await stat(path)) ? 'r+' : 'w+')
  await handle.truncate(size)

  return {
    async write (offset, data) {
      if (data.length === 0) return
      await handle.write(data, 0, data.length, offset)
    },

    /** Reading back matters: a partial download serves the groups it already holds. */
    async read (offset, length) {
      const buffer = b4a.alloc(length)
      if (length === 0) return buffer

      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
    },

    sync () {
      return handle.sync()
    },

    close () {
      return handle.close()
    }
  }
}

/**
 * Open a file for appending, readable too. Used for the append-only part file, where every
 * write goes to the end and reads walk back over what was written.
 *
 * @param {string} path
 * @returns {Promise<AppendHandle>}
 */
export async function openAppend (path) {
  // Not 'a+': Windows cannot truncate an append handle, and a content mismatch truncates.
  const handle = await fs.promises.open(path, (await stat(path)) ? 'r+' : 'w+')
  const info = await handle.stat()

  // Serialised: two concurrent appends reading the same end would overwrite each other.
  let tail = Promise.resolve()

  return {
    size: info.size,

    async read (offset, length) {
      const buffer = b4a.alloc(length)
      if (length === 0) return buffer

      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
    },

    /** @this {AppendHandle} */
    append (data) {
      const write = tail.then(async () => {
        await handle.write(data, 0, data.length, this.size)
        this.size += data.length
      })

      tail = write.catch(() => {}) // a failed append must not wedge the queue
      return write
    },

    /** @this {AppendHandle} */
    async truncate (size) {
      await handle.truncate(size)
      this.size = size
    },

    close () {
      return handle.close()
    }
  }
}

/**
 * Every file under a directory, as paths relative to it, in a stable order.
 *
 * Symbolic links are skipped rather than followed: a link pointing outside the folder would
 * quietly put somebody else's file into a collection.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function list (dir) {
  /** @type {string[]} */
  const found = []

  /**
   * @param {string} current
   * @param {string} prefix
   */
  async function walk (current, prefix) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true })

    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name

      if (entry.isDirectory()) await walk(current + '/' + entry.name, relative)
      else if (entry.isFile()) found.push(relative)
    }
  }

  await walk(dir, '')
  return found
}

/**
 * @param {string} dir
 * @returns {Promise<unknown>}
 */
export function mkdir (dir) {
  return fs.promises.mkdir(dir, { recursive: true })
}

/**
 * Small whole-file helpers, for sidecars only.
 *
 * @param {string} path
 * @returns {Promise<Uint8Array|null>} null if it does not exist
 */
export async function readFile (path) {
  try {
    return await fs.promises.readFile(path)
  } catch (err) {
    if (/** @type {{code?: string}} */ (err).code === 'ENOENT') return null
    throw err
  }
}

/**
 * @param {string} path
 * @param {Uint8Array} data
 * @returns {Promise<void>}
 */
export function writeFile (path, data) {
  return fs.promises.writeFile(path, data)
}

/** @param {string} path */
export async function unlink (path) {
  try {
    await fs.promises.unlink(path)
  } catch (err) {
    if (/** @type {{code?: string}} */ (err).code !== 'ENOENT') throw err
  }
}

/**
 * Move a file into place, replacing whatever is there.
 *
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
export function rename (from, to) {
  return fs.promises.rename(from, to)
}
