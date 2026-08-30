/** Process bridge for the bundled DSH plugin command. */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import type { PluginCommandRunner } from './dsh-plugin-installer.js'

export interface DshPluginCommandOptions {
  readonly appPath: string
  readonly dshHome: string
  readonly launchRoot: string
  /** Optional persistent directory for DSH plugin command logs. */
  readonly logsDir?: string
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
    const profileHasWorkspaceFile = existsSync(join(options.dshHome, 'profiles', profile, 'pnpm-workspace.yaml'))
    const forwardedPluginArgs = applyDshPluginCompatibilityWorkaround(pluginArgs, {
      ...compatibility,
      profileHasWorkspaceFile
    })
    const args = isElectronNode
      ? ['--expose-internals', options.runtimeEntryPath, 'plugin', '--profile', profile, ...forwardedPluginArgs]
      : [options.runtimeEntryPath, 'plugin', '--profile', profile, ...forwardedPluginArgs]
    const logPath = await createPluginLog(options.logsDir, {
      profile,
      command,
      args: forwardedPluginArgs,
      runtimeArgs: args,
      dshVersion: compatibility.dshVersion,
      pnpmVersion: compatibility.pnpmVersion,
      profileHasWorkspaceFile,
      workspaceRootWorkaroundApplied: forwardedPluginArgs.length !== pluginArgs.length
    })
    let childAttempted = false
    try {
      const pnpmBin = dirname(resolveBundledPnpm(options.appPath))
      const inheritedPath = process.env.PATH ?? ''
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        DSH_HOME: options.dshHome,
        PATH: [pnpmBin, dirname(command), inheritedPath].filter(Boolean).join(delimiter)
      }
      if (isElectronNode) environment.ELECTRON_RUN_AS_NODE = '1'
      else delete environment.ELECTRON_RUN_AS_NODE

      childAttempted = true
      await runChild(options.spawnProcess ?? spawn, command, args, {
        cwd: options.launchRoot,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe']
      }, logPath)
    } catch (error) {
      if (!childAttempted) await finishPluginLog(logPath, `status=failed\nerror=${logValue(error)}\n`)
      throw withPluginLogPath(error, logPath)
    }
  }

  runCommand.assertAvailable = () => {
    resolveBundledPnpm(options.appPath)
  }
  return runCommand
}

interface PluginLogMetadata {
  readonly profile: string
  readonly command: string
  readonly args: readonly string[]
  readonly runtimeArgs: readonly string[]
  readonly dshVersion?: string
  readonly pnpmVersion?: string
  readonly profileHasWorkspaceFile: boolean
  readonly workspaceRootWorkaroundApplied: boolean
}

/** Start one durable log without making logging failures affect the install. */
async function createPluginLog(logsDir: string | undefined, metadata: PluginLogMetadata): Promise<string | undefined> {
  if (logsDir === undefined) return undefined
  try {
    const directory = join(logsDir, 'plugins')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const operation = metadata.args[0] ?? 'command'
    const filename = [
      new Date().toISOString().replace(/[.:]/g, '-'),
      safeLogToken(metadata.profile),
      safeLogToken(operation),
      randomUUID(),
    ].join('-') + '.log'
    const path = join(directory, filename)
    const header = [
      'EzDSH DSH plugin operation',
      `startedAt=${new Date().toISOString()}`,
      `profile=${logValue(metadata.profile)}`,
      `command=${logValue(metadata.command)}`,
      `dshVersion=${logValue(metadata.dshVersion ?? 'unknown')}`,
      `pnpmVersion=${logValue(metadata.pnpmVersion ?? 'unknown')}`,
      `profileHasWorkspaceFile=${String(metadata.profileHasWorkspaceFile)}`,
      `workspaceRootWorkaroundApplied=${String(metadata.workspaceRootWorkaroundApplied)}`,
      `pluginArgs=${JSON.stringify([...metadata.args])}`,
      `runtimeArgs=${JSON.stringify([...metadata.runtimeArgs])}`,
      '--- output ---',
      ''
    ].join('\n')
    await writeFile(path, header, { encoding: 'utf8', mode: 0o600 })
    return path
  } catch {
    return undefined
  }
}

function safeLogToken(value: string): string {
  const token = value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
  return token === '' ? 'unknown' : token
}

function logValue(value: unknown): string {
  return String(value).replace(/[\r\n]+/g, '\\n')
}

async function finishPluginLog(logPath: string | undefined, footer: string): Promise<void> {
  if (logPath === undefined) return
  try {
    await appendFile(logPath, `${footer}endedAt=${new Date().toISOString()}\n`, 'utf8')
  } catch {
    // A log is diagnostic evidence, never a reason to change the command result.
  }
}

function withPluginLogPath(error: unknown, logPath: string | undefined): unknown {
  if (logPath === undefined) return error
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes(logPath)) return error
  const wrapped = new Error(`${message}\nPlugin command log: ${logPath}`, { cause: error })
  Object.defineProperty(wrapped, 'logPath', { value: logPath, enumerable: true })
  return wrapped
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

export async function readBundledVersions(appPath: string): Promise<BundledVersions> {
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
export function resolveBundledPnpm(appPath: string): string {
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
  options: SpawnOptions,
  logPath?: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = ''
    let settled = false
    let logWrites = Promise.resolve()
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-8_000)
      if (logPath !== undefined) {
        const line = `[${stream}] ${String(chunk)}`
        logWrites = logWrites.then(() => appendFile(logPath, line, 'utf8')).catch(() => undefined)
      }
    }
    const finish = (footer: string): Promise<void> => {
      if (logPath === undefined) return Promise.resolve()
      return logWrites
        .then(() => appendFile(logPath, `${footer}endedAt=${new Date().toISOString()}\n`, 'utf8'))
        .catch(() => undefined)
    }
    let child: ChildProcess
    try {
      child = spawnProcess(command, args, options)
    } catch (error) {
      settled = true
      void finish(`status=spawn-error\nerror=${logValue(error)}\n`).then(() => reject(error))
      return
    }
    child.stdout?.on('data', (chunk) => append('stdout', chunk))
    child.stderr?.on('data', (chunk) => append('stderr', chunk))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      void finish(`status=error\nerror=${logValue(error)}\n`).then(() => reject(error))
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      if (code === 0) {
        void finish(`status=success\nexitCode=0\nsignal=${String(signal)}\n`).then(() => resolve())
        return
      }
      const detail = output.trim()
      const error = new Error(`DSH plugin command failed (code=${String(code)}, signal=${String(signal)})${detail === '' ? '' : `: ${detail}`}`)
      void finish(`status=failed\nexitCode=${String(code)}\nsignal=${String(signal)}\nerror=${logValue(error)}\n`).then(() => reject(error))
    })
  })
}
