// The published .d.ts (npm run types) work in a strict TypeScript project that installed no @types of its
// own ("types": []), reached through package exports as a user would: no error on right use, an error on a
// typo (so the types really load, not any).

import test from 'brittle'

if (typeof Bare !== 'undefined') {
  test('types consumer: skipped on Bare (a Node script)', (t) => t.pass('skipped on Bare'))
} else {
  const fs = await import('fs')
  const os = await import('os')
  const path = await import('path')
  const { spawnSync } = await import('child_process')
  const { fileURLToPath } = await import('url')

  const root = fileURLToPath(new URL('../../', import.meta.url))
  const tsc = root + 'node_modules/typescript/bin/tsc'

  const GOOD = `import { Swarmwire, parseLink, formatLink, type FileEntry, type PeerIdentity, type Swarm } from 'swarmwire-lib'

export async function main (swarm: Swarm): Promise<void> {
  const node = new Swarmwire({ swarm, resolve: (root: string, peer: PeerIdentity) => (peer.id === root ? null : 'file.bin') })
  node.on('peer-connected', ({ id }) => { const s: string = id; void s })

  const { link } = await node.serve('file.bin')
  const download = node.download(link, 'copy.bin')
  download.on('progress', ({ have, total }) => { const n: number = have + total; void n })
  await download

  const list = await node.readList(parseLink(link))
  const files: FileEntry[] = list ? list.files : []
  void files
  void formatLink({ root: parseLink(link).root, size: 1 })
  await node.destroy()
}

export const fake: Swarm = { join: () => undefined, on: () => {} }
`
  const BAD = `import { Swarmwire, type Swarm } from 'swarmwire-lib'

export function typo (swarm: Swarm): void {
  const node = new Swarmwire({ swarm })
  node.notAThing()
}
`

  function node (args, cwd = root) {
    return spawnSync(process.execPath, args, { cwd, encoding: 'utf8' })
  }

  test('types consumer: no @types installed, strict, node16; right use passes, a typo fails', { timeout: 300000 }, async (t) => {
    const build = node([tsc, '-p', 'jsconfig.json', '--noEmit', 'false', '--declaration', '--emitDeclarationOnly', '--outDir', 'dist/types'])
    t.is(build.status, 0, 'npm run types: tsc ' + build.stdout.slice(0, 2000))
    const copy = node([root + 'scripts/types.js'])
    t.is(copy.status, 0, 'npm run types: scripts/types.js ' + copy.stderr)

    const dir = fs.mkdtempSync(path.join(process.env.HG_TEST_TMP || os.tmpdir(), 'sw-types-'))
    const link = path.join(dir, 'node_modules', 'swarmwire-lib')
    fs.mkdirSync(path.dirname(link))
    fs.symlinkSync(root, link, 'junction')
    t.teardown(() => {
      // Only the link itself goes (rmdir on a junction leaves its target alone); the folder only once it's gone.
      try { process.platform === 'win32' ? fs.rmdirSync(link) : fs.unlinkSync(link) } catch {}
      if (!fs.existsSync(link)) fs.rmSync(dir, { recursive: true, force: true })
    })

    fs.writeFileSync(path.join(dir, 'good.mts'), GOOD)
    fs.writeFileSync(path.join(dir, 'bad.mts'), BAD)
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, module: 'node16', moduleResolution: 'node16', target: 'ES2022', types: [], noEmit: true },
      files: ['good.mts', 'bad.mts']
    }))

    const res = node([tsc, '-p', path.join(dir, 'tsconfig.json')], dir)
    const errors = res.stdout.split('\n').filter((line) => line.includes('error TS'))
    const elsewhere = errors.filter((line) => !line.startsWith('bad.mts'))
    t.alike(elsewhere, [], 'no error in good.mts or in the published types')
    t.ok(errors.some((line) => line.startsWith('bad.mts') && line.includes('notAThing')), 'node.notAThing is an error: ' + errors.join('\n'))
  })
}
