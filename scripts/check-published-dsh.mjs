import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const expectedVersion = manifest.dependencies?.['@deepseek-ai/dsh']
if (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion)) {
  throw new Error('package.json must pin @deepseek-ai/dsh to an exact published version')
}

const packageRoot = join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh')
const packageManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
if (packageManifest.version !== expectedVersion) {
  throw new Error(`Expected @deepseek-ai/dsh ${expectedVersion}, found ${String(packageManifest.version)}`)
}

const runtimeEntry = join(packageRoot, 'lib', 'bin.js')
try {
  await readFile(runtimeEntry)
} catch {
  throw new Error(`Published @deepseek-ai/dsh is missing its runtime entry: ${runtimeEntry}`)
}

console.log(`Using published @deepseek-ai/dsh@${expectedVersion} at ${packageRoot}`)
