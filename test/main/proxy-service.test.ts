import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ProxyService } from '../../src/main/proxy/proxy-service.js'

async function createService() {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-proxy-'))
  const applyRuntime = vi.fn(async () => undefined)
  const service = new ProxyService({
    configPath: join(directory, 'state', 'proxy.json'),
    applyRuntime,
  })
  await service.initialize()
  return { directory, service, applyRuntime }
}

describe('ProxyService', () => {
  it('persists multiple profiles but exposes no password to the renderer', async () => {
    const { directory, service, applyRuntime } = await createService()
    try {
      const saved = await service.save({
        name: 'Office',
        protocol: 'http',
        host: '127.0.0.1',
        port: 7890,
        username: 'alice',
        password: 'secret',
        bypass: ['example.com'],
      })
      const second = await service.save({
        name: 'Backup',
        protocol: 'https',
        host: 'proxy.example.com',
        port: 8443,
        bypass: [],
      })

      expect(saved.profiles[0]).toMatchObject({ name: 'Office', username: 'alice', passwordConfigured: true })
      expect(saved.profiles[0]).not.toHaveProperty('password')
      expect(second.profiles).toHaveLength(2)
      expect(applyRuntime).not.toHaveBeenCalled()

      const persisted = await readFile(join(directory, 'state', 'proxy.json'), 'utf8')
      expect(JSON.parse(persisted).profiles[0]).toMatchObject({ password: 'secret' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('activates one profile at a time and applies proxy changes immediately', async () => {
    const { directory, service, applyRuntime } = await createService()
    try {
      const first = await service.save({
        name: 'First',
        protocol: 'http',
        host: 'proxy.local',
        port: 8080,
        username: 'alice',
        password: 'p@ss',
        bypass: ['internal.example'],
      })
      const second = await service.save({
        name: 'Second',
        protocol: 'http',
        host: 'backup.local',
        port: 8081,
        bypass: [],
      })

      const active = await service.activate(first.profiles[0].id)
      expect(active.enabled).toBe(true)
      expect(active.activeProxyId).toBe(first.profiles[0].id)
      expect(active.profiles.filter((profile) => profile.id === active.activeProxyId)).toHaveLength(1)
      expect(applyRuntime).toHaveBeenCalledTimes(1)

      const environment = service.getRuntimeEnvironment({
        HTTP_PROXY: 'http://ambient.invalid',
        HTTPS_PROXY: 'http://ambient.invalid',
        NODE_USE_ENV_PROXY: '0',
      })
      expect(environment.HTTP_PROXY).toBe('http://alice:p%40ss@proxy.local:8080/')
      expect(environment.HTTPS_PROXY).toBe('http://alice:p%40ss@proxy.local:8080/')
      expect(environment.ALL_PROXY).toBe('http://alice:p%40ss@proxy.local:8080/')
      expect(environment.NO_PROXY).toContain('localhost')
      expect(environment.NO_PROXY).toContain('internal.example')
      expect(environment.NODE_USE_ENV_PROXY).toBe('1')

      const switched = await service.activate(second.profiles[1].id)
      expect(switched.activeProxyId).toBe(second.profiles[1].id)
      expect(applyRuntime).toHaveBeenCalledTimes(2)

      const disabled = await service.activate(undefined)
      expect(disabled.enabled).toBe(false)
      expect(disabled.activeProxyId).toBeUndefined()
      expect(applyRuntime).toHaveBeenCalledTimes(3)
      const directEnvironment = service.getRuntimeEnvironment({ HTTP_PROXY: 'http://ambient.invalid' })
      expect(directEnvironment.HTTP_PROXY).toBeUndefined()
      expect(directEnvironment.NODE_USE_ENV_PROXY).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('tests a saved profile without activating it or restarting Runtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-proxy-test-'))
    const applyRuntime = vi.fn(async () => undefined)
    const requestImpl = vi.fn(async () => ({
      statusCode: 204,
      body: { dump: async () => undefined },
    }))
    const service = new ProxyService({
      configPath: join(directory, 'state', 'proxy.json'),
      applyRuntime,
      requestImpl,
    } as never)
    await service.initialize()
    try {
      const saved = await service.save({
        name: 'Office',
        protocol: 'http',
        host: 'proxy.local',
        port: 8080,
        bypass: [],
      })
      const testable = service as unknown as {
        test(id: string): Promise<{ reachable: boolean; statusCode?: number }>
      }

      const result = await testable.test(saved.profiles[0].id)

      expect(result).toMatchObject({ reachable: true, statusCode: 204 })
      expect(requestImpl).toHaveBeenCalledTimes(1)
      expect(applyRuntime).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps a stored password when editing without entering a new one', async () => {
    const { directory, service, applyRuntime } = await createService()
    try {
      const created = await service.save({
        name: 'Office',
        protocol: 'http',
        host: 'proxy.local',
        port: 8080,
        username: 'alice',
        password: 'secret',
        bypass: [],
      })
      await service.activate(created.profiles[0].id)
      await service.save({
        id: created.profiles[0].id,
        name: 'Office 2',
        protocol: 'http',
        host: 'proxy.local',
        port: 8080,
        username: 'alice',
        password: '',
        bypass: [],
      })

      expect(service.getRuntimeEnvironment().HTTP_PROXY).toBe('http://alice:secret@proxy.local:8080/')
      expect(service.snapshot().profiles[0].passwordConfigured).toBe(true)
      expect(applyRuntime).toHaveBeenCalledTimes(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects malformed proxy addresses and ports', async () => {
    const { directory, service } = await createService()
    try {
      await expect(service.save({
        name: 'Bad host',
        protocol: 'http',
        host: 'http://proxy.local',
        port: 8080,
        bypass: [],
      })).rejects.toThrow('代理地址无效')
      await expect(service.save({
        name: 'Bad port',
        protocol: 'http',
        host: 'proxy.local',
        port: 65_536,
        bypass: [],
      })).rejects.toThrow('代理端口')
      await expect(service.save({
        name: 'Port in host',
        protocol: 'http',
        host: 'proxy.local:8080',
        port: 8081,
        bypass: [],
      })).rejects.toThrow('代理地址无效')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
