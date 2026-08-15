import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const runtimePackage = 'node-bin-darwin-arm64'
const expectedVersion = manifest.devDependencies?.[runtimePackage]
if (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
  throw new Error(`devDependencies.${runtimePackage} must be pinned to an exact version`)
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`The current release target requires darwin-arm64, found ${process.platform}-${process.arch}`)
}

const executableName = 'node'
const packageRoot = join(projectRoot, 'node_modules', runtimePackage)
const source = join(packageRoot, 'bin', executableName)
const destinationRoot = join(projectRoot, 'out', 'node-runtime')
const destination = join(destinationRoot, 'bin', basename(source))
const actualVersion = execFileSync(source, ['--version'], { encoding: 'utf8' }).trim()

if (actualVersion !== `v${expectedVersion}`) {
  throw new Error(`Expected bundled Node v${expectedVersion}, found ${actualVersion}`)
}

await rm(destinationRoot, { recursive: true, force: true })
await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)
await chmod(destination, 0o755)
await copyFile(join(packageRoot, 'LICENSE'), join(destinationRoot, 'LICENSE'))

console.log(`Staged Node Runtime ${actualVersion} at ${destination}`)
