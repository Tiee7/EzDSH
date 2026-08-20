import { describe, expect, it } from 'vitest'
import { parseDeepLink } from '../../src/shared/deep-link'

describe('session deep links', () => {
  it('parses an opaque encoded session id', () => {
    expect(parseDeepLink('ezdsh://session/session%2Fabc-123')).toEqual({
      action: 'session',
      sessionId: 'session/abc-123'
    })
  })

  it('rejects empty, extra, or command-bearing session links', () => {
    expect(parseDeepLink('ezdsh://session/')).toBeUndefined()
    expect(parseDeepLink('ezdsh://session/a/b')).toBeUndefined()
    expect(parseDeepLink('ezdsh://session/a?prompt=run')).toBeUndefined()
    expect(parseDeepLink('ezdsh://session/%00')).toBeUndefined()
  })
})
