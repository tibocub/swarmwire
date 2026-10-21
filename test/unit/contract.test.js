import test from 'brittle'
import fs from 'fs'
import { fileURLToPath } from 'url'
import b4a from 'b4a'

import * as api from '../../index.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const contract = b4a.toString(fs.readFileSync(ROOT + 'docs/contract.md'))

/** Rows of the capabilities table: {capability, status, delivered, proof: [paths]}. */
function capabilities () {
  return contract.split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 4 && ['exists', 'planned'].includes(cells[1]))
    .map(([capability, status, delivered, proof]) => ({
      capability,
      status,
      delivered,
      proof: [...proof.matchAll(/`([^`]+)`/g)].map((match) => match[1])
    }))
}

test('every export the contract lists is exported by the package', (t) => {
  const block = contract.match(/```exports\n([\s\S]*?)```/)
  t.ok(block, 'the contract has an exports block')

  const names = block[1].split('\n').map((line) => line.trim()).filter(Boolean)
  t.ok(names.length > 0, 'and it lists something')

  for (const name of names) t.ok(name in api, `${name} is exported`)
})

test('every proof the contract cites exists on disk', (t) => {
  const rows = capabilities().filter((row) => row.status === 'exists')
  t.ok(rows.length > 0, 'the contract has capabilities that exist')

  for (const row of rows) {
    t.ok(row.proof.length > 0, `"${row.capability}" cites a proof`)
    for (const path of row.proof) t.ok(fs.existsSync(ROOT + path), `${path} exists`)
  }
})

test('every planned capability names the feature that will deliver it', (t) => {
  const rows = capabilities().filter((row) => row.status === 'planned')
  t.ok(rows.length > 0, 'the contract has planned capabilities')

  for (const row of rows) t.ok(/^\d{3}$/.test(row.delivered), `"${row.capability}" names a feature`)
})

test('a planned capability does not name a feature whose work is already done', (t) => {
  for (const row of capabilities().filter((row) => row.status === 'planned')) {
    const dir = fs.readdirSync(ROOT + 'specs').find((name) => name.startsWith(row.delivered + '-'))
    if (!dir) continue // not specified yet: a future feature

    const tasks = b4a.toString(fs.readFileSync(ROOT + 'specs/' + dir + '/tasks.md'))
    t.ok(/^- \[ \] T\d+/m.test(tasks), `"${row.capability}" is still planned, so feature ${row.delivered} must have work left`)
  }
})
