import { execFileSync, spawnSync } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertPinnedDshSourceCheckout } from './dsh-runtime-version.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const sourceRoot = resolve(projectRoot, 'vendor', 'deepseek-harness')
const pnpmEntry = resolve(projectRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
assertPinnedDshSourceCheckout(sourceRoot)
const result = spawnSync(process.execPath, [
  pnpmEntry,
  '--dir',
  sourceRoot,
  'install',
  '--frozen-lockfile',
  '--ignore-scripts',
  '--prod=false',
], {
  cwd: projectRoot,
  env: { ...process.env, CI: 'true' },
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) {
  process.exitCode = result.status ?? 1
  throw new Error(`DSH source dependency install failed with exit code ${String(result.status ?? 1)}`)
}

// The source install intentionally ignores lifecycle scripts so upstream
// repository hooks cannot mutate the host Git worktree. Older DSH releases
// required fs-ext here; newer releases use node-addon-system instead.
const sourcePnpmDirectory = join(sourceRoot, 'node_modules', '.pnpm')
const fsExtEntry = (await readdir(sourcePnpmDirectory, { withFileTypes: true }))
  .find((entry) => entry.isDirectory() && entry.name.startsWith('fs-ext@'))
if (fsExtEntry !== undefined) {
  const fsExtRoot = join(sourcePnpmDirectory, fsExtEntry.name, 'node_modules', 'fs-ext')
  const nodeGypEntry = join(projectRoot, 'node_modules', 'pnpm', 'dist', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
  await access(join(fsExtRoot, 'binding.gyp'))
  await access(nodeGypEntry)
  execFileSync(process.execPath, [nodeGypEntry, 'configure', 'build'], {
    cwd: fsExtRoot,
    env: { ...process.env, CI: 'true' },
    stdio: 'inherit'
  })
} else {
  console.log('DSH source workspace uses node-addon-system; skipping legacy fs-ext build')
}

const subprocessRoot = join(sourceRoot, 'packages', 'subprocess', 'subprocess-local')
execFileSync(process.execPath, ['scripts/ensure-spawn-helper.mjs'], {
  cwd: subprocessRoot,
  env: { ...process.env, CI: 'true' },
  stdio: 'inherit'
})
