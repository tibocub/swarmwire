/**
 * The README example, run the way a reader runs it: two processes, a link between them.
 *
 * Same private-DHT arrangement as the CLI test, so it needs no internet.
 */

import test from 'brittle'
import createTestnet from '@hyperswarm/testnet'
import { spawn } from 'child_process'
import path from 'path'
import process from 'process'
import { fileURLToPath } from 'url'

import { tmpdir, writeSample, read } from '../helpers/tmp.js'

const EXAMPLE = fileURLToPath(new URL('../../examples/send-get.js', import.meta.url))

test('the example sends a file and gets it back byte for byte', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const bootstrap = `${testnet.bootstrap[0].host}:${testnet.bootstrap[0].port}`

  const dir = tmpdir(t)
  const file = writeSample(dir, 'example.bin', 150000)
  const out = path.join(dir, 'copy.bin')

  const sender = run(t, ['send', file, '--bootstrap', bootstrap])
  const link = (await sender.firstLine()).trim()
  t.ok(link.startsWith('swarmwire://'), 'the sender printed a link')

  const receiver = run(t, ['get', link, out, '--bootstrap', bootstrap])

  t.is(await receiver.exit(), 0, 'the receiver finished cleanly')
  t.alike(read(out), read(file), 'the file arrived intact')
})

function run (t, args) {
  // process.execPath is whichever runtime runs the tests, so Node and Bare both get covered.
  const child = spawn(process.execPath, [EXAMPLE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })

  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.resume()

  t.teardown(() => child.kill('SIGKILL'), { order: 50 })

  return {
    async firstLine () {
      while (!stdout.includes('\n')) {
        if (child.exitCode !== null) throw new Error('process exited before printing anything')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return stdout.slice(0, stdout.indexOf('\n'))
    },

    exit () {
      return new Promise((resolve) => child.once('exit', resolve))
    }
  }
}
