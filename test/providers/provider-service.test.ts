import { readFile, rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
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
    expect(settings).toContain('llm-deepseek')
    expect(JSON.stringify(result)).not.toContain('secret-value')
  })
})
