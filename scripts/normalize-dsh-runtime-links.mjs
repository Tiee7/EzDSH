import { cp, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/**
 * Remove nested copies of packages whose module identity or importer topology
 * is part of the DSH runtime contract. The canonical package directory
 * remains available while the runtime-root copy is used by Node's normal
 * upward module resolution.
 */
export async function removeNestedIdentityLinks(pnpmRoot, packageNames, canonicalPaths = []) {
  const canonicalPathSet = new Set(canonicalPaths)
  const suffixes = packageNames.map((packageName) => join('node_modules', ...packageName.split('/')))
  const pending = [pnpmRoot]
  let removedCount = 0

  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) continue
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      const childRelative = relative(pnpmRoot, child)
      const isCanonical = canonicalPathSet.has(child)
      const isPublicLink = suffixes.includes(childRelative)
      const isNestedIdentityPackage = !isCanonical && !isPublicLink
        && suffixes.some((suffix) => childRelative.endsWith(`${sep}${suffix}`))

      if (isNestedIdentityPackage) {
        await rm(child, { recursive: true, force: true })
        removedCount += 1
        continue
      }

      if (entry.isDirectory()) pending.push(child)
    }
  }

  return removedCount
}

/**
 * Materialize identity packages and their importer packages at the Runtime
 * root so electron-builder cannot preserve a Windows junction back into the
 * source checkout. Removing the public and nested links makes every importer
 * resolve from the packaged runtime instead of the build workspace.
 */
export async function materializeIdentityPackages(pnpmRoot, publicNodeModules, rootNodeModules, packageNames) {
  const canonicalPaths = []
  let materializedCount = 0

  for (const packageName of packageNames) {
    const packageSegments = packageName.split('/')
    const publicPackage = join(publicNodeModules, ...packageSegments)
    const publicPackageIsLink = (await lstat(publicPackage)).isSymbolicLink()
    const canonicalPath = await realpath(publicPackage)
    const rootPackage = join(rootNodeModules, ...packageSegments)
    await mkdir(join(rootNodeModules, ...packageSegments.slice(0, -1)), { recursive: true })
    await rm(rootPackage, { recursive: true, force: true })
    await cp(canonicalPath, rootPackage, { recursive: true, force: true })
    await rm(publicPackage, { recursive: true, force: true })
    // A normal pnpm deployment exposes this package through a link, so its
    // realpath is a separate canonical directory. If a package manager has
    // already copied it into the public location, that location is removed
    // below and must not be preserved as a second canonical path.
    if (publicPackageIsLink) canonicalPaths.push(canonicalPath)
    materializedCount += 1
  }

  return {
    materializedCount,
    nestedRemovedCount: await removeNestedIdentityLinks(pnpmRoot, packageNames, canonicalPaths)
  }
}
