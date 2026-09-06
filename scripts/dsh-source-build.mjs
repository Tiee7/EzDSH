import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { assertPinnedDshSourceCheckout } from './dsh-runtime-version.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const sourceRoot = resolve(projectRoot, 'vendor', 'deepseek-harness')
const pnpmEntry = resolve(projectRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
assertPinnedDshSourceCheckout(sourceRoot)
const result = spawnSync(process.execPath, [
  pnpmEntry,
  '--dir',
  sourceRoot,
  'run',
  'build',
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CI: 'true',
    npm_config_ignore_scripts: 'true',
  },
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) {
  process.exitCode = result.status ?? 1
  throw new Error(`DSH source build failed with exit code ${String(result.status ?? 1)}`)
}
