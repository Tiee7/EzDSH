import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { applyDshPluginCompatibilityWorkaround, createDshPluginCommand } from '../../src/main/store/dsh-plugin-command'
import type { ChildProcess } from 'node:child_process'

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
      '-w',
      'npm:dsh-agent-teams@1.0.0'
    ])
    expect(captured?.env?.DSH_HOME).toBe('/data/harness')
    expect(captured?.env?.PATH?.startsWith(`${process.cwd()}/node_modules/.bin`)).toBe(true)
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
})
