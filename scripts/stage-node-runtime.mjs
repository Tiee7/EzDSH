import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const target = `${process.platform}-${process.arch}`
const runtimePackageByTarget = {
  'darwin-arm64': 'node-bin-darwin-arm64',
  'win32-x64': 'node-win-x64'
}
const runtimePackage = runtimePackageByTarget[target]
if (runtimePackage === undefined) {
  throw new Error(`The current release target is unsupported: ${target}`)
}
const expectedVersion = manifest.devDependencies?.[runtimePackage]
  ?? manifest.optionalDependencies?.[runtimePackage]
if (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
  throw new Error(`${runtimePackage} must be pinned to an exact version in devDependencies or optionalDependencies`)
}

const packageRoot = join(projectRoot, 'node_modules', runtimePackage)
const executableName = process.platform === 'win32' ? 'node.exe' : 'node'
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
if (process.platform !== 'win32') await chmod(destination, 0o755)
try {
  await copyFile(join(packageRoot, 'LICENSE'), join(destinationRoot, 'LICENSE'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

console.log(`Staged Node Runtime ${actualVersion} for ${target} at ${destination}`)
