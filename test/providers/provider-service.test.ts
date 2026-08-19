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

function modelListResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })
}

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
      baseUrl: 'https://api.deepseek.com',
      modelIds: []
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

  it('writes catalog providers as catalog references with selected models', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)

    await service.save({ providerId: 'zai', apiKey: 'zai-secret', modelIds: ['zai-latest'] })

    const settings = parse(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')) as {
      'llm-pi-ai': { providers: Record<string, Record<string, unknown>> }
    }
    expect(settings['llm-pi-ai'].providers.zai).toEqual({
      apiKeyEnv: 'ZAI_API_KEY',
      models: [{ id: 'zai-latest' }]
    })
  })

  it('writes custom providers with api and models', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)

    await service.save({
      providerId: 'volcengine',
      apiKey: 'volc-secret',
      modelIds: ['model-1', 'model-2']
    })

    const settings = parse(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')) as {
      'llm-pi-ai': { providers: Record<string, Record<string, unknown>> }
    }
    expect(settings['llm-pi-ai'].providers.volcengine).toEqual({
      apiKeyEnv: 'VOLCENGINE_API_KEY',
      api: 'openai-completions',
      models: [{ id: 'model-1' }, { id: 'model-2' }]
    })
  })

  it('saves custom provider IDs with their own display name, protocol, and key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)

    await service.save({
      providerId: 'kimi-work',
      displayName: 'Kimi Work',
      api: 'openai-responses',
      custom: true,
      apiKey: 'kimi-work-secret',
      baseUrl: 'https://gateway.example/v1',
      modelIds: ['kimi-model'],
      models: [{ id: 'kimi-model', name: 'Kimi Work Model' }]
    })

    const settings = parse(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')) as {
      'llm-pi-ai': { providers: Record<string, Record<string, unknown>> }
    }
    const credentials = parse(await readFile(join(layout.harness, '.credentials.yaml'), 'utf8')) as Record<string, unknown>
    expect(settings['llm-pi-ai'].providers['kimi-work']).toEqual({
      apiKeyEnv: 'EZDSH_KIMI_WORK_API_KEY',
      displayName: 'Kimi Work',
      api: 'openai-responses',
      baseURL: 'https://gateway.example/v1',
      models: [{ id: 'kimi-model', name: 'Kimi Work Model' }]
    })
    expect(credentials.EZDSH_KIMI_WORK_API_KEY).toBe('kimi-work-secret')

    const definitions = await service.listDefinitions()
    expect(definitions.find((definition) => definition.id === 'kimi-work')).toMatchObject({
      displayName: 'Kimi Work',
      isCustom: true
    })
    await expect(service.getProfile('kimi-work')).resolves.toMatchObject({
      displayName: 'Kimi Work',
      api: 'openai-responses',
      isCustom: true
    })
  })

  it('persists model context and output limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)

    await service.save({
      providerId: 'sized-gateway',
      apiKey: 'sized-secret',
      custom: true,
      api: 'openai-completions',
      baseUrl: 'https://gateway.example/v1',
      modelIds: ['sized-model'],
      models: [{ id: 'sized-model', name: 'Sized Model', contextWindow: 262144, maxTokens: 32768 }]
    })

    const settings = parse(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')) as {
      'llm-pi-ai': { providers: Record<string, Record<string, unknown>> }
    }
    expect(settings['llm-pi-ai'].providers['sized-gateway'].models).toEqual([{
      id: 'sized-model',
      name: 'Sized Model',
      contextWindow: 262144,
      maxTokens: 32768
    }])
    await expect(service.getProfile('sized-gateway')).resolves.toMatchObject({
      models: [{ id: 'sized-model', name: 'Sized Model', contextWindow: 262144, maxTokens: 32768 }]
    })
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

  it('lists models from the provider endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelListResponse(['a', 'b']))

    const models = await service.listModels({
      providerId: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example/v1/'
    })
    expect(models).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/v1/models', expect.any(Object))
    fetchMock.mockRestore()
  })

  it('falls back to builtin catalog when provider listing fails for a catalog provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'))

    const models = await service.listModels({
      providerId: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example/v1/'
    })
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((model) => model.id.includes('gpt'))).toBe(true)
    fetchMock.mockRestore()
  })

  it('throws when provider listing fails for a custom provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'))

    await expect(service.listModels({
      providerId: 'volcengine',
      apiKey: 'test-key',
      baseUrl: 'https://ark.example/v1/'
    })).rejects.toThrow('network error')
  })

  it('returns the saved profile and model IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)
    await service.save({
      providerId: 'zai',
      apiKey: 'zai-secret',
      baseUrl: 'https://api.z.example/v1',
      modelIds: ['zai-1', 'zai-2']
    })

    const profile = await service.getProfile('zai')
    expect(profile).toEqual({
      baseUrl: 'https://api.z.example/v1',
      modelIds: ['zai-1', 'zai-2']
    })
  })

  it('deletes the route and credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)
    await service.save({
      providerId: 'zai',
      apiKey: 'zai-secret',
      modelIds: ['zai-1']
    })

    const result = await service.delete('zai')
    expect(result.deleted).toBe(true)

    const settings = parse(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')) as {
      'llm-pi-ai': { providers: Record<string, unknown> }
    }
    const credentials = parse(await readFile(join(layout.harness, '.credentials.yaml'), 'utf8')) as Record<string, unknown>
    expect(settings['llm-pi-ai'].providers.zai).toBeUndefined()
    expect(credentials.ZAI_API_KEY).toBeUndefined()
  })

  it('recognizes kimi-coding as catalog and volcengine as custom', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)
    const definitions = await service.listDefinitions()
    const kimi = definitions.find((d) => d.id === 'kimi-coding')
    const volc = definitions.find((d) => d.id === 'volcengine')
    expect(kimi?.modelCatalogSource).toBe('catalog')
    expect(volc?.modelCatalogSource).toBe('custom')
  })

  it('exposes the official catalog base as the kimi-coding default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)

    const kimi = (await service.listDefinitions()).find((d) => d.id === 'kimi-coding')
    expect(kimi?.defaultBaseUrl).toBe('https://api.kimi.com/coding')
  })

  it('omits baseURL when a catalog provider base equals the official base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)

    await service.save({
      providerId: 'kimi-coding',
      apiKey: 'kimi-secret',
      baseUrl: 'https://api.kimi.com/coding',
      modelIds: ['kimi-for-coding']
    })

    const settings = parse(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')) as {
      'llm-pi-ai': { providers: Record<string, Record<string, unknown>> }
    }
    expect(settings['llm-pi-ai'].providers['kimi-coding']).toEqual({
      apiKeyEnv: 'KIMI_CODING_API_KEY',
      models: [{ id: 'kimi-for-coding' }]
    })
  })

  it('normalizes a trailing slash before comparing to the official base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)

    await service.save({
      providerId: 'kimi-coding',
      apiKey: 'kimi-secret',
      baseUrl: 'https://api.kimi.com/coding/',
      modelIds: ['kimi-for-coding']
    })

    const settings = parse(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')) as {
      'llm-pi-ai': { providers: Record<string, Record<string, unknown>> }
    }
    expect(settings['llm-pi-ai'].providers['kimi-coding'].baseURL).toBeUndefined()
  })

  it('writes baseURL when a catalog provider base differs from the official base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const service = new ProviderService(layout)

    await service.save({
      providerId: 'kimi-coding',
      apiKey: 'kimi-secret',
      baseUrl: 'https://gateway.example/kimi',
      modelIds: ['kimi-for-coding']
    })

    const settings = parse(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')) as {
      'llm-pi-ai': { providers: Record<string, Record<string, unknown>> }
    }
    expect(settings['llm-pi-ai'].providers['kimi-coding']).toEqual({
      apiKeyEnv: 'KIMI_CODING_API_KEY',
      baseURL: 'https://gateway.example/kimi',
      models: [{ id: 'kimi-for-coding' }]
    })
  })

  it('drops a stale baseURL when saving a catalog provider without an override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    await writeFile(
      join(layout.harness, 'settings.yaml'),
      'llm-pi-ai:\n  providers:\n    kimi-coding:\n      apiKeyEnv: KIMI_CODING_API_KEY\n      baseURL: https://api.kimi.com/coding/v1\n',
      { mode: 0o600 }
    )
    const service = new ProviderService(layout)

    await service.save({ providerId: 'kimi-coding', apiKey: 'kimi-secret', modelIds: ['kimi-for-coding'] })

    const settings = parse(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')) as {
      'llm-pi-ai': { providers: Record<string, Record<string, unknown>> }
    }
    expect(settings['llm-pi-ai'].providers['kimi-coding']).toEqual({
      apiKeyEnv: 'KIMI_CODING_API_KEY',
      models: [{ id: 'kimi-for-coding' }]
    })
  })
})
