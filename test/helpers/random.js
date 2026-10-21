/** A seeded generator: the same seed gives the same numbers in [0, 1), on every runtime. */
export function xorshift (seed = 1) {
  let x = seed >>> 0 || 1

  return () => {
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    return x / 2 ** 32
  }
}
