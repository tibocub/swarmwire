/**
 * The only module that touches a filesystem.
 *
 * Everything else goes through here so that Bare can supply `bare-fs` without the rest of the
 * library knowing. Keep this thin: open, read at an offset, write at an offset, stat, unlink.
 */

import fs from 'fs'
import b4a from 'b4a'

/**
 * @param {string} path
 * @returns {Promise<{size: number, mtimeMs: number}|null>} null if it does not exist
 */
export async function stat (path) {
  try {
    const st = await fs.promises.stat(path)
    return { size: st.size, mtimeMs: Math.floor(st.mtimeMs) }
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/** Open a file for reading byte ranges out of it, in place. */
export async function openRead (path) {
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
 */
export async function openAppend (path) {
  // Not 'a+': Windows refuses to truncate a handle opened in append mode, and we need to
  // truncate when the file turns out to describe different content. Track the end ourselves.
  const handle = await fs.promises.open(path, (await stat(path)) ? 'r+' : 'w+')
  const info = await handle.stat()

  // Appends are serialised. Groups are verified concurrently, and two appends that each read
  // the end of the file before either wrote would land on top of each other.
  let tail = Promise.resolve()

  return {
    size: info.size,

    async read (offset, length) {
      const buffer = b4a.alloc(length)
      if (length === 0) return buffer

      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
    },

    append (data) {
      const write = tail.then(async () => {
        await handle.write(data, 0, data.length, this.size)
        this.size += data.length
      })

      tail = write.catch(() => {}) // a failed append must not wedge the queue
      return write
    },

    async truncate (size) {
      await handle.truncate(size)
      this.size = size
    },

    close () {
      return handle.close()
    }
  }
}

/** Small whole-file helpers, for sidecars only. */
export async function readFile (path) {
  try {
    return await fs.promises.readFile(path)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export function writeFile (path, data) {
  return fs.promises.writeFile(path, data)
}

export async function unlink (path) {
  try {
    await fs.promises.unlink(path)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}
