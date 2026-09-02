import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowCredentialStore } from '../../src/main/workflow/workflow-credential-service.js'

const scopes = [{ origin: 'https://api.example.test', methods: ['GET', 'POST'] as const, headerName: 'Authorization', prefix: 'Bearer', pathPrefixes: ['/v1'] }]

describe('WorkflowCredentialStore security contract', () => {
  it('keeps an encrypted secret when metadata is updated without a new secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-credential-store-'))
    const store = new WorkflowCredentialStore(dir)
    await store.upsert({ id: 'crm-token', label: 'Old', type: 'bearer-token', scopes, secret: 'one-secret' })
    await store.upsert({ id: 'crm-token', label: 'New', type: 'bearer-token', scopes })
    expect(await store.resolveSecret('crm-token')).toBe('one-secret')
    expect(JSON.stringify(store.listMetadata())).not.toContain('one-secret')
    expect((await stat(join(dir, '.workflow-credentials.json'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(dir, '.workflow-credentials.json'), 'utf8')).not.toContain('one-secret')
  })

  it('rejects non-HTTPS and unscoped credential definitions', async () => {
    const store = new WorkflowCredentialStore(await mkdtemp(join(tmpdir(), 'ezdsh-credential-store-')))
    await expect(store.upsert({ id: 'bad', label: 'Bad', type: 'bearer-token', scopes: [{ origin: 'http://api.example.test', methods: ['GET'], headerName: 'Authorization' }] as never, secret: 'secret' })).rejects.toThrow(/访问范围无效/u)
    await expect(store.upsert({ id: 'bad', label: 'Bad', type: 'bearer-token', scopes: [{ origin: 'https://api.example.test', methods: ['GET'], headerName: 'Authorization', pathPrefixes: ['/v1/../admin'] }], secret: 'secret' })).rejects.toThrow(/访问范围无效/u)
  })
})
