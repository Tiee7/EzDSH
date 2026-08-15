import { readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { ProviderService } from '../../src/main/providers/provider-service'
import { needsProviderSetup } from '../../src/shared/providers'
import { ensureUserDataLayout, getUserDataLayout } from '../../src/main/state/user-data'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ProviderService', () => {
  it('requires setup when no provider is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)

    const statuses = await service.getStatuses()
    expect(needsProviderSetup(statuses)).toBe(true)
    expect(statuses.every((status) => status.usable === false)).toBe(true)
  })

  it('saves the credential and route while returning only redacted status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)

    const result = await service.save({
      providerId: 'deepseek-official',
      apiKey: 'secret-value',
      baseUrl: 'https://api.deepseek.com'
    })

    expect(result.status).toEqual({
      providerId: 'deepseek-official',
      hasCredential: true,
      routeConfigured: true,
      usable: true
    })
    const credentials = await readFile(join(layout.harness, '.credentials.yaml'), 'utf8')
    const settings = await readFile(join(layout.harness, 'settings.yaml'), 'utf8')
    expect(credentials).toContain('secret-value')
    const parsedSettings = parse(settings) as Record<string, Record<string, unknown>>
    expect(parsedSettings['llm-deepseek']).toMatchObject({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: 'https://api.deepseek.com'
    })
    expect(JSON.stringify(result)).not.toContain('secret-value')
  })

  it('writes catalog providers as catalog references without inventing custom fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)

    await service.save({ providerId: 'zai', apiKey: 'zai-secret' })

    const settings = parse(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')) as {
      'llm-pi-ai': { providers: Record<string, Record<string, unknown>> }
    }
    expect(settings['llm-pi-ai'].providers.zai).toEqual({ apiKeyEnv: 'ZAI_API_KEY' })
  })

  it('migrates legacy provider IDs before Runtime reads settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    await writeFile(
      join(layout.harness, 'settings.yaml'),
      'llm-pi-ai:\n  providers:\n    zhipuai:\n      apiKeyEnv: ZHIPU_API_KEY\n',
      { mode: 0o600 }
    )
    const service = new ProviderService(layout)

    await service.initialize()

    const settings = parse(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')) as {
      'llm-pi-ai': { providers: Record<string, Record<string, unknown>> }
    }
    expect(settings['llm-pi-ai'].providers.zai).toEqual({ apiKeyEnv: 'ZHIPU_API_KEY' })
    expect(settings['llm-pi-ai'].providers.zhipuai).toBeUndefined()
  })

  it('keeps the catalog base path when testing model discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

    await expect(service.testConnection({
      providerId: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example/v1/'
    })).resolves.toEqual({ reachable: true, message: '连接成功' })
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/v1/models', expect.any(Object))
    fetchMock.mockRestore()
  })
})
