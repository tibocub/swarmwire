/**
 * BLAKE3 and bao, reached through CommonJS.
 *
 * `blake3-bao`'s ESM entry points are thin wrappers that call `createRequire` from Node's
 * `module` builtin, which does not exist on Bare — so importing them directly makes the whole
 * library Node-only. The CommonJS files underneath are plain JavaScript and load identically
 * on both runtimes, so this is the one place that reaches for them.
 *
 * Verified: the same input hashes to the same value under Node and Bare.
 */

const blake3 = require('blake3-bao/blake3')
const bao = require('blake3-bao/bao')

module.exports = { blake3, bao }
