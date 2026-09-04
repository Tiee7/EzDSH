import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertPinnedDshRuntimeVersion, PINNED_DSH_RUNTIME_VERSION } from './dsh-runtime-version.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const expectedVersion = manifest.dependencies?.['@deepseek-ai/dsh']
assertPinnedDshRuntimeVersion('package.json dependency @deepseek-ai/dsh', expectedVersion)

const lockfile = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf8'))
const lockRootVersion = lockfile.packages?.['']?.dependencies?.['@deepseek-ai/dsh']
assertPinnedDshRuntimeVersion('package-lock.json root dependency @deepseek-ai/dsh', lockRootVersion)

const lockInstalledVersion = lockfile.packages?.['node_modules/@deepseek-ai/dsh']?.version
assertPinnedDshRuntimeVersion('package-lock.json installed @deepseek-ai/dsh', lockInstalledVersion)

const packageRoot = join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh')
const packageManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
assertPinnedDshRuntimeVersion('installed @deepseek-ai/dsh', packageManifest.version)

const runtimeEntry = join(packageRoot, 'lib', 'bin.js')
try {
  await readFile(runtimeEntry)
} catch {
  throw new Error(`Published @deepseek-ai/dsh is missing its runtime entry: ${runtimeEntry}`)
}

console.log(`Using published @deepseek-ai/dsh@${PINNED_DSH_RUNTIME_VERSION} at ${packageRoot}`)
