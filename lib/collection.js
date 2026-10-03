/**
 * A collection: a folder reduced to a list of content addresses.
 *
 * The manifest is itself content, so it has an address like anything else — sending a folder
 * is sending one link, and the receiver fetches the manifest first and then the files it
 * names. Nothing about it is mutable: change a file and you have a different manifest with a
 * different address. Folders that change belong to SwarmFS, one layer up.
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
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024

/**
 * @param {{path: string, root: string, size: number}[]} files
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
 * Everything here arrived from a stranger, so nothing is taken on trust: a path that climbs
 * out of the destination directory is the obvious attack, and the content addresses are
 * meaningless if the paths they are written to are not.
 *
 * @param {Uint8Array} bytes
 * @returns {{path: string, root: string, size: number}[]}
 */
export function decodeManifest (bytes) {
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('manifest is implausibly large')

  let parsed
  try {
    parsed = JSON.parse(b4a.toString(bytes, 'utf8'))
  } catch {
    throw new Error('manifest is not valid JSON')
  }

  if (parsed?.swarmwire !== MANIFEST_TYPE) throw new Error('not a swarmwire collection')
  if (!Array.isArray(parsed.files)) throw new Error('manifest has no file list')

  // Paths are checked as they arrived, never normalised first. Quietly turning
  // "/etc/passwd" into "etc/passwd" would write somewhere the sender did not name, and a
  // manifest whose paths are not already canonical is not one we made.
  const entries = parsed.files.map((file) => ({
    path: file?.path,
    root: file?.root,
    size: file?.size
  }))

  for (const entry of entries) assertEntry(entry)
  assertNoDuplicates(entries)

  return entries
}

/** The total size of everything a manifest names. */
export function totalSize (files) {
  return files.reduce((sum, file) => sum + file.size, 0)
}

/**
 * Normalise a path for the manifest: forward slashes, no leading slash, no `.` segments.
 *
 * This does not decide whether a path is safe — `assertEntry` does that — it only makes the
 * same folder produce the same bytes whichever platform packed it.
 */
export function normalisePath (path) {
  return String(path)
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
}

/** Is this a path we are willing to write to, under a destination directory? */
export function isSafePath (path) {
  if (typeof path !== 'string' || path === '') return false
  if (path.length > 4096) return false
  if (path !== normalisePath(path)) return false

  const segments = path.split('/')
  if (segments.some((segment) => segment === '..')) return false

  // Windows refuses these as filenames, and a path that works on one machine and not another
  // is a collection that cannot be received everywhere.
  if (/[<>:"|?*\u0000-\u001f]/.test(path)) return false
  if (/^[a-zA-Z]:/.test(path)) return false

  return true
}

function assertEntry (entry) {
  if (!isSafePath(entry.path)) throw new Error(`unsafe path in manifest: ${JSON.stringify(entry.path)}`)
  if (typeof entry.root !== 'string' || !/^[0-9a-f]{64}$/.test(entry.root)) {
    throw new Error(`bad root in manifest for ${entry.path}`)
  }
  if (!Number.isInteger(entry.size) || entry.size < 0) {
    throw new Error(`bad size in manifest for ${entry.path}`)
  }
}

function assertNoDuplicates (entries) {
  const seen = new Set()

  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`duplicate path in manifest: ${entry.path}`)
    seen.add(entry.path)
  }
}
