import { describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import {
  ExternalServiceManager,
  type ExternalServiceDefinition,
  type ExternalServiceManagerOptions,
} from '../../src/main/external-services/external-service-manager.js'

class FakeChild extends EventEmitter {
  pid = 9001
  killed = false
  killCalls: string[] = []
  stdout = new EventEmitter()
  stderr = new EventEmitter()

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal ?? 'SIGTERM')
    this.killed = true
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'))
    return true
  }
}

function options(root: string, spawnProcess: ExternalServiceManagerOptions['spawnProcess']): ExternalServiceManagerOptions {
  return {
    configPath: join(root, 'external-services.json'),
    logsDir: join(root, 'logs'),
    spawnProcess,
    stopTimeoutMs: 100,
  }
}

function definition(overrides: Partial<ExternalServiceDefinition> = {}): ExternalServiceDefinition {
  return {
    id: 'workbench',
    name: 'Workbench',
    command: process.execPath,
    args: ['server.js'],
    cwd: tmpdir(),
    env: { PORT: '3456' },
    autoStart: true,
    ...overrides,
  }
}

describe('ExternalServiceManager', () => {
  it('persists definitions and keeps manual-only services stopped on auto-start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-services-'))
    const spawned: string[][] = []
    const manager = new ExternalServiceManager(options(root, (command, args) => {
      spawned.push([command, ...args])
      return new FakeChild() as unknown as ChildProcess
    }))
    await manager.initialize()

    await manager.create(definition({ cwd: root, id: 'workbench', autoStart: true }))
    await manager.create(definition({ cwd: root, id: 'docs', name: 'Docs', autoStart: false }))
    await manager.startAutoServices()

    expect(spawned).toEqual([[process.execPath, 'server.js']])
    expect(manager.list().find((item) => item.id === 'docs')?.state).toBe('stopped')

    const persisted = JSON.parse(await readFile(join(root, 'external-services.json'), 'utf8')) as unknown[]
    expect(persisted).toHaveLength(2)
  })

  it('treats every added service as managed and keeps manual start available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-services-'))
    const manager = new ExternalServiceManager(options(root, () => new FakeChild() as unknown as ChildProcess))
    await manager.initialize()

    const created = await manager.create(definition({ cwd: root, autoStart: false }))
    expect(created).not.toHaveProperty('enabled')

    await expect(manager.start('workbench')).resolves.toMatchObject({ state: 'running' })
  })

  it('isolates a failed startup to the failing service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-services-'))
    const manager = new ExternalServiceManager(options(root, (command) => {
      if (command === 'missing-command') throw new Error('not found')
      return new FakeChild() as unknown as ChildProcess
    }))
    await manager.initialize()
    await manager.create(definition({ cwd: root, id: 'good', name: 'Good' }))
    await manager.create(definition({ cwd: root, id: 'bad', name: 'Bad', command: 'missing-command' }))

    await manager.startAutoServices()

    expect(manager.list().find((item) => item.id === 'good')?.state).toBe('running')
    expect(manager.list().find((item) => item.id === 'bad')).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('not found'),
    })
    expect(manager.list().find((item) => item.id === 'bad')?.error).toContain('command: missing-command')
  })

  it('keeps non-zero exit results and captured output visible as a failed service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-services-'))
    const child = new FakeChild()
    const manager = new ExternalServiceManager(options(root, () => child as unknown as ChildProcess))
    await manager.initialize()
    await manager.create(definition({ cwd: root, autoStart: false }))

    await manager.start('workbench')
    child.stderr.emit('data', 'Port 3690 is already in use\n')
    child.emit('exit', 1, null)

    expect(manager.list().find((item) => item.id === 'workbench')).toMatchObject({
      state: 'failed',
      exitCode: 1,
      error: expect.stringContaining('Port 3690 is already in use'),
    })
  })

  it('splits a one-line command before spawning an existing service definition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-services-'))
    const spawned: string[][] = []
    const manager = new ExternalServiceManager(options(root, (command, args) => {
      spawned.push([command, ...args])
      return new FakeChild() as unknown as ChildProcess
    }))
    await manager.initialize()
    await manager.create(definition({ cwd: root, command: 'npm run dev', args: [] }))

    await manager.start('workbench')

    expect(spawned).toEqual([['npm', 'run', 'dev']])
  })

  it('supports stop and restart and publishes snapshots only to active watchers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-services-'))
    const children: FakeChild[] = []
    const manager = new ExternalServiceManager(options(root, () => {
      const child = new FakeChild()
      children.push(child)
      return child as unknown as ChildProcess
    }))
    await manager.initialize()
    await manager.create(definition({ cwd: root }))
    const snapshots: string[] = []
    const stopWatching = manager.watch((items) => {
      snapshots.push(items.find((item) => item.id === 'workbench')?.state ?? 'missing')
    })

    await manager.start('workbench')
    await manager.stop('workbench')
    await manager.restart('workbench')
    stopWatching()
    await manager.stopAll()

    expect(children).toHaveLength(2)
    expect(children[0]?.killCalls).toEqual(['SIGTERM'])
    expect(snapshots).toContain('running')
    expect(manager.list().find((item) => item.id === 'workbench')?.state).toBe('stopped')
  })
})


function spawnError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn failed: ${code}`), { code })
}

describe('ExternalServiceManager startup diagnosis', () => {
  it.each([
    ['missing', 'cwd-missing'],
    ['file', 'cwd-not-directory'],
  ] as const)('rejects a %s working directory before attempting spawn', async (kind, code) => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const cwd = join(root, '工作 目录')
    if (kind === 'file') await writeFile(cwd, 'not a directory')
    const spawnProcess = vi.fn(() => new FakeChild() as unknown as ChildProcess)
    const manager = new ExternalServiceManager(options(root, spawnProcess))
    await manager.create(definition({ cwd }))

    await expect(manager.start('workbench')).rejects.toThrow()
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(manager.list()[0]).toMatchObject({ state: 'failed', startupIssue: { code, path: cwd } })
    expect(manager.list()[0]?.error).toContain(`cwd: ${cwd}`)
    expect(JSON.parse(await readFile(join(root, 'external-services.json'), 'utf8'))[0]).not.toHaveProperty('startupIssue')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects a directory without traversal permission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const cwd = join(root, 'inaccessible')
    await mkdir(cwd, { mode: 0o600 })
    try {
      const spawnProcess = vi.fn(() => new FakeChild() as unknown as ChildProcess)
      const manager = new ExternalServiceManager(options(root, spawnProcess))
      await manager.create(definition({ cwd }))
      await expect(manager.start('workbench')).rejects.toThrow()
      expect(spawnProcess).not.toHaveBeenCalled()
      expect(manager.list()[0]).toMatchObject({ startupIssue: { code: 'cwd-inaccessible', path: cwd } })
    } finally {
      await chmod(cwd, 0o700)
    }
  })

  it('passes an existing Chinese directory with spaces as one cwd without creating extra paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const cwd = join(root, '中文 工作目录')
    await mkdir(cwd)
    const spawnProcess = vi.fn(() => new FakeChild() as unknown as ChildProcess)
    const manager = new ExternalServiceManager(options(root, spawnProcess))
    await manager.create(definition({ cwd }))
    await manager.start('workbench')
    expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({ cwd })
  })

  it.each(['~', '~/', 'relative', 'inherited'] as const)('handles %s working directories explicitly', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const cwd = kind === '~' || kind === '~/' ? kind : kind === 'relative' ? relative(process.cwd(), root) : undefined
    const spawnProcess = vi.fn(() => new FakeChild() as unknown as ChildProcess)
    const manager = new ExternalServiceManager(options(root, spawnProcess))
    await manager.create(definition({ cwd }))
    await manager.start('workbench')
    expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({ cwd: kind === '~' || kind === '~/' ? homedir() : kind === 'relative' ? root : undefined })
  })

  it('does not expand environment variables in working directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const cwd = join(root, '$HOME')
    const spawnProcess = vi.fn(() => new FakeChild() as unknown as ChildProcess)
    const manager = new ExternalServiceManager(options(root, spawnProcess))
    await manager.create(definition({ cwd }))
    await expect(manager.start('workbench')).rejects.toThrow()
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(manager.list()[0]).toMatchObject({ startupIssue: { code: 'cwd-missing', path: cwd } })
  })

  it('allows clearing a failed cwd and removes the stale diagnosis before retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const manager = new ExternalServiceManager(options(root, () => new FakeChild() as unknown as ChildProcess))
    await manager.create(definition({ cwd: join(root, 'missing') }))
    await manager.start('workbench').catch(() => {})
    expect(manager.list()[0]).toMatchObject({ state: 'failed', startupIssue: { code: 'cwd-missing' } })
    const updated = await manager.update('workbench', { cwd: '' })
    expect(updated.cwd).toBeUndefined()
    expect(updated.error).toBeUndefined()
    expect(updated.startupIssue).toBeUndefined()
    expect(updated.state).toBe('stopped')
    const restarted = await manager.start('workbench')
    expect(restarted.state).toBe('running')
    expect(restarted.startupIssue).toBeUndefined()
  })

  it('does not duplicate concurrent starts during preflight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const spawnProcess = vi.fn(() => new FakeChild() as unknown as ChildProcess)
    const manager = new ExternalServiceManager(options(root, spawnProcess))
    await manager.create(definition({ cwd: root }))
    await Promise.all([manager.start('workbench'), manager.start('workbench')])
    expect(spawnProcess).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')('confirms a missing command only when cwd exists and all search candidates are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const command = 'ezdsh-truly-missing-command'
    const manager = new ExternalServiceManager(options(root, () => { throw spawnError('ENOENT') }))
    await manager.create(definition({ cwd: root, command, env: { PATH: root } }))
    await expect(manager.start('workbench')).rejects.toThrow('ENOENT')
    expect(manager.list()[0]).toMatchObject({ startupIssue: { code: 'command-not-found', path: command } })
    expect(manager.list()[0]?.error).toContain(`command: ${command}`)
  })

  it.skipIf(process.platform === 'win32')('records a real asynchronous missing-command error without changing start rejection behavior', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const command = join(root, 'truly-absent')
    const manager = new ExternalServiceManager(options(root, undefined))
    await manager.create(definition({ cwd: root, command, args: [] }))
    await expect(manager.start('workbench')).resolves.toBeDefined()
    await vi.waitFor(() => expect(manager.list()[0]?.state).toBe('failed'))
    expect(manager.list()[0]).toMatchObject({ startupIssue: { code: 'command-not-found', path: command } })
  })

  it.skipIf(process.platform === 'win32')('does not call an existing broken command symlink an absent command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const command = join(root, 'tool-link')
    await symlink(join(root, 'removed-target'), command)
    const manager = new ExternalServiceManager(options(root, undefined))
    await manager.create(definition({ cwd: root, command, args: [] }))
    await manager.start('workbench')
    await vi.waitFor(() => expect(manager.list()[0]?.state).toBe('failed'))
    expect(manager.list()[0]).toMatchObject({ startupIssue: { code: 'command-unavailable', path: command } })
  })

  it.skipIf(process.platform === 'win32')('does not blame an existing script when its interpreter is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const command = join(root, 'script')
    await writeFile(command, '#!/ezdsh-nonexistent-interpreter\n', { mode: 0o700 })
    const manager = new ExternalServiceManager(options(root, undefined))
    await manager.create(definition({ cwd: root, command, args: [] }))
    await manager.start('workbench')
    await vi.waitFor(() => expect(manager.list()[0]?.state).toBe('failed'))
    expect(manager.list()[0]).toMatchObject({ startupIssue: { code: 'command-unavailable', path: command } })
    expect(manager.list()[0]?.error).toContain('ENOENT')
    expect(manager.list()[0]?.error).not.toContain('Install the executable')
  })

  it.each(['', 'bin'])('resolves relative PATH entry %j against the actual child cwd for diagnosis', async (pathEntry) => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const cwd = join(root, 'cwd')
    await mkdir(join(cwd, 'bin'), { recursive: true })
    await writeFile(join(cwd, pathEntry, 'existing-tool'), 'placeholder', { mode: 0o700 })
    const manager = new ExternalServiceManager(options(root, () => { throw spawnError('ENOENT') }))
    await manager.create(definition({ cwd, command: 'existing-tool', env: { PATH: [join(root, 'missing'), pathEntry].join(delimiter) } }))
    await manager.start('workbench').catch(() => {})
    expect(manager.list()[0]).toMatchObject({ startupIssue: { code: 'command-unavailable' } })
  })

  it.each(['sync', 'async'] as const)('rechecks cwd when it disappears between preflight and a %s spawn error', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const cwd = join(root, 'disappearing')
    await mkdir(cwd)
    const child = new FakeChild()
    const manager = new ExternalServiceManager(options(root, () => {
      rmSync(cwd, { recursive: true })
      if (kind === 'sync') throw spawnError('ENOENT')
      queueMicrotask(() => child.emit('error', spawnError('ENOENT')))
      return child as unknown as ChildProcess
    }))
    await manager.create(definition({ cwd }))
    await manager.start('workbench').catch(() => {})
    expect(manager.list()[0]).toMatchObject({ startupIssue: { code: 'cwd-missing', path: cwd } })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rechecks cwd access before blaming command permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const cwd = join(root, 'restricted-after-check')
    await mkdir(cwd)
    const child = new FakeChild()
    const manager = new ExternalServiceManager(options(root, () => child as unknown as ChildProcess))
    await manager.create(definition({ cwd }))
    await manager.start('workbench')
    try {
      await chmod(cwd, 0o600)
      child.emit('error', spawnError('EACCES'))
      expect(manager.list()[0]).toMatchObject({ startupIssue: { code: 'cwd-inaccessible', path: cwd } })
    } finally {
      await chmod(cwd, 0o700)
    }
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('identifies command permission only with filesystem evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const command = join(root, 'not-executable')
    await writeFile(command, 'placeholder', { mode: 0o600 })
    const manager = new ExternalServiceManager(options(root, () => { throw spawnError('EACCES') }))
    await manager.create(definition({ cwd: root, command }))
    await manager.start('workbench').catch(() => {})
    expect(manager.list()[0]).toMatchObject({ startupIssue: { code: 'command-not-executable', path: command } })
  })

  it('keeps an unexplained permission failure conservative', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const manager = new ExternalServiceManager(options(root, () => { throw spawnError('EPERM') }))
    await manager.create(definition({ cwd: root }))
    await manager.start('workbench').catch(() => {})
    expect(manager.list()[0]).toMatchObject({ startupIssue: { code: 'command-unavailable' } })
  })

  it('captures the resolved spawn command, cwd and environment for later asynchronous errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-diagnosis-'))
    const child = new FakeChild()
    const manager = new ExternalServiceManager({ ...options(root, () => child as unknown as ChildProcess), isPackaged: true })
    await manager.create(definition({ cwd: root, command: basename(process.execPath), env: { PATH: dirname(process.execPath) } }))
    await manager.start('workbench')
    manager.list()[0]!.env.PATH = '/edited-after-start'
    child.emit('error', spawnError('ENOENT'))
    expect(manager.list()[0]?.error).toContain(`command: ${process.execPath}`)
    expect(manager.list()[0]?.error).toContain(`cwd: ${root}`)
    expect(manager.list()[0]?.error).toContain(`PATH: ${dirname(process.execPath)}`)
    expect(manager.list()[0]?.error).not.toContain('/edited-after-start')
    expect(manager.list()[0]).toMatchObject({ startupIssue: { code: 'command-unavailable', path: process.execPath } })
  })
})
