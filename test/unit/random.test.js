import test from 'brittle'
import { xorshift } from '../helpers/random.js'

const take = (random, n) => Array.from({ length: n }, random)

test('the same seed gives the same numbers, another seed other ones', (t) => {
  t.alike(take(xorshift(7), 5), take(xorshift(7), 5))
  t.not(take(xorshift(7), 5).join(), take(xorshift(8), 5).join())
  t.ok(take(xorshift(7), 1000).every((n) => n >= 0 && n < 1))
})
