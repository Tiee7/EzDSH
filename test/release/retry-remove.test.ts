import { describe, expect, it } from 'vitest'
import { removeWithRetry } from '../../scripts/retry-remove.mjs'

describe('temporary directory cleanup', () => {
  it('retries Windows resource-lock failures before succeeding', async () => {
    let attempts = 0

    await removeWithRetry('temporary-root', {
      retryDelayMs: 0,
      remove: async () => {
        attempts += 1
        if (attempts < 3) {
          const error = new Error('resource busy') as NodeJS.ErrnoException
          error.code = 'EBUSY'
          throw error
        }
      }
    })

    expect(attempts).toBe(3)
  })

  it('does not hide non-retryable cleanup failures', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })

    await expect(removeWithRetry('temporary-root', {
      retryDelayMs: 0,
      remove: async () => { throw error }
    })).rejects.toBe(error)
  })
})
