import { chmod, lstat, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * npm repairs the executable bit on a bin target only while it is creating the
 * corresponding `.bin` link. When a dependency is re-extracted during an
 * install but its existing link is still valid, npm skips that step, so the
 * freshly unpacked file keeps the mode recorded in the tarball (0644) and
 * every later `node_modules/.bin/<name>` invocation dies with
 * "Permission denied". Restoring npm's executable mode keeps those links
 * usable after an incremental install.
 */
export async function fixBinPermissions(root = process.cwd(), {
  platform = process.platform,
  chmod: changeMode = chmod,
  umask = process.umask()
} = {}) {
  if (platform === 'win32') return []

  const rootPath = await realpathOrUndefined(root)
  const nodeModules = await realpathOrUndefined(join(root, 'node_modules'))
  if (rootPath === undefined || nodeModules === undefined) return []

  const binDir = join(nodeModules, '.bin')
  const binInfo = await lstatOrUndefined(binDir)
  if (binInfo === undefined || binInfo.isSymbolicLink() || !binInfo.isDirectory()) return []

  const fixed = []
  const errors = []
  const execMode = 0o777 & ~umask

  for (const entry of (await readdir(binDir)).sort()) {
    try {
      const linkPath = join(binDir, entry)
      const linkInfo = await lstatOrUndefined(linkPath)
      if (linkInfo === undefined || !linkInfo.isSymbolicLink()) continue

      const target = await realpathOrUndefined(linkPath)
      if (target === undefined || !isWithin(nodeModules, target)) continue

      const targetInfo = await statOrUndefined(target)
      if (targetInfo === undefined || !targetInfo.isFile() || (targetInfo.mode & 0o111) !== 0) continue

      await changeMode(target, execMode)
      fixed.push(relative(rootPath, target))
    } catch (error) {
      errors.push(error)
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to repair ${errors.length} bin target(s)`)
  }

  return fixed
}

function isWithin(parent, target) {
  const path = relative(parent, target)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function lstatOrUndefined(target) {
  try {
    return await lstat(target)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function realpathOrUndefined(target) {
  try {
    return await realpath(target)
  } catch (error) {
    if (isMissing(error) || error?.code === 'ELOOP') return undefined
    throw error
  }
}

async function statOrUndefined(target) {
  try {
    return await stat(target)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const fixed = await fixBinPermissions()
    if (fixed.length > 0) {
      console.log(`Restored executable mode on ${fixed.length} bin target(s):`)
      for (const path of fixed) console.log(`  ${path}`)
    }
  } catch (error) {
    console.error(`fix-bin-permissions: ${error.message}`)
    if (error instanceof AggregateError) {
      for (const cause of error.errors) console.error(`  ${cause?.message ?? String(cause)}`)
    }
    process.exitCode = 1
  }
}
