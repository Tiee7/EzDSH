import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packagePath = join(projectRoot, 'package.json')
const lockfilePath = join(projectRoot, 'package-lock.json')

const version = process.argv[2]?.trim()
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

if (version === undefined || version === '--help' || version === '-h') {
  console.log('Usage: npm run version:set -- <version>')
  console.log('Example: npm run version:set -- 0.8.1505')
  console.log('Accepts a three-part numeric version.')
  process.exit(version === undefined ? 1 : 0)
}

if (!versionPattern.test(version)) {
  console.error(`Invalid version: ${version}`)
  console.error('Use exactly three numeric parts, for example 0.8.1505.')
  process.exit(1)
}

const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
packageJson.version = version

const lockfile = JSON.parse(await readFile(lockfilePath, 'utf8'))
lockfile.version = version
lockfile.packages[''].version = version

await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
await writeFile(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`)

console.log(`Updated application version to ${version}`)
