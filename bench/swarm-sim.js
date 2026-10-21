/**
 * Which piece-selection strategies earn their place in a large swarm.
 *
 * Runs each strategy over several seeded swarms (a flash crowd of downloaders, a few seeders,
 * a bounded number of neighbours each, an uplink limit per peer) and prints one table of
 * medians across seeds. Same settings and seed, same table. See `docs/scaling.md` for how to
 * read it and what the model leaves out.
 *
 *   npm run bench:sim -- --peers 1000 --seeders 1 --seeds 3
 *   flags: --peers --seeders --neighbours --uplink --seederUplink --latency --groups
 *          --window --timeout --seed (first seed) --seeds (how many) --strategies a,b,c
 *          --uplinkMbps (what one tick is worth in seconds; reporting only, default 10)
 */

import fs from 'fs'
import os from 'os'
import { Worker, isMainThread, parentPort } from 'worker_threads'

import { simulate, DEFAULTS } from './sim/model.js'
import { STRATEGIES } from './sim/strategies.js'
import { DEFAULT_GROUP_LOG, groupLength } from '../lib/tree.js'

if (!isMainThread) {
  parentPort.on('message', (job) => {
    try {
      parentPort.postMessage({ job, result: simulate(job) })
    } catch (err) {
      parentPort.postMessage({ job, error: err.message })
    }
  })
} else {
  await main()
}

async function main () {
  const { settings, seeds, names, mbps } = parse(process.argv.slice(2))
  const started = Date.now()

  const jobs = []
  for (const strategy of names) for (let i = 0; i < seeds; i++) jobs.push({ ...settings, strategy, seed: settings.seed + i, id: jobs.length })

  const results = await runAll(jobs)
  const failed = results.find((r) => r.error)
  if (failed) {
    console.error(`${failed.job.strategy} (seed ${failed.job.seed}): ${failed.error}`)
    process.exit(1)
  }

  // A downloader uploads `uplink` groups per tick and that is `mbps`, which fixes the length of a
  // tick; receiving is unlimited, so the best a downloader can do is take `uplink` groups per tick.
  const group = groupLength(DEFAULT_GROUP_LOG)
  const tick = (group * 8 * settings.uplink) / (mbps * 1e6)
  const file = settings.groups * group
  const rate = (ticks) => (file / (ticks * tick) / 1e6).toFixed(2)

  console.log(machine())
  console.log(`file ${(file / 2 ** 20).toFixed(0)} MiB (${settings.groups} groups of ${group / 1024} KiB), ` +
    `${settings.peers} downloaders = ${(file * settings.peers / 2 ** 30).toFixed(1)} GiB moved by the swarm`)
  console.log(`uplink ${mbps} Mbit/s per downloader (${settings.uplink}/tick), so one tick = ${(tick * 1000).toFixed(1)} ms; ` +
    `${jobs.length} runs took ${((Date.now() - started) / 1000).toFixed(0)} s on ${Math.min(os.cpus().length, jobs.length)} workers`)
  console.log(JSON.stringify({ ...settings, seeds }))
  console.log()
  table(names.map((name) => {
    const runs = results.filter((r) => r.job.strategy === name).map((r) => r.result)
    const med = median(runs.map((r) => r.median))
    const last = median(runs.map((r) => r.last))
    return [
      name,
      med,
      spread(runs.map((r) => r.median)),
      last,
      spread(runs.map((r) => r.last)),
      (med * tick).toFixed(1) + ' s',
      rate(med),
      Math.round(100 * settings.groups / settings.uplink / med) + '%',
      (100 * median(runs.map((r) => r.repeatShare))).toFixed(1) + '%',
      median(runs.map((r) => r.wasted)),
      median(runs.map((r) => r.coverage3)).toFixed(2)
    ]
  }), ['strategy', 'median', 'range', 'last', 'range', 'median time', 'MB/s', 'of ideal', 'repeat', 'wasted', 'coverage3'])

  console.log('\nmedian, last: ticks until the median / last downloader holds everything (median across seeds); range: lowest to highest.')
  console.log('median time, MB/s: the median downloader\'s time and average download rate at the uplink above (an assumption, not a measurement).')
  console.log('of ideal: 100% would be receiving `uplink` groups every tick from the start.')
  console.log('repeat: share of seeder uploads of a group a seeder had already uploaded. wasted: duplicate arrivals and refusals.')
  console.log('coverage3: share of the file the seeders have uploaded at least once after three files\' worth of uploads.')
}

function parse (args) {
  const settings = { ...DEFAULTS }
  let seeds = 3
  let mbps = 10
  let names = Object.keys(STRATEGIES)

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '')
    const value = args[i + 1]
    if (key === 'strategies') names = value.split(',')
    else if (key in settings || key === 'seeds' || key === 'uplinkMbps') {
      const number = Number(value)
      if (!Number.isFinite(number) || number < 0) throw new Error(`${args[i]} needs a number, got ${value}`)
      if (key === 'seeds') seeds = number
      else if (key === 'uplinkMbps') mbps = number
      else settings[key] = number
    } else throw new Error('unknown flag ' + args[i])
  }

  for (const name of names) if (!STRATEGIES[name]) throw new Error('unknown strategy ' + name)
  delete settings.strategy
  return { settings, seeds, names, mbps }
}

/** What the numbers were produced on. Only the processor matters to the model; the rest is context. */
function machine () {
  const cpus = os.cpus()
  const disks = []

  try {
    for (const name of fs.readdirSync('/sys/block')) {
      if (/^(loop|ram|zram|dm-)/.test(name)) continue
      const rotational = fs.readFileSync(`/sys/block/${name}/queue/rotational`, 'utf8').trim() === '1'
      disks.push(`${name} ${rotational ? 'HDD' : 'SSD'}`)
    }
  } catch {} // not Linux: say nothing rather than guess

  return `${cpus[0].model.trim()}, ${cpus.length} threads; ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB RAM; ` +
    `${os.platform()} ${os.release()}; node ${process.version}` + (disks.length ? `; disks: ${disks.join(', ')}` : '')
}

/** One worker per core, each taking the next job when it finishes the last. */
function runAll (jobs) {
  return new Promise((resolve) => {
    const results = new Array(jobs.length)
    const workers = []
    let next = 0
    let done = 0

    const feed = (worker) => {
      if (next < jobs.length) worker.postMessage(jobs[next++])
    }

    for (let i = 0; i < Math.min(os.cpus().length, jobs.length); i++) {
      const worker = new Worker(new URL(import.meta.url))
      worker.on('error', (err) => {
        console.error('a worker failed: ' + err.message)
        process.exit(1)
      })
      worker.on('message', (message) => {
        results[message.job.id] = message
        if (++done === jobs.length) {
          for (const w of workers) w.terminate()
          resolve(results)
        } else feed(worker)
      })
      workers.push(worker)
      feed(worker)
    }
  })
}

function spread (values) {
  return `${Math.min(...values)}-${Math.max(...values)}`
}

function median (values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
}

function table (rows, header) {
  const all = [header, ...rows].map((row) => row.map(String))
  const widths = header.map((_, i) => Math.max(...all.map((row) => row[i].length)))
  const line = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ')

  console.log(line(all[0]))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const row of all.slice(1)) console.log(line(row))
}
