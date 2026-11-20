/**
 * A collection: a folder reduced to a list of content addresses.
 *
 * The encoding is canonical, because the manifest's bytes are its identity: the same folder
 * must produce the same address on every machine. Entries are sorted by path, there is no
 * incidental whitespace, and paths are normalised before they are hashed.
 *
 *   {"swarmwire":"collection/v0","files":[{"path":"a.txt","root":"<hex>","size":12}]}
 */

import b4a from 'b4a'

export const MANIFEST_TYPE = 'collection/v0'

/** Enough for a folder of a million files; past that, something has gone wrong. */
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024

/**
 * One file of a collection.
 *
 * @typedef {object} FileEntry
 * @property {string} path - inside the folder, `/`-separated
 * @property {string} root - 64 hex characters
 * @property {number} size - bytes
 */

/**
 * @param {FileEntry[]} files
 * @returns {Uint8Array} the manifest's bytes, which are what gets addressed and served
 */
export function encodeManifest (files) {
  const entries = files
    .map((file) => ({
      path: normalisePath(file.path),
      root: file.root,
      size: file.size
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  for (const entry of entries) assertEntry(entry)
  assertNoDuplicates(entries)

  return b4a.from(JSON.stringify({ swarmwire: MANIFEST_TYPE, files: entries }), 'utf8')
}

/**
 * Read a manifest, refusing anything that is not one.
 *
 * It arrives from a stranger, so nothing is taken on trust, paths above all.
 *
 * @param {Uint8Array} bytes
 * @returns {FileEntry[]}
 */
export function decodeManifest (bytes) {
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('manifest is implausibly large')

  /** @type {any} */
  let parsed // JSON from a stranger: checked field by field below
  try {
    parsed = JSON.parse(b4a.toString(bytes, 'utf8'))
  } catch {
    throw new Error('manifest is not valid JSON')
  }

  if (parsed?.swarmwire !== MANIFEST_TYPE) throw new Error('not a swarmwire collection')
  if (!Array.isArray(parsed.files)) throw new Error('manifest has no file list')

  // Check paths as they arrived, never normalised first: turning "/etc/passwd" into
  // "etc/passwd" would write somewhere the sender did not name.
  const entries = parsed.files.map((/** @type {any} */ file) => ({
    path: file?.path,
    root: file?.root,
    size: file?.size
  }))

  for (const entry of entries) assertEntry(entry)
  assertNoDuplicates(entries)

  return entries
}

/**
 * @param {FileEntry[]} files
 * @returns {number} bytes
 */
export function totalSize (files) {
  return files.reduce((sum, file) => sum + file.size, 0)
}

/**
 * Normalise a path for the manifest: forward slashes, no leading slash, no `.` segments.
 *
 * Only makes bytes canonical across platforms; `isSafePath` decides what is safe.
 *
 * @param {string} path
 * @returns {string}
 */
export function normalisePath (path) {
  return String(path)
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
}

/**
 * Is this a path we are willing to write to, under a destination directory?
 *
 * @param {unknown} path
 * @returns {boolean}
 */
export function isSafePath (path) {
  if (typeof path !== 'string' || path === '') return false
  if (path.length > 4096) return false
  if (path !== normalisePath(path)) return false

  const segments = path.split('/')
  if (segments.some((segment) => segment === '..')) return false

  // Windows refuses these, and a collection must be receivable everywhere.
  if (/[<>:"|?*\u0000-\u001f]/.test(path)) return false
  if (/^[a-zA-Z]:/.test(path)) return false

  return true
}

/** @param {FileEntry} entry */
function assertEntry (entry) {
  if (!isSafePath(entry.path)) throw new Error(`unsafe path in manifest: ${JSON.stringify(entry.path)}`)
  if (typeof entry.root !== 'string' || !/^[0-9a-f]{64}$/.test(entry.root)) {
    throw new Error(`bad root in manifest for ${entry.path}`)
  }
  if (!Number.isInteger(entry.size) || entry.size < 0) {
    throw new Error(`bad size in manifest for ${entry.path}`)
  }
}

/** @param {FileEntry[]} entries */
function assertNoDuplicates (entries) {
  const seen = new Set()

  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`duplicate path in manifest: ${entry.path}`)
    seen.add(entry.path)
  }
}
