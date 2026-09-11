import { createWindow } from '@mixmark-io/domino'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

interface CapturedLoad {
  id: string
  factory: (require: (id: string) => unknown) => Record<string, unknown>
}

interface SearchFace {
  search: (sessionId: string, query: string, signal: AbortSignal) => Promise<unknown[]>
  focusHit: (sessionId: string, hit: { seq: number; nodeKey: string }, query: string) => Promise<void>
  clear: () => void
}

let captured: CapturedLoad | undefined
let registered: Array<{ opts: { name: string; id: string; order: number; locale: string; inject: () => SearchFace }; component: unknown }>
let localeBundles: Array<{ ns: string; dict: Record<string, Record<string, string>> }>
let fetchCall: ReturnType<typeof vi.fn>
let loadThrough: ReturnType<typeof vi.fn>

function makeRequire(): (id: string) => unknown {
  return (id: string) => {
    if (id === 'react') {
      return {
        useCallback: (value: unknown) => value,
        useEffect: () => {},
        useRef: (value: unknown) => ({ current: value }),
        useState: (value: unknown) => [value, () => {}],
      }
    }
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        IconSearchOutline16: () => null,
        IconChevronDownOutline14: () => null,
        IconChevronUpOutline14: () => null,
        IconCloseOutline16: () => null,
      }
    }
    throw new Error(`unexpected require: ${id}`)
  }
}

function makeCtx() {
  const sessions = {
    binding: (id: string) => id === 's1' ? { session: { loadThrough } } : undefined,
  }
  const locale = {
    register: (ns: string, dict: Record<string, Record<string, string>>) => {
      localeBundles.push({ ns, dict })
      return () => {}
    },
  }
  const slots = {
    inject: (_name: string, mount: () => unknown) => mount(),
    register: (opts: typeof registered[number]['opts'], component: unknown) => {
      registered.push({ opts, component })
      return () => {}
    },
  }
  const scope = { locale, sessions, slots }
  return {
    get: (name: string) => scope[name as keyof typeof scope],
    effect: (mount: () => unknown) => mount(),
    inject: (_names: string[], mount: (value: typeof scope) => unknown) => mount(scope),
  }
}

beforeAll(() => {
  const originalWindow = globalThis.window
  ;(globalThis as { window?: unknown }).window = {
    __ModuleLoader__: {
      load: (definition: CapturedLoad) => { captured = definition },
    },
  }
  return () => {
    ;(globalThis as { window?: unknown }).window = originalWindow
  }
})

beforeEach(() => {
  const window = createWindow('<!doctype html><html><head></head><body></body></html>')
  ;(globalThis as { document?: unknown }).document = window.document
  ;(globalThis as { NodeFilter?: unknown }).NodeFilter = window.NodeFilter
  ;(globalThis as { Event?: unknown }).Event = window.Event
  ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (callback: () => void) => {
    callback()
    return 1
  }
  ;(globalThis as { CSS?: unknown }).CSS = { escape: (value: string) => value }
  registered = []
  localeBundles = []
  fetchCall = vi.fn(async () => new Response(JSON.stringify({
    ok: true,
    value: { items: [{ seq: 2, nodeKey: '13:input-messagem2' }] },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  ;(globalThis as { fetch?: unknown }).fetch = fetchCall
  loadThrough = vi.fn(async () => {})
})

async function boot(): Promise<Record<string, unknown>> {
  const path = fileURLToPath(new URL('../../../plugins/chat-search/src/client.js', import.meta.url))
  await import(path)
  if (captured === undefined) throw new Error('client module did not register')
  const exports = captured.factory(makeRequire())
  ;(exports.apply as (ctx: unknown) => void)(makeCtx())
  return exports
}

describe('@ezdsh/chat-search browser half', () => {
  it('registers a localized action in the Session header', async () => {
    const exports = await boot()
    expect(captured?.id).toBe('@ezdsh/chat-search')
    expect(exports.inject).toEqual(['slots', 'locale', 'sessions'])
    expect(registered).toHaveLength(1)
    expect(registered[0]?.opts).toMatchObject({
      name: 'conversation.session.header.actions',
      id: 'ezdsh-chat-search',
      order: 40,
      locale: 'ezdshChatSearch',
    })
    expect(localeBundles[0]?.dict.zh?.open).toBe('搜索当前会话')
    expect(document.getElementById('ezdsh-chat-search/styles')).not.toBeNull()
  })

  it('calls the authenticated search channel and returns its items', async () => {
    await boot()
    const face = registered[0]!.opts.inject()
    const signal = new AbortController().signal
    await expect(face.search('s1', 'needle', signal)).resolves.toEqual([
      { seq: 2, nodeKey: '13:input-messagem2' },
    ])
    expect(fetchCall).toHaveBeenCalledWith('/api/ezdsh.chat-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', query: 'needle' }),
      signal,
    })
  })

  it('loads older history before scrolling to and marking the exact Chat node', async () => {
    await boot()
    const row = document.createElement('div')
    row.setAttribute('data-chat-anchor-key', '9:tool-callcall-7')
    const scrollIntoView = vi.fn()
    ;(row as unknown as { scrollIntoView: typeof scrollIntoView }).scrollIntoView = scrollIntoView
    document.body.appendChild(row)

    const face = registered[0]!.opts.inject()
    await face.focusHit('s1', { seq: 8, nodeKey: '9:tool-callcall-7' }, 'needle')

    expect(loadThrough).toHaveBeenCalledWith(8)
    expect(row.classList.contains('ezdsh-chat-search-target')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
  })

  it('escapes Chat node keys for an exact DOM selector', async () => {
    const exports = await boot()
    const selector = exports.selectorForNodeKey as (key: string) => string
    expect(selector('9:tool-callid')).toBe('[data-chat-anchor-key="9:tool-callid"]')
  })
})
