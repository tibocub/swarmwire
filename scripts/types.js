/**
 * After tsc wrote the declarations (npm run types): ships what tsc doesn't copy. protomux ships no
 * types, so its hand-written ones (types/) go along, referenced from the entry point, and so do
 * Node's (@types/node, a dependency): Swarmwire and Download are EventEmitters.
 */

import fs from 'fs'
import { fileURLToPath } from 'url'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = root + 'dist/types/'
const VENDOR = ['protomux']

fs.mkdirSync(out + 'vendor', { recursive: true })
for (const name of VENDOR) fs.copyFileSync(root + 'types/' + name + '.d.cts', out + 'vendor/' + name + '.d.cts')

const entry = out + 'index.d.ts'
const refs = '/// <reference types="node" />\n' + VENDOR.map((name) => `/// <reference path="./vendor/${name}.d.cts" />\n`).join('')
fs.writeFileSync(entry, refs + fs.readFileSync(entry, 'utf8'))
