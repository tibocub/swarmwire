/**
 * The hashing primitives, imported from one place.
 *
 * Everything that needs BLAKE3 or bao goes through here rather than reaching for
 * `blake3-bao` directly, so the CommonJS detour that keeps us running on Bare — see
 * `blake3.cjs` — stays in a single file.
 */

import bridge from './blake3.cjs'

// Typed here: blake3-bao's own .d.ts files resolve to nothing, so its functions would be `any`.

/**
 * @typedef {object} Blake3
 * @property {(input: string|Uint8Array, outputLen?: number) => string} hashHex
 */

/**
 * @typedef {object} Bao
 * @property {(data: Uint8Array, startChunkIndex: number, isRoot?: boolean) => Uint8Array} chunkGroupCV
 * @property {(left: Uint8Array, right: Uint8Array, isRoot?: boolean) => Uint8Array} parentCV
 * @property {(a: Uint8Array, b: Uint8Array) => boolean} constantTimeEqual
 * @property {(bits: number) => Uint8Array} createBitfield
 * @property {(bitfield: Uint8Array, index: number) => boolean} getBit
 * @property {(bitfield: Uint8Array, index: number) => void} setBit
 * @property {(bitfield: Uint8Array, index: number) => void} clearBit
 * @property {(bitfield: Uint8Array, bits: number) => number} countSetBits
 */

/** @type {Blake3} */
export const blake3 = bridge.blake3
/** @type {Bao} */
export const bao = bridge.bao
