/**
 * Fail if the published package would hold anything but the library.
 *
 * Node-only dev tooling: it is not part of the package and does not need to run on Bare.
 */

import { execSync } from 'child_process'

const ALLOWED = [/^index\.js$/, /^lib\//, /^docs\/(format|contract)\.md$/, /^package\.json$/, /^README\.md$/, /^LICENSE$/]

const [{ files }] = JSON.parse(execSync('npm pack --dry-run --json', { stdio: ['ignore', 'pipe', 'ignore'] }))
const paths = files.map((file) => file.path)

const stray = paths.filter((path) => !ALLOWED.some((pattern) => pattern.test(path)))

if (!paths.includes('LICENSE')) stray.push('(LICENSE is missing)')

if (stray.length) {
  console.error(`${stray.length} unexpected in the package:\n  ${stray.join('\n  ')}`)
  process.exit(1)
}

console.log(`ok: ${paths.length} files`)
