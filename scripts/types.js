/**
 * After tsc wrote the declarations (npm run types): ships what tsc doesn't copy. protomux ships no
 * types, so its hand-written ones (types/) go along as a module of ours, not a global
 * `declare module 'protomux'` (hypergraph types protomux too; two such declarations clash in a user's
 * build), and imports of 'protomux' are pointed at our copy. Node's types (@types/node, a dependency)
 * are referenced from the entry point: Swarmwire and Download are EventEmitters.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = root + 'dist/types/'
const PRIVATE = ['protomux']

fs.mkdirSync(out + 'vendor', { recursive: true })
for (const name of PRIVATE) fs.copyFileSync(root + 'types/' + name + '.d.cts', out + 'vendor/' + name + '.d.cts')

for (const file of fs.readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((f) => /\.d\.c?ts$/.test(f)).map((f) => path.join(out, f))) {
  const text = fs.readFileSync(file, 'utf8')
  const fixed = text.replace(/(import\(|from )(["'])([^"']+)\2/g, (all, head, q, spec) => {
    if (!PRIVATE.includes(spec)) return all
    const rel = path.relative(path.dirname(file), path.join(out, 'vendor', spec + '.cjs')).split(path.sep).join('/')
    return head + q + (rel.startsWith('.') ? rel : './' + rel) + q
  })
  if (fixed !== text) fs.writeFileSync(file, fixed)
}

const entry = out + 'index.d.ts'
fs.writeFileSync(entry, '/// <reference types="node" />\n' + fs.readFileSync(entry, 'utf8'))
