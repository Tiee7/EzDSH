import { describe, expect, it, vi } from 'vitest'
import { InstallErrorReporter } from '../../src/main/store/install-reporter'

describe('InstallErrorReporter', () => {
  it('posts a structured install report to the Hub endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const reporter = new InstallErrorReporter({ baseUrl: 'https://hub.example.test', fetchImpl })

    await reporter.report({
      kind: 'skill',
      entryId: 'agent-coder',
      errorCode: 'download_failed',
      errorMessage: 'Download failed: 504 demo/SKILL.md',
      detail: { stage: 'download', httpStatus: 504 }
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [input, init] = fetchImpl.mock.calls[0] ?? []
    expect(String(input)).toBe('https://hub.example.test/v1/install-report')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(init?.body))).toMatchObject({
      kind: 'skill',
      entryId: 'agent-coder',
      errorCode: 'download_failed',
      clientVersion: expect.any(String),
      detail: { stage: 'download', httpStatus: 504 }
    })
  })

  it('deduplicates the same report during the short reporting window', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const reporter = new InstallErrorReporter({ baseUrl: 'https://hub.example.test', fetchImpl })
    const report = { kind: 'skill' as const, entryId: 'demo', errorCode: 'audit_blocked' }

    await reporter.report(report)
    await reporter.report(report)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('swallows network and server errors from the reporting endpoint', async () => {
    const reporter = new InstallErrorReporter({
      baseUrl: 'https://hub.example.test',
      fetchImpl: async () => { throw new Error('offline') }
    })

    await expect(reporter.report({ kind: 'mcp', entryId: 'demo', errorCode: 'write_failed' })).resolves.toBeUndefined()
  })

  it('removes sensitive fields and absolute local paths from report content', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const reporter = new InstallErrorReporter({ baseUrl: 'https://hub.example.test', fetchImpl })

    await reporter.report({
      kind: 'skill',
      entryId: 'demo',
      errorCode: 'write_failed',
      errorMessage: 'write failed at /tmp/ezdsh/private/file and C:/Users/snake/private/file',
      detail: { path: '/tmp/ezdsh/private/file', windowsPath: 'C:/Users/snake/private/file', token: 'do-not-send' }
    })

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { errorMessage: string; detail: Record<string, unknown> }
    expect(body.errorMessage).not.toContain('/tmp/ezdsh')
    expect(body.errorMessage).not.toContain('C:/Users/snake')
    expect(body.detail.path).toBe('[path]')
    expect(body.detail.windowsPath).toBe('[path]')
    expect(body.detail.token).toBeUndefined()
  })
})
