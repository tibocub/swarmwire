import test from 'brittle'

import { OnDemand, IDLE_CLOSE } from '../../lib/on-demand.js'
import { TestClock } from '../helpers/clock.js'

/** A source whose reads finish when the test says so. */
function fakeSource () {
  const source = {
    closed: 0,
    pending: [],
    readGroup () { return new Promise((resolve) => source.pending.push(resolve)) },
    close () { source.closed++; return Promise.resolve() }
  }
  return source
}

function make (clock) {
  // Says yes to everyone; nothing is opened through it, the tests add their sources.
  return new OnDemand({ resolve: () => 'held', max: 64, groupLog: 4, timers: clock })
}

test('an unread source is closed after the idle time, and every get pushes it back', async (t) => {
  const clock = new TestClock()
  const onDemand = make(clock)
  const source = fakeSource()
  onDemand.add('r', source)

  clock.advance(IDLE_CLOSE - 1)
  await onDemand.get('r', { id: 'p', publicKey: null })
  clock.advance(IDLE_CLOSE - 1)
  t.is(source.closed, 0, 'a get restarts the countdown')

  clock.advance(1)
  t.is(source.closed, 1, 'closed once idle')
  t.absent(onDemand.open.has('r'), 'and forgotten, so the next get reopens it')
  t.is(clock.waiting, 0, 'no timer left behind')
})

test('a source being read is never closed by the idle timer, and is closed idle after the read', async (t) => {
  const clock = new TestClock()
  const onDemand = make(clock)
  const source = fakeSource()
  onDemand.add('r', source)

  const reading = onDemand.read('r', source, 0)
  clock.advance(IDLE_CLOSE * 3)
  t.is(source.closed, 0, 'not closed mid-read')
  t.ok(onDemand.open.has('r'))

  source.pending[0]('bytes')
  t.is(await reading, 'bytes')

  clock.advance(IDLE_CLOSE - 1)
  t.is(source.closed, 0, 'the countdown starts when the read ends')
  clock.advance(1)
  t.is(source.closed, 1)
})

test('close cancels every idle timer', async (t) => {
  const clock = new TestClock()
  const onDemand = make(clock)
  onDemand.add('a', fakeSource())
  onDemand.add('b', fakeSource())

  await onDemand.close()
  t.is(clock.waiting, 0)
})
