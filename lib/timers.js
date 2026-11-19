/**
 * Time, injected.
 *
 * Tests advance it by hand instead of sleeping.
 */

export const systemTimers = {
  /**
   * @param {number} ms
   * @param {Function} fn
   * @returns {Function} cancel
   */
  setTimer (ms, fn) {
    const timer = setTimeout(fn, ms)
    if (typeof timer.unref === 'function') timer.unref() // never hold a process open

    return () => clearTimeout(timer)
  }
}
