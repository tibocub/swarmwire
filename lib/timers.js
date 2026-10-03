/**
 * Time, injected.
 *
 * The transfer engine needs to give up on a peer that goes quiet, which means it needs a
 * clock. Taking the clock as a dependency keeps `setTimeout` out of the engine, so the test
 * harness can advance time by hand instead of tests sleeping and hoping.
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
