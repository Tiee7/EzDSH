import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// The default electron-osx-sign walker opens every file under Contents in
// parallel. EzDSH intentionally ships an unarchived pnpm Runtime tree, so
// discover code objects sequentially and sign them from the deepest path out.
const execFileAsync = promisify(execFile)
const CODESIGN = '/usr/bin/codesign'
const CODE_CONTAINER_EXTENSIONS = new Set(['.app', '.framework', '.xpc', '.appex'])
const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca
])

function requireApp(options) {
  if (typeof options?.app !== 'string' || options.app.length === 0) {
    throw new Error('macOS signing requires an application bundle path')
  }
  if (!options.app.endsWith('.app')) {
    throw new Error(`macOS signing path must end with .app: ${options.app}`)
  }
}

function requireIdentity(options) {
  if (typeof options?.identity !== 'string' || options.identity.length === 0) {
    throw new Error('macOS signing requires a signing identity')
  }
}

function requireTarget(target) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('macOS signing requires a code object path')
  }
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

async function isMachO(filePath) {
  let handle
  try {
    handle = await open(filePath, 'r')
    const header = Buffer.alloc(4)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead !== header.length) return false
    return MACH_O_MAGICS.has(header.readUInt32BE(0))
  } finally {
    await handle?.close()
  }
}

function pathDepth(filePath) {
  return filePath.split(sep).length
}

function shouldIgnore(options, filePath) {
  const ignores = Array.isArray(options?.ignore) ? options.ignore : [options?.ignore]
  return ignores.some((ignore) => {
    if (typeof ignore === 'function') return ignore(filePath)
    if (ignore instanceof RegExp) {
      ignore.lastIndex = 0
      return ignore.test(filePath)
    }
    return typeof ignore === 'string' && filePath.includes(ignore)
  })
}

export async function collectCodePaths(appPath) {
  const app = resolve(appPath)
  const root = await realpath(app)
  const visitedDirectories = new Set()
  const codePaths = new Set()

  async function visit(candidatePath) {
    let currentPath = candidatePath
    let stats = await lstat(currentPath)

    if (stats.isSymbolicLink()) {
      currentPath = await realpath(currentPath)
      if (!isWithin(root, currentPath)) return
      stats = await lstat(currentPath)
    }

    if (stats.isDirectory()) {
      const directoryPath = await realpath(currentPath)
      if (visitedDirectories.has(directoryPath)) return
      if (!isWithin(root, directoryPath)) return
      visitedDirectories.add(directoryPath)

      const entries = await readdir(currentPath, { withFileTypes: true })
      for (const entry of entries) {
        await visit(join(currentPath, entry.name))
      }

      if (CODE_CONTAINER_EXTENSIONS.has(extname(currentPath))) {
        codePaths.add(currentPath)
      }
      return
    }

    if (stats.isFile() && await isMachO(currentPath)) {
      codePaths.add(currentPath)
    }
  }

  await visit(app)
  return [...codePaths].sort((left, right) => {
    const depthDifference = pathDepth(right) - pathDepth(left)
    return depthDifference === 0 ? left.localeCompare(right) : depthDifference
  })
}

export function buildCodesignArgs(options, fileOptions = {}, target = options?.app) {
  requireApp(options)
  requireIdentity(options)
  requireTarget(target)

  const args = ['--sign', options.identity, '--force']
  if (typeof options.keychain === 'string' && options.keychain.length > 0) {
    args.push('--keychain', options.keychain)
  }
  if (typeof fileOptions.requirements === 'string' && fileOptions.requirements.length > 0) {
    args.push(fileOptions.requirements.startsWith('=') ? `-r${fileOptions.requirements}` : '--requirements', fileOptions.requirements)
  }
  if (fileOptions.timestamp === 'none') args.push('--timestamp=none')
  else if (typeof fileOptions.timestamp === 'string' && fileOptions.timestamp.length > 0) {
    args.push(`--timestamp=${fileOptions.timestamp}`)
  } else {
    args.push('--timestamp')
  }

  const signatureFlags = Array.isArray(fileOptions.signatureFlags)
    ? [...fileOptions.signatureFlags]
    : typeof fileOptions.signatureFlags === 'string'
      ? fileOptions.signatureFlags.split(',').map((flag) => flag.trim()).filter(Boolean)
      : []
  if (fileOptions.hardenedRuntime === true && !signatureFlags.includes('runtime')) {
    signatureFlags.push('runtime')
  }
  if (signatureFlags.length > 0) args.push('--options', [...new Set(signatureFlags)].join(','))
  if (Array.isArray(fileOptions.additionalArguments)) args.push(...fileOptions.additionalArguments)
  if (typeof fileOptions.entitlements === 'string' && fileOptions.entitlements.length > 0) {
    args.push('--entitlements', fileOptions.entitlements)
  }
  args.push(target)
  return args
}

export function buildVerifyArgs(options) {
  requireApp(options)
  const args = ['--verify', '--deep']
  if (options.strictVerify !== false) {
    args.push(typeof options.strictVerify === 'string' ? `--strict=${options.strictVerify}` : '--strict')
  }
  args.push(options.app)
  return args
}

export default async function signMacApplication(options) {
  requireApp(options)
  requireIdentity(options)
  if (process.platform !== 'darwin') {
    throw new Error(`macOS signing is only supported on darwin, received ${process.platform}`)
  }

  const appPath = resolve(options.app)
  const appRealPath = await realpath(appPath)
  const discoveredPaths = await collectCodePaths(appPath)
  const targets = [...discoveredPaths, ...(Array.isArray(options.binaries) ? options.binaries : [])]
    .filter((target, index, allTargets) => {
      if (target !== appPath && target !== appRealPath && shouldIgnore(options, target)) return false
      return allTargets.indexOf(target) === index
    })
    .filter((target) => target !== appPath && target !== appRealPath)
  targets.push(appPath)

  for (const target of targets) {
    const fileOptions = typeof options.optionsForFile === 'function'
      ? await options.optionsForFile(target)
      : {}
    await execFileAsync(CODESIGN, buildCodesignArgs(options, fileOptions ?? {}, target), {
      maxBuffer: 10 * 1024 * 1024
    })
  }

  await execFileAsync(CODESIGN, buildVerifyArgs({ ...options, app: appPath }), {
    maxBuffer: 10 * 1024 * 1024
  })
}
