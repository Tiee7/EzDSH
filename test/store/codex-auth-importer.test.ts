import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { importCodexAuth } from '../../src/main/store/codex-auth-importer'

const workdirs: string[] = []

afterEach(async () => {
  await Promise.all(workdirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

async function fixture(): Promise<{ root: string; authPath: string; credentialsPath: string; markerPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-codex-auth-'))
  workdirs.push(root)
  const authPath = join(root, 'codex', 'auth.json')
  const credentialsPath = join(root, 'harness', '.credentials.yaml')
  const markerPath = join(root, 'state', 'codex-auth-imported')
  await mkdir(join(root, 'codex'), { recursive: true })
  return { root, authPath, credentialsPath, markerPath }
}

describe('Codex auth importer', () => {
  it('imports a valid ChatGPT OAuth record into the DSH credential document', async () => {
    const { authPath, credentialsPath, markerPath } = await fixture()
    const expires = Math.floor(Date.now() / 1000) + 3600
    await writeFile(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: token({ exp: expires }),
        refresh_token: 'refresh-token',
        account_id: 'account-123',
      },
    }))

    await expect(importCodexAuth(credentialsPath, authPath, markerPath)).resolves.toBe(true)

    const document = parseDocument(await readFile(credentialsPath, 'utf8'))
    const value = document.getIn(['refs', 'OPENAI_CODEX_OAUTH'])
    expect(JSON.parse(String(value))).toEqual({
      type: 'oauth',
      access: token({ exp: expires }),
      refresh: 'refresh-token',
      expires: expires * 1000,
      accountId: 'account-123',
    })
    expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600)
    await expect(readFile(markerPath, 'utf8')).resolves.toBe('imported\n')
  })

  it('does not overwrite an existing DSH Codex credential', async () => {
    const { authPath, credentialsPath, markerPath } = await fixture()
    const expires = Math.floor(Date.now() / 1000) + 3600
    await writeFile(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: token({ exp: expires }), refresh_token: 'new', account_id: 'new-account' },
    }))
    await mkdir(join(credentialsPath, '..'), { recursive: true })
    await writeFile(credentialsPath, 'version: 1\nrefs:\n  OPENAI_CODEX_OAUTH: existing\n', { mode: 0o600 })

    await expect(importCodexAuth(credentialsPath, authPath, markerPath)).resolves.toBe(false)
    expect(await readFile(credentialsPath, 'utf8')).toContain('OPENAI_CODEX_OAUTH: existing')
    await expect(readFile(markerPath, 'utf8')).resolves.toBe('imported\n')
  })

  it('does not re-import after the one-time migration marker is present', async () => {
    const { authPath, credentialsPath, markerPath } = await fixture()
    const expires = Math.floor(Date.now() / 1000) + 3600
    await writeFile(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: token({ exp: expires }), refresh_token: 'refresh', account_id: 'account' },
    }))

    await expect(importCodexAuth(credentialsPath, authPath, markerPath)).resolves.toBe(true)
    await rm(credentialsPath)
    await expect(importCodexAuth(credentialsPath, authPath, markerPath)).resolves.toBe(false)
  })

  it('ignores non-ChatGPT or expired auth files', async () => {
    const { authPath, credentialsPath, markerPath } = await fixture()
    await writeFile(authPath, JSON.stringify({ auth_mode: 'apikey', tokens: {} }))
    await expect(importCodexAuth(credentialsPath, authPath, markerPath)).resolves.toBe(false)

    await writeFile(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: token({ exp: Math.floor(Date.now() / 1000) - 1 }), refresh_token: 'expired', account_id: 'expired' },
    }))
    await expect(importCodexAuth(credentialsPath, authPath, markerPath)).resolves.toBe(false)
  })

  it('does not replace a malformed DSH credential document', async () => {
    const { authPath, credentialsPath, markerPath } = await fixture()
    const expires = Math.floor(Date.now() / 1000) + 3600
    await writeFile(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: token({ exp: expires }), refresh_token: 'refresh', account_id: 'account' },
    }))
    await mkdir(join(credentialsPath, '..'), { recursive: true })
    const malformed = 'version: 1\nrefs: [broken\n'
    await writeFile(credentialsPath, malformed, { mode: 0o600 })

    await expect(importCodexAuth(credentialsPath, authPath, markerPath)).resolves.toBe(false)
    await expect(readFile(credentialsPath, 'utf8')).resolves.toBe(malformed)
  })
})
