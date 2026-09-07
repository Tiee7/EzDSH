import { lstat, readdir, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/**
 * Remove nested copies of packages whose module identity is part of the DSH
 * runtime contract. The public pnpm link and the canonical package directory
 * remain available for Node's normal upward module resolution.
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
