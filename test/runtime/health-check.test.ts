import { describe, expect, it, vi } from 'vitest'
import { RUNTIME_TIMEOUT, RuntimeHealthError, waitForRuntimeHealthy } from '../../src/main/runtime/health-check'

describe('waitForRuntimeHealthy', () => {
  it('accepts a successful response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }))
    await expect(waitForRuntimeHealthy('http://127.0.0.1:1', { fetchImpl })).resolves.toBeUndefined()
  })

  it('keeps polling after connection failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    await waitForRuntimeHealthy('http://127.0.0.1:1', { fetchImpl, timeoutMs: 100, intervalMs: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('returns a typed timeout error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection refused'))
    const error = await waitForRuntimeHealthy('http://127.0.0.1:1', {
      fetchImpl,
      timeoutMs: 5,
      intervalMs: 1
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(RuntimeHealthError)
    expect(error).toMatchObject({ code: RUNTIME_TIMEOUT })
  })
})
