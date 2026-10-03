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

    sync () {
      return handle.sync()
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
