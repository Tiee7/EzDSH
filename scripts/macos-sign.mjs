import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// The default electron-osx-sign walker opens every file under Contents in
// parallel. EzDSH intentionally ships an unarchived pnpm Runtime tree, so use
// Apple's native deep signer instead of enumerating that dependency graph.
const execFileAsync = promisify(execFile)
const CODESIGN = '/usr/bin/codesign'

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

export function buildCodesignArgs(options, fileOptions = {}) {
  requireApp(options)
  requireIdentity(options)

  const args = ['--deep', '--force']
  if (fileOptions.timestamp === 'none') args.push('--timestamp=none')
  else if (typeof fileOptions.timestamp === 'string' && fileOptions.timestamp.length > 0) {
    args.push(`--timestamp=${fileOptions.timestamp}`)
  } else {
    args.push('--timestamp')
  }
  if (fileOptions.hardenedRuntime === true) args.push('--options', 'runtime')
  if (typeof fileOptions.requirements === 'string' && fileOptions.requirements.length > 0) {
    args.push(fileOptions.requirements.startsWith('=') ? `-r${fileOptions.requirements}` : '--requirements', fileOptions.requirements)
  }
  if (Array.isArray(fileOptions.additionalArguments)) args.push(...fileOptions.additionalArguments)
  if (typeof options.keychain === 'string' && options.keychain.length > 0) args.push('--keychain', options.keychain)
  if (typeof fileOptions.entitlements === 'string' && fileOptions.entitlements.length > 0) {
    args.push('--entitlements', fileOptions.entitlements)
  }
  args.push('--sign', options.identity, options.app)
  return args
}

export function buildVerifyArgs(options) {
  requireApp(options)
  const args = ['--verify', '--deep']
  if (options.strictVerify !== false) args.push('--strict')
  args.push(options.app)
  return args
}

export default async function signMacApplication(options) {
  requireApp(options)
  requireIdentity(options)
  if (process.platform !== 'darwin') {
    throw new Error(`macOS signing is only supported on darwin, received ${process.platform}`)
  }

  const fileOptions = typeof options.optionsForFile === 'function'
    ? await options.optionsForFile(options.app)
    : {}

  await execFileAsync(CODESIGN, buildCodesignArgs(options, fileOptions), {
    maxBuffer: 10 * 1024 * 1024
  })
  await execFileAsync(CODESIGN, buildVerifyArgs(options), {
    maxBuffer: 10 * 1024 * 1024
  })
}
