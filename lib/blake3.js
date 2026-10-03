/**
 * The hashing primitives, imported from one place.
 *
 * Everything that needs BLAKE3 or bao goes through here rather than reaching for
 * `blake3-bao` directly, so the CommonJS detour that keeps us running on Bare — see
 * `blake3.cjs` — stays in a single file.
 */

import bridge from './blake3.cjs'

export const blake3 = bridge.blake3
export const bao = bridge.bao
