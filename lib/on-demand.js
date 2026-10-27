/**
 * Content served only when a peer asks for it.
 *
 * The application maps a root to a path (`resolve`); the file is opened and hashed when asked
 * for, and served only if it still hashes to that root. Nothing is kept for content nobody
 * asked for, and at most `max` files are open at once: the least recently used is closed.
 */

import { ContentSource } from './source.js'

export class OnDemand {
  /** @param {{resolve: (root: string) => string|null|Promise<string|null>, max: number, groupLog: number}} opts */
  constructor ({ resolve, max, groupLog }) {
    this.resolve = resolve
    this.max = max
    this.groupLog = groupLog
    this.open = new Map() // root → ContentSource, least recently used first
    this._loading = new Map() // root → the open in progress, shared by everyone asking
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
      return Promise.resolve(source)
    }

    let loading = this._loading.get(root)
    if (!loading) {
      loading = this._load(root).finally(() => this._loading.delete(root))
      this._loading.set(root, loading)
    }
    return loading
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
    else this.open.set(root, source)

    for (const [oldest, old] of this.open) {
      if (this.open.size <= this.max) break
      this.open.delete(oldest)
      old.close().catch(() => {}) // a read still running on it fails, and is answered as a refusal
    }
  }

  async close () {
    const sources = [...this.open.values()]
    this.open.clear()
    for (const source of sources) await source.close().catch(() => {})
  }
}
