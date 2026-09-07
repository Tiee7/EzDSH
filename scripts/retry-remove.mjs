import { rm } from 'node:fs/promises'

const RETRYABLE_CLEANUP_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'])

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function removeWithRetry(target, {
  maxAttempts = 10,
  retryDelayMs = 250,
  remove = rm,
  sleep = wait
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await remove(target, { recursive: true, force: true })
      return
    } catch (error) {
      const code = error?.code
      if (!RETRYABLE_CLEANUP_CODES.has(code) || attempt === maxAttempts) throw error
      await sleep(retryDelayMs * attempt)
    }
  }
}
