import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyDshPluginCompatibilityWorkaround, createDshPluginCommand } from '../../src/main/store/dsh-plugin-command'
import type { ChildProcess } from 'node:child_process'

const logRoots: string[] = []

afterEach(async () => {
  await Promise.all(logRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter() })
  return child
}

describe('createDshPluginCommand', () => {
  it('adds the workspace-root flag for the known DSH and pnpm compatibility pair', () => {
    expect(applyDshPluginCompatibilityWorkaround(['add', 'npm:plugin@1.0.0'], {
      dshVersion: '0.1.1-rc.2',
      pnpmVersion: '11.7.0',
      profileHasWorkspaceFile: false
    })).toEqual(['add', '-w', 'npm:plugin@1.0.0'])
  })

  it('uses an existing workspace marker and does not duplicate an explicit flag', () => {
    expect(applyDshPluginCompatibilityWorkaround(['add', 'npm:plugin@1.0.0'], {
      dshVersion: '0.1.1-rc.3',
      pnpmVersion: '11.7.0',
      profileHasWorkspaceFile: true
    })).toEqual(['add', '-w', 'npm:plugin@1.0.0'])
    expect(applyDshPluginCompatibilityWorkaround(['add', '-w', 'npm:plugin@1.0.0'], {
      dshVersion: '0.1.1-rc.2',
      pnpmVersion: '11.7.0',
      profileHasWorkspaceFile: true
    })).toEqual(['add', '-w', 'npm:plugin@1.0.0'])
  })

  it('does not alter remove commands or unsupported version combinations', () => {
    expect(applyDshPluginCompatibilityWorkaround(['remove', 'plugin'], {
      dshVersion: '0.1.1-rc.2',
      pnpmVersion: '11.7.0',
      profileHasWorkspaceFile: false
    })).toEqual(['remove', 'plugin'])
    expect(applyDshPluginCompatibilityWorkaround(['add', 'plugin'], {
      dshVersion: '0.1.1-rc.3',
      pnpmVersion: '11.7.0',
      profileHasWorkspaceFile: false
    })).toEqual(['add', 'plugin'])
  })

  it('fails preflight when the packaged app has no pnpm executable', () => {
    const command = createDshPluginCommand({
      appPath: '/app-without-pnpm',
      dshHome: '/data/harness',
      launchRoot: '/data',
      runtimeEntryPath: '/runtime/bin.js',
      command: '/runtime/node',
      spawnProcess: () => fakeChild()
    })

    expect(() => command.assertAvailable?.()).toThrow(/pnpm/i)
  })

  it('uses the bundled runtime and puts the packaged pnpm bin first on PATH', async () => {
    let captured: { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined
    const command = createDshPluginCommand({
      appPath: process.cwd(),
      dshHome: '/data/harness',
      launchRoot: '/data',
      runtimeEntryPath: '/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
      command: '/app/out/node-runtime/bin/node',
      spawnProcess: (spawnCommand, args, options) => {
        captured = { command: spawnCommand, args, env: options.env as NodeJS.ProcessEnv }
        const child = fakeChild()
        queueMicrotask(() => { child.emit('exit', 0, null) })
        return child
      }
    })

    await command('web', ['add', 'npm:dsh-agent-teams@1.0.0'])

    expect(captured?.command).toBe('/app/out/node-runtime/bin/node')
    expect(captured?.args).toEqual([
      '/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
      'plugin',
      '--profile',
      'web',
      'add',
      'npm:dsh-agent-teams@1.0.0'
    ])
    expect(captured?.env?.DSH_HOME).toBe('/data/harness')
    expect(captured?.env?.PATH?.startsWith(`${process.cwd()}/node_modules/.bin`)).toBe(true)
  })

  it('records the selected vendored Runtime version instead of the npm fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-plugin-runtime-version-'))
    logRoots.push(root)
    const runtimeRoot = join(root, 'out', 'dsh-runtime')
    const runtimeEntryPath = join(runtimeRoot, 'lib', 'bin.js')
    await mkdir(join(runtimeRoot, 'lib'), { recursive: true })
    await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.3-alpha.1' }))
    await mkdir(join(root, 'node_modules', 'pnpm'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'pnpm', 'package.json'), JSON.stringify({ name: 'pnpm', version: '11.7.0' }))
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
    await writeFile(join(root, 'node_modules', '.bin', 'pnpm'), '')

    const command = createDshPluginCommand({
      appPath: root,
      dshHome: join(root, 'harness'),
      launchRoot: root,
      logsDir: join(root, 'logs'),
      runtimeEntryPath,
      command: '/runtime/node',
      spawnProcess: (_spawnCommand, _args, _options) => {
        const child = fakeChild()
        queueMicrotask(() => child.emit('exit', 0, null))
        return child
      }
    })

    await command('web', ['list'])

    const files = await readdir(join(root, 'logs', 'plugins'))
    const log = await readFile(join(root, 'logs', 'plugins', files[0] as string), 'utf8')
    expect(log).toContain('dshVersion=0.1.3-alpha.1')
  })

  it('rejects a non-zero DSH command and includes captured output', async () => {
    const command = createDshPluginCommand({
      appPath: process.cwd(),
      dshHome: '/data/harness',
      launchRoot: '/data',
      runtimeEntryPath: '/runtime/bin.js',
      command: '/runtime/node',
      spawnProcess: (_spawnCommand, _args, _options) => {
        const child = fakeChild()
        queueMicrotask(() => {
          child.stderr?.emit('data', 'pnpm failed')
          child.emit('exit', 1, null)
        })
        return child
      }
    })

    await expect(command('web', ['remove', 'dsh-agent-teams'])).rejects.toThrow(/pnpm failed/)
  })

  it('persists plugin command output and the failure status in an install log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-plugin-command-'))
    logRoots.push(root)
    const command = createDshPluginCommand({
      appPath: process.cwd(),
      dshHome: join(root, 'harness'),
      launchRoot: root,
      logsDir: join(root, 'logs'),
      runtimeEntryPath: '/runtime/bin.js',
      command: '/runtime/node',
      spawnProcess: (_spawnCommand, _args, _options) => {
        const child = fakeChild()
        queueMicrotask(() => {
          child.stdout?.emit('data', 'initializing profile\n')
          child.stderr?.emit('data', 'ERR_PNPM_ADDING_TO_ROOT\n')
          child.emit('exit', 1, null)
        })
        return child
      }
    })

    const failure = await command('web', ['add', 'npm:plugin@1.0.0']).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(join(root, 'logs', 'plugins'))
    expect((failure as { logPath?: string }).logPath).toContain(join(root, 'logs', 'plugins'))

    const files = await readdir(join(root, 'logs', 'plugins'))
    expect(files).toHaveLength(1)
    const log = await readFile(join(root, 'logs', 'plugins', files[0] as string), 'utf8')
    expect(log).toContain('DSH plugin operation')
    expect(log).toContain('profile=web')
    expect(log).toContain('dshVersion=0.1.2-rc.1')
    expect(log).toContain('pnpmVersion=11.7.0')
    expect(log).toContain('workspaceRootWorkaroundApplied=false')
    expect(log).toContain('ERR_PNPM_ADDING_TO_ROOT')
    expect(log).toContain('exitCode=1')
  })
})
