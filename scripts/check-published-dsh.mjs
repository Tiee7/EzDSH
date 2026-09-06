import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PUBLISHED_DSH_PACKAGE_VERSION } from './dsh-runtime-version.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const expectedVersion = manifest.dependencies?.['@deepseek-ai/dsh']
if (expectedVersion !== PUBLISHED_DSH_PACKAGE_VERSION) {
  throw new Error(
    `package.json dependency @deepseek-ai/dsh must use the available published fallback `
    + `@deepseek-ai/dsh@${PUBLISHED_DSH_PACKAGE_VERSION}; found ${String(expectedVersion)}`
  )
}

const lockfile = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf8'))
const lockRootVersion = lockfile.packages?.['']?.dependencies?.['@deepseek-ai/dsh']
if (lockRootVersion !== PUBLISHED_DSH_PACKAGE_VERSION) {
  throw new Error(
    `package-lock.json root dependency @deepseek-ai/dsh must use the available published fallback `
    + `@deepseek-ai/dsh@${PUBLISHED_DSH_PACKAGE_VERSION}; found ${String(lockRootVersion)}`
  )
}

const lockInstalledVersion = lockfile.packages?.['node_modules/@deepseek-ai/dsh']?.version
if (lockInstalledVersion !== PUBLISHED_DSH_PACKAGE_VERSION) {
  throw new Error(
    `package-lock.json installed @deepseek-ai/dsh must use the available published fallback `
    + `@deepseek-ai/dsh@${PUBLISHED_DSH_PACKAGE_VERSION}; found ${String(lockInstalledVersion)}`
  )
}

const packageRoot = join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh')
const packageManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
if (packageManifest.version !== PUBLISHED_DSH_PACKAGE_VERSION) {
  throw new Error(
    `installed @deepseek-ai/dsh must use the available published fallback `
    + `@deepseek-ai/dsh@${PUBLISHED_DSH_PACKAGE_VERSION}; found ${String(packageManifest.version)}`
  )
}

const runtimeEntry = join(packageRoot, 'lib', 'bin.js')
try {
  await readFile(runtimeEntry)
} catch {
  throw new Error(`Published @deepseek-ai/dsh is missing its runtime entry: ${runtimeEntry}`)
}

console.log(`Using published fallback @deepseek-ai/dsh@${PUBLISHED_DSH_PACKAGE_VERSION} at ${packageRoot}`)
