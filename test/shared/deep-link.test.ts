import { describe, expect, it } from 'vitest'
import { findDeepLinkInArgs, parseDeepLink } from '../../src/shared/deep-link'

describe('parseDeepLink', () => {
  it('parses exact kind install links', () => {
    expect(parseDeepLink('ezdsh://install/skill/demo')).toEqual({ action: 'install', kind: 'skill', id: 'demo' })
    expect(parseDeepLink('ezdsh://install/mcp/weather')).toEqual({ action: 'install', kind: 'mcp', id: 'weather' })
  })

  it('rejects kinds that are not store-installable', () => {
    expect(parseDeepLink('ezdsh://install/channel-adapter/wecom')).toBeUndefined()
  })

  it('parses plugin shorthand links without a kind', () => {
    expect(parseDeepLink('ezdsh://install/plugin/my-plugin')).toEqual({ action: 'install', kind: undefined, id: 'my-plugin' })
  })

  it('rejects non-ezdsh protocols', () => {
    expect(parseDeepLink('https://ezdsh.com/install/plugin/x')).toBeUndefined()
  })

  it('rejects malformed install paths', () => {
    expect(parseDeepLink('ezdsh://install/')).toBeUndefined()
    expect(parseDeepLink('ezdsh://install/skill')).toBeUndefined()
    expect(parseDeepLink('ezdsh://install/unknown/demo')).toBeUndefined()
    expect(parseDeepLink('ezdsh://install/plugin/')).toBeUndefined()
    expect(parseDeepLink('ezdsh://settings/locale')).toBeUndefined()
  })
})

describe('findDeepLinkInArgs', () => {
  it('returns the last matching argument', () => {
    expect(findDeepLinkInArgs(['--foo', 'ezdsh://install/skill/a', 'ezdsh://install/mcp/b'])).toBe('ezdsh://install/mcp/b')
  })

  it('returns undefined when no link is present', () => {
    expect(findDeepLinkInArgs(['--foo', 'bar'])).toBeUndefined()
  })
})
