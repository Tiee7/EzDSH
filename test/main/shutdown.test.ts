import { describe, expect, it } from 'vitest'
import { shutdownExternalServicesFirst } from '../../src/main/shutdown.js'

describe('shutdownExternalServicesFirst', () => {
  it('waits for external services before stopping other components', async () => {
    const events: string[] = []

    await shutdownExternalServicesFirst(
      async () => {
        events.push('external:start')
        await Promise.resolve()
        events.push('external:done')
      },
      [
        async () => { events.push('runtime') },
        async () => { events.push('api') },
      ],
    )

    expect(events).toEqual(['external:start', 'external:done', 'runtime', 'api'])
  })
})
