// One seeder in its own process, for transfer.mjs (another machine, in effect: in one process
// every peer shares one thread).
//   <runtime> _seeder.mjs <control dir> <bootstrap json> <file>
// Serves the file, prints 'link <link>', closes on 'stop'.

import process from 'process'
import Hyperswarm from 'hyperswarm'
import { signalled } from '../harness.mjs'
import { Swarmwire } from '../../lib/swarmwire.js'

const [dir, bootstrapJson, file] = process.argv.slice(2)
const swarm = new Hyperswarm({ bootstrap: JSON.parse(bootstrapJson) })
const wire = new Swarmwire({ swarm })
const { link } = await wire.serve(file)
console.log('link ' + link)
await signalled(dir, 'stop')
await wire.destroy()
await swarm.destroy()
