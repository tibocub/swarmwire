// File transfers over a real Hyperswarm on a local DHT (hyperdht/testnet.js), each download
// from its link alone (finding the seeders included), as an app does it:
//   wire.one-to-one   one seeder, one fresh leecher, a file of `size` MiB (MiB/s)
//   wire.hash         serving that file: hashing it where it lies (MiB/s)
//   wire.small-files  a folder of `size` files of 2-6 KB, downloaded as one collection (ms)
//   wire.seeders      `size` seeders holding one 8 MiB file, one leecher (MiB/s); each seeder in
//                     its own process (perf/scenarios/_seeder.mjs), as on its own machine

import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import { fileURLToPath } from 'url'

import { context, record, now, child, sizes } from '../harness.mjs'
import { Swarmwire } from '../../lib/swarmwire.js'
import { clearHashCache } from '../../lib/source.js'
import { tmpdir, writeSample } from '../../test/helpers/tmp.js'

const MiB = 1024 * 1024
const SEEDER = path.join(path.dirname(fileURLToPath(import.meta.url)), '_seeder.mjs')

function node (t, testnet) {
  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const wire = new Swarmwire({ swarm })
  t.teardown(async () => { await wire.destroy(); await swarm.destroy() })
  return wire
}

// A fresh leecher downloading `link`; its own context, closed after.
async function fetchOnce (testnet, link, out, collection = false) {
  const t = context()
  try {
    const leecher = node(t, testnet)
    const start = now()
    if (collection) await leecher.downloadCollection(link, out)
    else await leecher.download(link, out)
    return now() - start
  } finally {
    await t.close()
    fs.rmSync(out, { recursive: true, force: true })
  }
}

const t = context()
try {
  const testnet = await createTestnet(3, t.teardown)
  const dir = tmpdir(t)

  for (const mib of sizes([4, 32])) {
    const ts = context()
    try {
      const file = writeSample(dir, `file-${mib}`, mib * MiB)
      const seeder = node(ts, testnet)
      const hashes = []
      let link = null
      for (let r = 0; r < 3; r++) {
        clearHashCache() // or the second serve would be a cache hit
        const start = now()
        const served = await seeder.serve(file)
        hashes.push(mib / ((now() - start) / 1000))
        link = served.link
        if (r < 2) await seeder.unserve(served.root)
      }
      record('wire.hash', mib, 'MiB/s', hashes, { better: 'higher' })
      const rates = []
      for (let r = 0; r < 3; r++) rates.push(mib / ((await fetchOnce(testnet, link, path.join(dir, 'copy'))) / 1000))
      record('wire.one-to-one', mib, 'MiB/s', rates, { better: 'higher' })
    } finally {
      await ts.close()
    }
  }

  for (const n of sizes([30, 200])) {
    const ts = context()
    try {
      const folder = path.join(dir, `folder-${n}`)
      fs.mkdirSync(folder, { recursive: true })
      for (let i = 0; i < n; i++) {
        // each file its own bytes (the same bytes would be one file to fetch)
        fs.writeFileSync(path.join(folder, `f${i}.txt`), b4a.concat([b4a.from(`file ${i}\n`), b4a.alloc(2048 + (i * 97) % 4096, i % 251)]))
      }
      const seeder = node(ts, testnet)
      const { link } = await seeder.serveCollection(folder)
      const times = []
      for (let r = 0; r < 3; r++) times.push(await fetchOnce(testnet, link, path.join(dir, 'copy-folder'), true))
      record('wire.small-files', n, 'ms', times)
    } finally {
      await ts.close()
    }
  }

  const file = writeSample(dir, 'shared', 8 * MiB)
  for (const n of sizes([1, 2, 4])) {
    const ts = context()
    try {
      const seeders = []
      for (let i = 0; i < n; i++) seeders.push(child(ts, SEEDER, [JSON.stringify(testnet.bootstrap), file], path.join(dir, `seeder-${n}-${i}`)))
      let link = null
      for (const s of seeders) link = await s.line('link ')
      const rates = []
      for (let r = 0; r < 5; r++) rates.push(8 / ((await fetchOnce(testnet, link, path.join(dir, 'copy'))) / 1000))
      record('wire.seeders', n, 'MiB/s', rates, { better: 'higher' })
    } finally {
      await ts.close()
    }
  }
} finally {
  await t.close()
}
