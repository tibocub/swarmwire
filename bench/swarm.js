/**
 * Protocol efficiency, measured on the deterministic harness.
 *
 * Not wall-clock speed — that is `bench/throughput.js`, where a real swarm and a real disk
 * get involved. What this measures is the part the scheduler controls: how many requests it
 * takes to move a file, how many of them are wasted, and how much of the traffic is proof
 * rather than content. Those numbers are reproducible, so a change that makes them worse is
 * visible immediately.
 *
 *   node bench/swarm.js
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import b4a from 'b4a'

import { Swarmwire, Download } from '../lib/swarmwire.js'
import { parseLink, discoveryTopic } from '../lib/address.js'
import { TestNetwork } from '../test/helpers/network.js'
import { attachSilent } from '../test/helpers/liar.js'

/** Short, so a dud peer costs a tenth of a second here rather than fifteen. */
const REQUEST_TIMEOUT = 100

const SCENARIOS = [
  { name: '1 seeder, 1 MiB', size: 1024 * 1024, seeders: 1 },
  { name: '1 seeder, 8 MiB', size: 8 * 1024 * 1024, seeders: 1 },
  { name: '2 seeders, 8 MiB', size: 8 * 1024 * 1024, seeders: 2 },
  { name: '4 seeders, 8 MiB', size: 8 * 1024 * 1024, seeders: 4 },
  { name: '4 seeders, 8 MiB, one silent', size: 8 * 1024 * 1024, seeders: 4, silent: 1 }
]

const counters = { proofBytes: 0, dataBytes: 0, requests: 0, rejects: 0 }

instrument()

const rows = []
for (const scenario of SCENARIOS) {
  rows.push(await run(scenario))
}

report(rows)
await windowSweep()

/**
 * How deep the request queue needs to be.
 *
 * Neither loopback nor an infinitely fast harness can answer this: when a round trip is free,
 * or when the wire carries everything at once, one outstanding request performs as well as a
 * hundred. So the link here is given both a delay and a byte rate, and the measure is logical
 * time rather than rounds. A window below the bandwidth-delay product leaves the wire idle
 * while it waits; above it, nothing improves.
 *
 * At 16 KiB groups, latency L and rate B bytes/tick, keeping the wire busy needs roughly
 * (2L * B) / 16384 requests outstanding — the table should bend at about that point.
 */
async function windowSweep () {
  const size = 4 * 1024 * 1024
  const cases = [
    { latency: 20, bandwidth: 8192, label: 'near and slow' },
    { latency: 200, bandwidth: 8192, label: 'far and slow' },
    { latency: 200, bandwidth: 65536, label: 'far and fast' }
  ]

  for (const { latency, bandwidth, label } of cases) {
    const ideal = Math.ceil((2 * latency * bandwidth) / (16 * 1024))

    console.log(`${label}: ${latency} ticks of latency, ${bandwidth} bytes/tick, ${size / 1024 / 1024} MiB`)
    console.log(`(bandwidth-delay product is about ${ideal} groups in flight)`)
    console.log()
    console.log('window   ticks      vs best')
    console.log('------   --------   -------')

    const results = []

    for (const window of [1, 4, 16, 64, 256]) {
      results.push({
        label: String(window),
        ticks: await measure({ size, latency, bandwidth, window, adaptive: false })
      })
    }

    // The real one: starts small and grows while the window, rather than the link, is what
    // it is waiting on.
    results.push({
      label: 'adaptive',
      ticks: await measure({ size, latency, bandwidth, window: 32, adaptive: true })
    })

    const best = Math.min(...results.map((r) => r.ticks))

    for (const { label, ticks } of results) {
      const ratio = (ticks / best).toFixed(2) + 'x'
      console.log(label.padEnd(9) + String(ticks).padEnd(11) + ratio)
    }

    console.log()
  }
}

async function measure ({ size, latency, bandwidth, window, adaptive = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmwire-bench-'))
  const file = path.join(dir, 'content')
  fs.writeFileSync(file, sample(size))

  const net = new TestNetwork()
  const seeder = new Swarmwire({ swarm: net.peer('seeder'), window })
  const leecher = new Swarmwire({ swarm: net.peer('leecher'), window })

  net.link('seeder', 'leecher').setLatency(latency).setBandwidth(bandwidth)

  const { link } = await seeder.serve(file)
  const download = leecher.download(link, path.join(dir, 'copy'))

  // Pinning the window is only for the comparison: it is what the code did before.
  if (!adaptive) {
    download._widen = () => {}
    download._narrow = () => {}
  }

  let rounds = 0
  while (!download.complete && rounds < 200000) {
    await net.settle()
    rounds++
  }
  await download

  const ticks = net.time

  await leecher.destroy()
  await seeder.destroy()
  fs.rmSync(dir, { recursive: true, force: true })

  return ticks
}

async function run ({ name, size, seeders, silent = 0 }) {
  reset()

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmwire-bench-'))
  const file = path.join(dir, 'content')
  fs.writeFileSync(file, sample(size))

  const net = new TestNetwork()
  const nodes = []

  for (let i = 0; i < seeders; i++) {
    nodes.push(new Swarmwire({ swarm: net.peer('seeder' + i), requestTimeout: REQUEST_TIMEOUT }))
  }

  let link = null
  for (const node of nodes) {
    const served = await node.serve(file)
    link = served.link
  }

  // Peers that claim the content and never answer: the cost of a dud peer, in requests.
  const { root, secret } = parseLink(link)
  for (let i = 0; i < silent; i++) {
    attachSilent(net.peer('silent' + i).join(discoveryTopic(root, secret)), { size })
  }

  const leecher = new Swarmwire({ swarm: net.peer('leecher'), requestTimeout: REQUEST_TIMEOUT })
  const download = leecher.download(link, path.join(dir, 'copy'))

  const started = Date.now()
  let rounds = 0

  while (!download.complete && rounds < 100000) {
    await net.settle()
    rounds++
  }
  await download

  const elapsed = Date.now() - started
  const groups = download.total

  for (const node of nodes) await node.destroy()
  await leecher.destroy()
  fs.rmSync(dir, { recursive: true, force: true })

  return {
    name,
    groups,
    rounds,
    requests: counters.requests,
    wasted: counters.requests - groups,
    rejects: counters.rejects,
    overhead: counters.proofBytes / counters.dataBytes,
    ms: elapsed
  }
}

function report (rows) {
  const columns = [
    ['scenario', (r) => r.name, 30],
    ['groups', (r) => String(r.groups), 7],
    ['requests', (r) => String(r.requests), 9],
    ['wasted', (r) => String(r.wasted), 7],
    ['proof overhead', (r) => (r.overhead * 100).toFixed(2) + '%', 15],
    ['ms', (r) => String(r.ms), 6]
  ]

  console.log()
  console.log(columns.map(([title, , width]) => title.padEnd(width)).join(''))
  console.log(columns.map(([, , width]) => '-'.repeat(width - 1).padEnd(width)).join(''))

  for (const row of rows) {
    console.log(columns.map(([, value, width]) => value(row).padEnd(width)).join(''))
  }

  console.log()
  console.log('wasted = requests beyond one per group: refusals, timeouts and duplicates.')
  console.log('proof overhead = proof bytes as a fraction of content bytes received.')
  console.log('ms is harness wall-clock and varies run to run; the request counts do not.')
  console.log()
}

/** Count what crosses the wire, without the library knowing it is being measured. */
function instrument () {
  const onData = Download.prototype._onData
  Download.prototype._onData = function (peer, message) {
    counters.dataBytes += message.data.length
    counters.proofBytes += message.proof.length * 32
    return onData.call(this, peer, message)
  }

  const claim = Download.prototype._claim
  Download.prototype._claim = function (peer, index) {
    counters.requests++
    return claim.call(this, peer, index)
  }

  const onReject = Download.prototype._onReject
  Download.prototype._onReject = function (peer, message) {
    counters.rejects++
    return onReject.call(this, peer, message)
  }
}

function reset () {
  counters.proofBytes = 0
  counters.dataBytes = 0
  counters.requests = 0
  counters.rejects = 0
}

function sample (size) {
  const buffer = b4a.alloc(size)
  for (let i = 0; i < size; i++) buffer[i] = (i * 7 + (i >> 11)) & 0xff
  return buffer
}
