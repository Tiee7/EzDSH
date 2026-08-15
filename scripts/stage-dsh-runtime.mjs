import { access, cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { c as createArchive } from 'tar'
import { pruneRuntimeFiles } from './prune-runtime-files.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const runtimeSource = join(projectRoot, 'vendor', 'deepseek-harness')
const destination = join(projectRoot, 'out', 'dsh-runtime')

await rm(destination, { recursive: true, force: true })
await mkdir(dirname(destination), { recursive: true })

execFileSync(process.execPath, [
  join(projectRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  '--dir', runtimeSource,
  'deploy',
  '--legacy',
  '--ignore-scripts',
  '--filter', '@deepseek-ai/dsh',
  '--prod',
  destination
], {
  cwd: projectRoot,
  env: { ...process.env, CI: 'true' },
  stdio: 'inherit'
})
await cp(join(runtimeSource, 'LICENSE'), join(destination, 'DEEPSEEK-HARNESS-LICENSE'))

// `apps/web/dist` is a generated workspace artifact and therefore is not part
// of the source checkout copied by deploy. The web bundle is required by the
// Web profile, so publish it into the deployed package's real directory.
const deployedWebLinks = [
  join(destination, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'dsh-web-frontend'),
  join(destination, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
]
let deployedWebRoot
for (const deployedWebLink of deployedWebLinks) {
  try {
    deployedWebRoot = await realpath(deployedWebLink)
    break
  } catch {
    // Try the other pnpm layout.
  }
}
if (deployedWebRoot === undefined) {
  throw new Error('Unable to locate the staged DSH web frontend package')
}

// Some Runtime packages declare workspace plugins as peer dependencies. A
// production deploy intentionally omits those peers, even though the web
// profile loads them at startup. Build a small peer closure from the deployed
// manifests and publish missing workspace peers into the staged package.
async function indexWorkspacePackages(directory, packages = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const current = join(directory, entry.name)
    if (entry.isDirectory()) {
      await indexWorkspacePackages(current, packages)
      continue
    }
    if (!entry.isFile() || entry.name !== 'package.json') continue
    try {
      const manifest = JSON.parse(await readFile(current, 'utf8'))
      if (typeof manifest.name === 'string') packages.set(manifest.name, dirname(current))
    } catch {
      // Ignore non-package JSON files.
    }
  }
  return packages
}

async function indexStagedPackages(directory, packages = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const current = join(directory, entry.name)
    if (entry.isDirectory()) {
      await indexStagedPackages(current, packages)
      continue
    }
    if (!entry.isFile() || entry.name !== 'package.json') continue
    try {
      const manifest = JSON.parse(await readFile(current, 'utf8'))
      if (typeof manifest.name === 'string' && !packages.has(manifest.name)) {
        packages.set(manifest.name, dirname(current))
      }
    } catch {
      // Ignore non-package JSON files.
    }
  }
  return packages
}

const workspacePackages = await indexWorkspacePackages(runtimeSource)
const stagedPackages = await indexStagedPackages(join(destination, 'node_modules', '.pnpm'))
const rootNodeModules = join(destination, 'node_modules')
const peerQueue = [...stagedPackages.values()]
const visitedPeerManifests = new Set()
const requiredPeers = new Set()
while (peerQueue.length > 0) {
  const packageRoot = peerQueue.pop()
  if (packageRoot === undefined || visitedPeerManifests.has(packageRoot)) continue
  visitedPeerManifests.add(packageRoot)
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    for (const peerName of Object.keys(manifest.peerDependencies ?? {})) {
      if (requiredPeers.has(peerName)) continue
      requiredPeers.add(peerName)
      const workspaceRoot = workspacePackages.get(peerName)
      const stagedRoot = stagedPackages.get(peerName)
      if (workspaceRoot !== undefined) peerQueue.push(workspaceRoot)
      else if (stagedRoot !== undefined) peerQueue.push(stagedRoot)
    }
  } catch {
    // Ignore incomplete package metadata.
  }
}

let peerPackageCount = 0
for (const peerName of requiredPeers) {
  const target = join(rootNodeModules, ...peerName.split('/'))
  try {
    await access(join(target, 'package.json'))
    continue
  } catch {
    // The peer is absent from the deployment root.
  }
  const source = workspacePackages.get(peerName) ?? stagedPackages.get(peerName)
  if (source === undefined) continue
  await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  if (workspacePackages.has(peerName)) {
    await cp(source, target, {
      recursive: true,
      force: true,
      filter: (entry) => !relative(source, entry).split(sep).includes('node_modules')
    })
  } else {
    await symlink(relative(dirname(target), await realpath(source)), target)
  }
  peerPackageCount += 1
}
try {
  await access(join(deployedWebRoot, 'dist', 'index.html'))
} catch {
  await cp(join(runtimeSource, 'apps', 'web', 'dist'), join(deployedWebRoot, 'dist'), {
    recursive: true,
    force: true
  })
}

const runtimeNodeModules = join(destination, 'node_modules', '.pnpm', 'node_modules')
const runtimeKoffi = join(runtimeNodeModules, 'koffi')
execFileSync('node', ['./cnoke.cjs', '-P', '.', '-D', 'src/koffi', '--prebuild', '--release'], {
  cwd: runtimeKoffi,
  env: { ...process.env, CI: 'true' },
  stdio: 'inherit'
})

const runtimeSpawnHelper = join(runtimeNodeModules, '@deepseek-ai', 'dsh-subprocess-local')
execFileSync('node', ['scripts/ensure-spawn-helper.mjs'], {
  cwd: runtimeSpawnHelper,
  env: { ...process.env, CI: 'true' },
  stdio: 'inherit'
})

const runtimeRoot = await realpath(destination)
const pending = [destination]
let materializedCount = 0
while (pending.length > 0) {
  const current = pending.pop()
  if (current === undefined) continue
  const stats = await lstat(current)
  if (stats.isSymbolicLink()) {
    const target = await realpath(current)
    const relativeTarget = relative(runtimeRoot, target)
    const targetIsInside = relativeTarget === ''
      || (!relativeTarget.startsWith(`..${sep}`) && relativeTarget !== '..' && !isAbsolute(relativeTarget))
    if (!targetIsInside) {
      await rm(current, { recursive: true, force: true })
      await cp(target, current, {
        recursive: true,
        dereference: false,
        force: true,
        filter: (source) => {
          const relativeSource = relative(target, source)
          return relativeSource === '' && source === target
            || !relativeSource.split(sep).includes('node_modules')
        }
      })
      materializedCount += 1
      pending.push(current)
    }
    continue
  }
  if (!stats.isDirectory()) continue
  for (const entry of await readdir(current)) pending.push(join(current, entry))
}

// Workspace peers are copied from source directories because they are not
// published packages. Remove development-only payloads before packaging so
// electron-builder does not need to open tens of thousands of irrelevant files.
await pruneRuntimeFiles(destination)

// Node resolves a package imported through a symlink relative to the symlink
// path. Expose pnpm's public dependency links at the deployment root as well,
// so those imports keep working after the app is moved into Resources/app.
const publicNodeModules = join(runtimeNodeModules)
let rootDependencyLinkCount = 0
for (const scopeEntry of await readdir(publicNodeModules, { withFileTypes: true })) {
  if (scopeEntry.name.startsWith('.')) continue
  const sourceScope = join(publicNodeModules, scopeEntry.name)
  if (scopeEntry.name.startsWith('@')) {
    if (!scopeEntry.isDirectory()) continue
    const targetScope = join(rootNodeModules, scopeEntry.name)
    await mkdir(targetScope, { recursive: true })
    for (const packageEntry of await readdir(sourceScope)) {
      const sourcePackage = await realpath(join(sourceScope, packageEntry))
      const targetPackage = join(targetScope, packageEntry)
      try {
        await lstat(targetPackage)
        continue
      } catch {
        // The package is not already exposed at the deployment root.
      }
      await symlink(relative(dirname(targetPackage), sourcePackage), targetPackage)
      rootDependencyLinkCount += 1
    }
    continue
  }

  const sourcePackage = await realpath(sourceScope)
  const targetPackage = join(rootNodeModules, scopeEntry.name)
  try {
    await lstat(targetPackage)
    continue
  } catch {
    // The package is not already exposed at the deployment root.
  }
  await symlink(relative(dirname(targetPackage), sourcePackage), targetPackage)
  rootDependencyLinkCount += 1
}

const runtimeArchive = join(projectRoot, 'out', 'dsh-runtime.tar.gz')
await rm(runtimeArchive, { force: true })
await createArchive({
  cwd: join(projectRoot, 'out'),
  file: runtimeArchive,
  gzip: true,
  portable: true
}, ['dsh-runtime'])

console.log(`Staged DSH Runtime at ${destination} (${String(materializedCount)} external links materialized, ${String(peerPackageCount)} peer packages added, ${String(rootDependencyLinkCount)} root dependency links added)`)
