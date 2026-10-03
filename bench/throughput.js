/**
 * Wall-clock throughput over a real Hyperswarm, on a private local DHT.
 *
 * Loopback, so this measures the library rather than a network: hashing, proving, verifying
 * and writing. A slow result here is our fault, not the internet's.
 *
 *   node bench/throughput.js [megabytes]
 */

import Hyperswarm from 'hyperswarm'
import createTestnet from '@hyperswarm/testnet'
import fs from 'fs'
import os from 'os'
import path from 'path'
import b4a from 'b4a'

import { Swarmwire } from '../lib/swarmwire.js'
import { clearHashCache } from '../lib/source.js'

const megabytes = Number(process.argv[2] ?? 32)
const size = megabytes * 1024 * 1024

/** Requests in flight per peer: the knob this benchmark exists to settle. */
const WINDOWS = process.argv[3] ? [Number(process.argv[3])] : [4, 8, 16, 32, 64, 128]

const testnet = await createTestnet(3)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmwire-bench-'))
const file = path.join(dir, 'content')

process.stdout.write(`preparing ${megabytes} MiB... `)
fs.writeFileSync(file, sample(size))
console.log('done')

console.log()
console.log('window   transfer        hashing')
console.log('------   -------------   -------------')

for (const window of WINDOWS) {
  const seeder = node(window)
  const leecher = node(window)

  clearHashCache() // or every run after the first would measure a cache hit
  const hashStarted = Date.now()
  const { link } = await seeder.node.serve(file)
  const hashMs = Date.now() - hashStarted

  const out = path.join(dir, `copy-${window}`)
  const started = Date.now()
  const download = leecher.node.download(link, out)
  await download
  const elapsed = Date.now() - started

  const note = download.rejected || download.timedOut
    ? `  (${download.rejected} refused, ${download.timedOut} timed out)`
    : ''

  console.log(
    String(window).padEnd(9) +
    `${rate(size, elapsed)}`.padEnd(16) +
    `${rate(size, hashMs)}`.padEnd(14) +
    note
  )

  await leecher.node.destroy()
  await seeder.node.destroy()
  await leecher.swarm.destroy()
  await seeder.swarm.destroy()
  fs.rmSync(out, { force: true })
}

console.log()
console.log('Loopback, one seeder: this measures hashing, proving, verifying and writing.')
console.log('There is no latency here, so the window size cannot help; see bench/swarm.js.')
console.log()

await testnet.destroy()
fs.rmSync(dir, { recursive: true, force: true })

function node (window) {
  const swarm = new Hyperswarm({
    dht: testnet.createNode({ ephemeral: false, firewalled: false })
  })

  return { swarm, node: new Swarmwire({ swarm, window }) }
}

function rate (bytes, ms) {
  return (bytes / 1024 / 1024 / (ms / 1000)).toFixed(1) + ' MiB/s'
}

function sample (bytes) {
  const buffer = b4a.alloc(bytes)
  for (let i = 0; i < bytes; i++) buffer[i] = (i * 7 + (i >> 11)) & 0xff
  return buffer
}
