import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    cwd: '/tmp/workbench',
    env: { PORT: '3456' },
    enabled: true,
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

    await manager.create(definition({ id: 'workbench', autoStart: true }))
    await manager.create(definition({ id: 'docs', name: 'Docs', autoStart: false }))
    await manager.startAutoServices()

    expect(spawned).toEqual([[process.execPath, 'server.js']])
    expect(manager.list().find((item) => item.id === 'docs')?.state).toBe('stopped')

    const persisted = JSON.parse(await readFile(join(root, 'external-services.json'), 'utf8')) as unknown[]
    expect(persisted).toHaveLength(2)
  })

  it('isolates a failed startup to the failing service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-external-services-'))
    const manager = new ExternalServiceManager(options(root, (command) => {
      if (command === 'missing-command') throw new Error('not found')
      return new FakeChild() as unknown as ChildProcess
    }))
    await manager.initialize()
    await manager.create(definition({ id: 'good', name: 'Good' }))
    await manager.create(definition({ id: 'bad', name: 'Bad', command: 'missing-command' }))

    await manager.startAutoServices()

    expect(manager.list().find((item) => item.id === 'good')?.state).toBe('running')
    expect(manager.list().find((item) => item.id === 'bad')).toMatchObject({
      state: 'failed',
      error: 'not found',
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
    await manager.create(definition({ command: 'npm run dev', args: [] }))

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
    await manager.create(definition())
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
