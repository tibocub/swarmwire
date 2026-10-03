/** A clock a test winds by hand. Nothing fires until `advance()` says so. */

export class TestClock {
  constructor () {
    this.now = 0
    this.pending = []
    this.fired = 0
  }

  setTimer (ms, fn) {
    const timer = { at: this.now + ms, fn, cancelled: false }
    this.pending.push(timer)

    return () => { timer.cancelled = true }
  }

  /** Move time forward, firing everything that comes due, in order. */
  advance (ms) {
    const until = this.now + ms

    for (;;) {
      const due = this.pending
        .filter((timer) => !timer.cancelled && timer.at <= until)
        .sort((a, b) => a.at - b.at)

      if (due.length === 0) break

      const next = due[0]
      this.pending.splice(this.pending.indexOf(next), 1)
      this.now = next.at
      this.fired++
      next.fn()
    }

    this.now = until
  }

  get waiting () {
    return this.pending.filter((timer) => !timer.cancelled).length
  }
}
