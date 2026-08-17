import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DownloadError, downloadBundle } from '../../src/main/store/downloader'
import type { StoreFile } from '../../src/shared/store'

const OK_HOST = 'hub.ezdsh.com'

function fileUrl(path: string): string {
  return `https://${OK_HOST}/files/${path}`
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function storeFile(overrides: Partial<StoreFile> & Pick<StoreFile, 'path'>): StoreFile {
  return { url: fileUrl(overrides.path), sha256: '', kind: 'text', ...overrides }
}

function okFetch(bytesByPath: Record<string, Buffer>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const path = new URL(String(url)).pathname.replace(/^\/files\//, '')
    const bytes = bytesByPath[path]
    if (bytes === undefined) return new Response('not found', { status: 404 })
    return new Response(new Uint8Array(bytes), { status: 200 })
  }) as unknown as typeof fetch
}

describe('downloadBundle happy path', () => {
  it('returns verified file buffers keyed by declared path', async () => {
    const body = Buffer.from('---\nname: demo\ndescription: demo\n---\n\nhello')
    const files = [storeFile({ path: 'demo/SKILL.md', sha256: sha256(body) })]
    const bundle = await downloadBundle(files, { fetchImpl: okFetch({ 'demo/SKILL.md': body }) })
    expect(bundle.files).toHaveLength(1)
    expect(bundle.files[0]?.path).toBe('demo/SKILL.md')
    expect(bundle.files[0]?.bytes.toString()).toContain('hello')
  })
})

describe('downloadBundle URL policy', () => {
  it('rejects plain http URLs', async () => {
    const files = [storeFile({ path: 'demo/SKILL.md', url: `http://${OK_HOST}/files/demo/SKILL.md`, sha256: '0'.repeat(64) })]
    await expect(downloadBundle(files, { fetchImpl: okFetch({}) })).rejects.toThrow(DownloadError)
  })

  it('rejects hosts outside the allowlist', async () => {
    const files = [storeFile({ path: 'demo/SKILL.md', url: 'https://evil.example.com/SKILL.md', sha256: '0'.repeat(64) })]
    await expect(downloadBundle(files, { fetchImpl: okFetch({}) })).rejects.toThrow(/allowlist|host/i)
  })

  it('allows an explicitly allowed CDN host', async () => {
    const body = Buffer.from('x')
    const files = [storeFile({ path: 'demo/SKILL.md', url: 'https://cdn.example.com/SKILL.md', sha256: sha256(body) })]
    const bundle = await downloadBundle(files, {
      fetchImpl: okFetch({ 'demo/SKILL.md': body }),
      allowedHosts: ['cdn.example.com'],
      urlRewrite: () => 'https://cdn.example.com/files/demo/SKILL.md'
    })
    expect(bundle.files[0]?.bytes.toString()).toBe('x')
  })
})

describe('downloadBundle path traversal protection', () => {
  it.each([
    '../escape.md',
    '..\\escape.md',
    'a/../../escape.md',
    '/etc/passwd',
    'demo/../../escape.md',
    ''
  ])('rejects malicious or empty path %j', async (path) => {
    const files = [storeFile({ path, sha256: '0'.repeat(64) })]
    await expect(downloadBundle(files, { fetchImpl: okFetch({}) })).rejects.toThrow(/path/i)
  })
})

describe('downloadBundle integrity', () => {
  it('rejects a body whose sha256 does not match the manifest', async () => {
    const body = Buffer.from('tampered')
    const files = [storeFile({ path: 'demo/SKILL.md', sha256: sha256(Buffer.from('original')) })]
    await expect(
      downloadBundle(files, { fetchImpl: okFetch({ 'demo/SKILL.md': body }) })
    ).rejects.toThrow(/checksum|sha256/i)
  })

  it('rejects non-200 responses', async () => {
    const files = [storeFile({ path: 'demo/SKILL.md', sha256: '0'.repeat(64) })]
    await expect(downloadBundle(files, { fetchImpl: okFetch({}) })).rejects.toThrow(/404/)
  })

  it('rejects an invalid sha256 field in the manifest', async () => {
    const body = Buffer.from('ok')
    const files = [storeFile({ path: 'demo/SKILL.md', sha256: 'nothex' })]
    await expect(
      downloadBundle(files, { fetchImpl: okFetch({ 'demo/SKILL.md': body }) })
    ).rejects.toThrow(/sha256/i)
  })
})

describe('downloadBundle limits', () => {
  it('enforces a per-file size cap', async () => {
    const big = Buffer.alloc(10)
    const files = [storeFile({ path: 'demo/SKILL.md', sha256: sha256(big) })]
    await expect(
      downloadBundle(files, { fetchImpl: okFetch({ 'demo/SKILL.md': big }), maxFileBytes: 4 })
    ).rejects.toThrow(/size|bytes/i)
  })
})
