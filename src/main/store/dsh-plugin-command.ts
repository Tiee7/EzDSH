/** Process bridge for the bundled DSH plugin command. */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import type { PluginCommandRunner } from './dsh-plugin-installer.js'

export interface DshPluginCommandOptions {
  readonly appPath: string
  readonly dshHome: string
  readonly launchRoot: string
  readonly runtimeEntryPath: string
  readonly command?: string
  readonly spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
}

export interface DshPluginCompatibilityContext {
  readonly dshVersion?: string
  readonly pnpmVersion?: string
  readonly profileHasWorkspaceFile: boolean
}

const KNOWN_WORKSPACE_ROOT_BUG_DSH_VERSION = '0.1.1-rc.2'

/**
 * Invoke DSH with the same bundled Node executable used by RuntimeManager.
 * DSH forwards the remaining arguments to pnpm, so the packaged pnpm bin
 * directory is placed at the front of PATH without consulting user tooling.
 */
export function createDshPluginCommand(options: DshPluginCommandOptions): PluginCommandRunner {
  const bundledVersions = readBundledVersions(options.appPath)
  const runCommand: PluginCommandRunner = async (profile, pluginArgs) => {
    const command = options.command ?? process.execPath
    const isElectronNode = command === process.execPath
    const compatibility = await bundledVersions
    const forwardedPluginArgs = applyDshPluginCompatibilityWorkaround(pluginArgs, {
      ...compatibility,
      profileHasWorkspaceFile: existsSync(join(options.dshHome, 'profiles', profile, 'pnpm-workspace.yaml'))
    })
    const args = isElectronNode
      ? ['--expose-internals', options.runtimeEntryPath, 'plugin', '--profile', profile, ...forwardedPluginArgs]
      : [options.runtimeEntryPath, 'plugin', '--profile', profile, ...forwardedPluginArgs]
    const pnpmBin = dirname(resolveBundledPnpm(options.appPath))
    const inheritedPath = process.env.PATH ?? ''
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: options.dshHome,
      PATH: [pnpmBin, dirname(command), inheritedPath].filter(Boolean).join(delimiter)
    }
    if (isElectronNode) environment.ELECTRON_RUN_AS_NODE = '1'
    else delete environment.ELECTRON_RUN_AS_NODE

    await runChild(options.spawnProcess ?? spawn, command, args, {
      cwd: options.launchRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  }

  runCommand.assertAvailable = () => {
    resolveBundledPnpm(options.appPath)
  }
  return runCommand
}

/**
 * Work around DSH 0.1.1-rc.2 creating a pnpm workspace and then forwarding
 * `add` without pnpm's explicit workspace-root flag. A workspace file is
 * sufficient evidence for existing profiles; the version matrix covers a
 * brand-new profile before DSH has had a chance to initialize it.
 */
export function applyDshPluginCompatibilityWorkaround(
  pluginArgs: readonly string[],
  context: DshPluginCompatibilityContext
): readonly string[] {
  const addIndex = pluginArgs.indexOf('add')
  if (addIndex === -1 || pluginArgs.some(isWorkspaceRootFlag)) return pluginArgs
  if (!context.profileHasWorkspaceFile && !isKnownWorkspaceRootBug(context)) return pluginArgs
  return [...pluginArgs.slice(0, addIndex + 1), '-w', ...pluginArgs.slice(addIndex + 1)]
}

function isWorkspaceRootFlag(argument: string): boolean {
  return argument === '-w' || argument === '--workspace-root' || argument.startsWith('--workspace-root=')
}

function isKnownWorkspaceRootBug(context: DshPluginCompatibilityContext): boolean {
  return context.dshVersion === KNOWN_WORKSPACE_ROOT_BUG_DSH_VERSION
    && isPnpmVersionWithWorkspaceRootGuard(context.pnpmVersion)
}

function isPnpmVersionWithWorkspaceRootGuard(version: string | undefined): boolean {
  const major = version === undefined ? undefined : /^(\d+)(?:\.\d+){0,2}(?:[-+].*)?$/.exec(version)?.[1]
  return major !== undefined && Number(major) >= 7
}

interface BundledVersions {
  readonly dshVersion?: string
  readonly pnpmVersion?: string
}

async function readBundledVersions(appPath: string): Promise<BundledVersions> {
  const [dshVersion, pnpmVersion] = await Promise.all([
    readPackageVersion(join(appPath, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
    readPackageVersion(join(appPath, 'node_modules', 'pnpm', 'package.json'))
  ])
  return { dshVersion, pnpmVersion }
}

async function readPackageVersion(path: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * DSH's plugin implementation invokes `pnpm` by name. Resolve it only from
 * the application bundle so Finder-launched builds do not depend on a user's
 * shell PATH. The second location supports an explicitly staged production
 * copy if the packager prunes the application root's node_modules/.bin.
 */
function resolveBundledPnpm(appPath: string): string {
  const executableNames = process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm'] : ['pnpm']
  const binDirectories = [
    join(appPath, 'node_modules', '.bin'),
    join(appPath, 'out', 'pnpm')
  ]
  for (const directory of binDirectories) {
    for (const name of executableNames) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('Bundled pnpm is missing from the EzDSH application. Rebuild or update the application before installing DSH plugins.')
}

function runChild(
  spawnProcess: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess,
  command: string,
  args: readonly string[],
  options: SpawnOptions
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = ''
    let settled = false
    const append = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-8_000)
    }
    let child: ChildProcess
    try {
      child = spawnProcess(command, args, options)
    } catch (error) {
      reject(error)
      return
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      if (code === 0) {
        resolve()
        return
      }
      const detail = output.trim()
      reject(new Error(`DSH plugin command failed (code=${String(code)}, signal=${String(signal)})${detail === '' ? '' : `: ${detail}`}`))
    })
  })
}
