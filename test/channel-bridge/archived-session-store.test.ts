import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deleteArchivedSessionFromStore,
  removeArchivedSessionFromStore,
} from '../../src/main/channel-bridge/archived-session-store.js'
import { ChannelBridgeService } from '../../src/main/channel-bridge/index.js'
import { AdapterRegistry } from '../../src/main/channel-bridge/adapter-registry.js'
import type { UserDataLayout } from '../../src/shared/state.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('legacy workspace archive compatibility', () => {
  it('removes one id from the durable archive set without changing workspace records', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ezdsh-archive-store-'))
    roots.push(home)
    const storageDir = join(home, 'storages')
    const path = join(storageDir, 'workspace.json')
    const document = {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['workspace-1'], archivedSessionIds: ['session-a', 'session-b'] },
      tables: { workspaces: { 'workspace-1': { path: '/work', title: 'Work', sessionIds: ['session-a', 'session-b'] } } },
    }
    await mkdir(storageDir, { recursive: true })
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')

    await expect(removeArchivedSessionFromStore(home, 'session-a')).resolves.toBe(true)
    await expect(removeArchivedSessionFromStore(home, 'session-missing')).resolves.toBe(false)
    await expect(readFile(path, 'utf8').then((text) => JSON.parse(text))).resolves.toEqual({
      ...document,
      global: { ...document.global, archivedSessionIds: ['session-b'] },
    })
  })

  it('falls back to the store when the published Runtime has no unarchive RPC', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ezdsh-archive-fallback-'))
    roots.push(home)
    const storageDir = join(home, 'storages')
    await mkdir(storageDir, { recursive: true })
    await writeFile(join(storageDir, 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: ['session-a'] },
      tables: { workspaces: {} },
    }), 'utf8')

    vi.stubGlobal('fetch', async (): Promise<Response> => ({
      ok: false,
      status: 404,
      text: async () => 'not found',
    } as Response))
    const layout: UserDataLayout = {
      root: home,
      launchRoot: join(home, 'launch-root'),
      harness: home,
      workflowRoot: join(home, 'workflow'),
      logs: join(home, 'logs'),
      state: join(home, 'state'),
      backups: join(home, 'backups'),
    }
    const stopRuntime = async () => undefined
    const startRuntime = async () => undefined
    const service = new ChannelBridgeService({
      layout,
      getRuntimeUrl: () => 'http://localhost',
      stopRuntime,
      startRuntime,
      registry: new AdapterRegistry(),
    })

    await expect(service.unarchiveSession('session-a')).resolves.toBeUndefined()
    await expect(readFile(join(storageDir, 'workspace.json'), 'utf8').then((text) => JSON.parse(text))).resolves.toMatchObject({
      global: { archivedSessionIds: [] },
    })
    vi.unstubAllGlobals()
  })

  it('permanently deletes only an archived session and its durable session artifacts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ezdsh-archive-delete-'))
    roots.push(home)
    const storageDir = join(home, 'storages')
    const sessionDir = join(home, 'sessions', 'project-a', 'session-a')
    await mkdir(storageDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(storageDir, 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['workspace-1'], archivedSessionIds: ['session-a', 'session-b'] },
      tables: {
        workspaces: {
          'workspace-1': { path: '/work', title: 'Work', sessionIds: ['session-a', 'session-b', 'session-live'] },
        },
      },
    }), 'utf8')
    await writeFile(join(storageDir, 'session_projcache.json'), JSON.stringify({
      unit: { name: 'session_projcache', version: 3 },
      tables: {
        sessions: {
          'session-a': { identity: { cwd: '/work' }, rows: { title: { val: 'Delete me' } } },
          'session-b': { identity: { cwd: '/work' }, rows: { title: { val: 'Keep me' } } },
        },
      },
    }), 'utf8')
    await writeFile(join(sessionDir, 'session.jsonl.zstd'), 'session-a-log', 'utf8')
    await mkdir(join(home, 'sessions', 'project-a', 'session-b'), { recursive: true })
    await writeFile(join(home, 'sessions', 'project-a', 'session-b', 'session.jsonl.zstd'), 'session-b-log', 'utf8')

    await expect(deleteArchivedSessionFromStore(home, 'session-a')).resolves.toBe(true)
    await expect(deleteArchivedSessionFromStore(home, 'session-live')).resolves.toBe(false)
    await expect(stat(sessionDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(home, 'sessions', 'project-a', 'session-b'))).resolves.toBeDefined()
    await expect(readFile(join(storageDir, 'workspace.json'), 'utf8').then((text) => JSON.parse(text))).resolves.toMatchObject({
      global: { archivedSessionIds: ['session-b'] },
      tables: { workspaces: { 'workspace-1': { sessionIds: ['session-b', 'session-live'] } } },
    })
    await expect(readFile(join(storageDir, 'session_projcache.json'), 'utf8').then((text) => JSON.parse(text))).resolves.toMatchObject({
      tables: { sessions: { 'session-b': expect.anything() } },
    })
    await expect(readFile(join(storageDir, 'session_projcache.json'), 'utf8').then((text) => JSON.parse(text))).resolves.not.toHaveProperty('tables.sessions.session-a')
  })

  it('stops and starts the Runtime around a permanent delete', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ezdsh-archive-delete-service-'))
    roots.push(home)
    const storageDir = join(home, 'storages')
    await mkdir(storageDir, { recursive: true })
    await writeFile(join(storageDir, 'workspace.json'), JSON.stringify({
      global: { archivedSessionIds: ['session-a'] },
      tables: { workspaces: {} },
    }), 'utf8')
    const events: string[] = []
    const layout: UserDataLayout = {
      root: home,
      launchRoot: join(home, 'launch-root'),
      harness: home,
      workflowRoot: join(home, 'workflow'),
      logs: join(home, 'logs'),
      state: join(home, 'state'),
      backups: join(home, 'backups'),
    }
    const service = new ChannelBridgeService({
      layout,
      getRuntimeUrl: () => 'http://localhost',
      isDeveloperMode: () => true,
      stopRuntime: async () => { events.push('stop') },
      startRuntime: async () => { events.push('start') },
      registry: new AdapterRegistry(),
    })

    await expect(service.deleteArchivedSession('session-a')).resolves.toBeUndefined()
    expect(events).toEqual(['stop', 'start'])
  })

  it('refuses permanent deletion outside developer mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ezdsh-archive-delete-release-'))
    roots.push(home)
    const storageDir = join(home, 'storages')
    await mkdir(storageDir, { recursive: true })
    await writeFile(join(storageDir, 'workspace.json'), JSON.stringify({
      global: { archivedSessionIds: ['session-a'] },
      tables: { workspaces: {} },
    }), 'utf8')
    const events: string[] = []
    const layout: UserDataLayout = {
      root: home,
      launchRoot: join(home, 'launch-root'),
      harness: home,
      workflowRoot: join(home, 'workflow'),
      logs: join(home, 'logs'),
      state: join(home, 'state'),
      backups: join(home, 'backups'),
    }
    const service = new ChannelBridgeService({
      layout,
      getRuntimeUrl: () => 'http://localhost',
      isDeveloperMode: () => false,
      stopRuntime: async () => { events.push('stop') },
      startRuntime: async () => { events.push('start') },
      registry: new AdapterRegistry(),
    })

    await expect(service.deleteArchivedSession('session-a')).rejects.toThrow('开发者模式')
    expect(events).toEqual([])
  })
})
