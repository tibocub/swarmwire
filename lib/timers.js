/**
 * Time, injected.
 *
 * Tests advance it by hand instead of sleeping.
 */

/**
 * A clock: `setTimer(ms, fn)` calls `fn` once after `ms` and returns a function that cancels it.
 *
 * @typedef {object} Timers
 * @property {(ms: number, fn: () => void) => () => void} setTimer
 */

/** @type {Timers} */
export const systemTimers = {
  /**
   * @param {number} ms
   * @param {() => void} fn
   * @returns {() => void} cancel
   */
  setTimer (ms, fn) {
    const timer = setTimeout(fn, ms)
    if (typeof timer.unref === 'function') timer.unref() // never hold a process open

    return () => clearTimeout(timer)
  }
}
