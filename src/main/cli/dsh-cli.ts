import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { delimiter, dirname } from 'node:path'

export interface DshCliInvocation {
  readonly args: readonly string[]
}

export interface DshCliLaunchOptions {
  readonly command: string
  readonly runtimeEntryPath: string
  readonly pnpmPath: string
  readonly dshHome: string
  readonly dshArgs: readonly string[]
  readonly environment?: NodeJS.ProcessEnv
}

export interface DshCliLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly environment: NodeJS.ProcessEnv
}

export interface RunDshCliOptions extends DshCliLaunchOptions {
  readonly launchRoot: string
  readonly spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
}

/** Parse the command marker used by the packaged EzDSH launcher and dev mode. */
export function parseDshCliInvocation(argv: readonly string[]): DshCliInvocation | undefined {
  const markerIndex = argv.indexOf('--cli')
  if (markerIndex === -1 || argv[markerIndex + 1] !== 'dsh') return undefined
  return { args: argv.slice(markerIndex + 2) }
}

/** Build a DSH child process using EzDSH's bundled Runtime and package manager. */
export function buildDshCliLaunch(options: DshCliLaunchOptions): DshCliLaunch {
  const isElectronNode = options.command === process.execPath
  const args = isElectronNode
    ? ['--expose-internals', options.runtimeEntryPath, ...options.dshArgs]
    : [options.runtimeEntryPath, ...options.dshArgs]
  const environment: NodeJS.ProcessEnv = {
    ...(options.environment ?? process.env),
    PATH: [dirname(options.pnpmPath), dirname(options.command), options.environment?.PATH ?? process.env.PATH]
      .filter(Boolean)
      .join(delimiter),
    DSH_HOME: options.dshHome
  }
  if (isElectronNode) environment.ELECTRON_RUN_AS_NODE = '1'
  else delete environment.ELECTRON_RUN_AS_NODE
  return { command: options.command, args, environment }
}

/** Run one transparent DSH command and return its process exit code. */
export function runDshCli(options: RunDshCliOptions): Promise<number> {
  const launch = buildDshCliLaunch(options)
  return new Promise<number>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = (options.spawnProcess ?? spawn)(launch.command, launch.args, {
        cwd: options.launchRoot,
        env: launch.environment,
        stdio: 'inherit'
      })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}
