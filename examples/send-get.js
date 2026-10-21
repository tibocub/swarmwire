/**
 * Send a file to someone, or get one.
 *
 *   node examples/send-get.js send ./holidays.mp4
 *   node examples/send-get.js get 'swarmwire://…' ./holidays.mp4
 *
 * `--bootstrap host:port` points both sides at a private DHT; leave it out for the real one.
 */

import process from 'process'
import Hyperswarm from 'hyperswarm'
import DHT from 'hyperdht'

import { Swarmwire } from '../index.js'

const args = process.argv.slice(2)
const flag = args.indexOf('--bootstrap')
const bootstrap = flag === -1 ? null : args.splice(flag, 2)[1]
const [mode, target, out] = args

const swarm = bootstrap ? privateSwarm(bootstrap) : new Hyperswarm()
const node = new Swarmwire({ swarm })

if (mode === 'send') {
  const { link } = await node.serve(target)
  console.log(link) // hand this to the other side; keep running while they fetch
  await new Promise((resolve) => process.once('SIGINT', resolve))
} else if (mode === 'get') {
  await node.download(target, out)
  console.log(out)
} else {
  console.log('usage: send <file> | get <link> <out>   [--bootstrap host:port]')
  process.exitCode = 1
}

await node.destroy()
await swarm.destroy()

// A loopback DHT only works if the node binds there and is not firewalled.
function privateSwarm (address) {
  const [host, port] = address.split(':')
  const dht = new DHT({ bootstrap: [{ host, port: Number(port) }], ephemeral: false, firewalled: false, host: '127.0.0.1' })
  return new Hyperswarm({ dht })
}
