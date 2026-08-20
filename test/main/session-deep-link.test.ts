import { describe, expect, it } from 'vitest'
import { openDeepLinkedSession } from '../../src/main/session-deep-link.js'

describe('session deep-link opening', () => {
  it('unarchives before handing the session to the Harness view', async () => {
    const events: string[] = []

    await openDeepLinkedSession({
      sessionId: 'session-1',
      unarchiveSession: async (sessionId) => {
        events.push(`unarchive:${sessionId}`)
      },
      emitSession: (sessionId) => {
        events.push(`open:${sessionId}`)
      },
    })

    expect(events).toEqual(['unarchive:session-1', 'open:session-1'])
  })

  it('still opens when unarchiving is unavailable and reports the failure', async () => {
    const events: string[] = []
    const error = new Error('unsupported RPC')

    await openDeepLinkedSession({
      sessionId: 'session-1',
      unarchiveSession: async () => { throw error },
      emitSession: (sessionId) => {
        events.push(`open:${sessionId}`)
      },
      onUnarchiveError: (reason) => {
        events.push(`error:${reason.message}`)
      },
    })

    expect(events).toEqual(['error:unsupported RPC', 'open:session-1'])
  })
})
