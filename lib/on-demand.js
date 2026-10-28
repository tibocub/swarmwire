/**
 * Content served only when a peer asks for it.
 *
 * The application maps a root to a path (`resolve`); the file is opened and hashed when asked
 * for, and served only if it still hashes to that root. Nothing is kept for content nobody
 * asked for, and at most `max` files are open at once: the least recently used is closed.
 *
 * A file nobody has read for `idle` ms is closed too. On Windows an open file pins its folder:
 * it cannot be renamed, moved or deleted while we hold it.
 */

import { ContentSource } from './source.js'
import { systemTimers } from './timers.js'

/**
 * How long a served file stays open with no read. Requests in a transfer come milliseconds
 * apart, so this never closes a file under one; a reopen is cheap anyway (the hashes are
 * remembered). Short enough that a person reorganizing a folder just synced rarely notices.
 */
export const IDLE_CLOSE = 5000

export class OnDemand {
  /**
   * @param {{resolve: (root: string) => string|null|Promise<string|null>, max: number,
   *   groupLog: number, timers?: object, idle?: number}} opts
   */
  constructor ({ resolve, max, groupLog, timers = systemTimers, idle = IDLE_CLOSE }) {
    this.resolve = resolve
    this.max = max
    this.groupLog = groupLog
    this.timers = timers
    this.idle = idle
    this.open = new Map() // root → ContentSource, least recently used first
    this._loading = new Map() // root → the open in progress, shared by everyone asking
    this._timers = new Map() // root → cancel its idle close
    this._reading = new Map() // ContentSource → reads in flight
  }

  /**
   * @param {string} root
   * @returns {Promise<ContentSource|null>} null when the application does not hold it, or no
   *   longer holds what it recorded
   */
  get (root) {
    const source = this.open.get(root)
    if (source) {
      this.open.delete(root)
      this.open.set(root, source)
      this._arm(root, source)
      return Promise.resolve(source)
    }

    let loading = this._loading.get(root)
    if (!loading) {
      loading = this._load(root).finally(() => this._loading.delete(root))
      this._loading.set(root, loading)
    }
    return loading
  }

  /** Read a group, keeping the source open until the read is done and then for `idle` more. */
  async read (root, source, index) {
    this._reading.set(source, (this._reading.get(source) ?? 0) + 1)
    try {
      return await source.readGroup(index)
    } finally {
      const left = this._reading.get(source) - 1
      if (left > 0) this._reading.set(source, left)
      else this._reading.delete(source)
      if (this.open.get(root) === source) this._arm(root, source)
    }
  }

  async _load (root) {
    let source
    try {
      const path = await this.resolve(root)
      if (path === null || path === undefined) return null
      source = await ContentSource.open(path, { groupLog: this.groupLog })
    } catch {
      return null // a resolver that fails, or a file that is gone: not held
    }

    // The file changed since the application recorded it. Serving it would be wrong bytes.
    if (source.root !== root) {
      await source.close()
      return null
    }

    this.add(root, source)
    return this.open.get(root)
  }

  /** Keep a source open, closing the least recently used beyond the limit. */
  add (root, source) {
    const existing = this.open.get(root)
    if (existing && existing !== source) source.close().catch(() => {})
    else {
      this.open.set(root, source)
      this._arm(root, source)
    }

    for (const [oldest, old] of this.open) {
      if (this.open.size <= this.max) break
      this._drop(oldest)
      old.close().catch(() => {}) // a read still running on it fails, and is answered as a refusal
    }
  }

  /** Forget a source without closing it. */
  _drop (root) {
    this._timers.get(root)?.()
    this._timers.delete(root)
    this.open.delete(root)
  }

  /** (Re)start the idle countdown. A source with a read in flight is rearmed when it ends. */
  _arm (root, source) {
    this._timers.get(root)?.()
    this._timers.set(root, this.timers.setTimer(this.idle, () => {
      this._timers.delete(root)
      if (this.open.get(root) !== source || this._reading.has(source)) return
      this.open.delete(root)
      source.close().catch(() => {})
    }))
  }

  async close () {
    const sources = [...this.open.values()]
    for (const root of [...this.open.keys()]) this._drop(root)
    for (const source of sources) await source.close().catch(() => {})
  }
}
