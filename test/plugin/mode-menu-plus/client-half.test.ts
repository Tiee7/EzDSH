import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

interface CapturedLoad {
  id: string
  factory: (require: (id: string) => unknown) => Record<string, unknown>
}

interface Face {
  hooks: { agentPresetSeat: { getSnapshot: () => Record<string, unknown>; set: (next: Record<string, unknown>) => void } }
  load: () => Promise<void>
  select: (id: string) => Promise<void>
  introduced: () => void
}

let captured: CapturedLoad | undefined
let registered: Array<{ opts: { name: string; priority?: number; locale?: string; inject: () => Face }; component: unknown }> = []
let localeBundles: Array<{ ns: string; dict: Record<string, string> }> = []
let selectCalls: Array<{ sessionId: string; agentPreset: string }> = []
let noteCalls: Array<[string, string]> = []
let api: {
  agentPresets: {
    list: () => Promise<unknown>
    select: (args: { sessionId: string; agentPreset: string }) => Promise<unknown>
  }
}
let sessions: {
  list: { getSnapshot: () => { current?: string; byId: Record<string, { id: string; blank?: boolean; agentPreset?: string }> }; subscribe: () => () => void }
  noteAgentPreset: (sessionId: string, agentPreset: string) => void
}

function makeRequire(): (id: string) => unknown {
  return (id: string) => {
    if (id === 'react') return { useState: () => [false, () => {}], useEffect: () => {} }
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'div' }
    if (id === '@deepseek-ai/dsh-client-runtime/client') {
      return {
        createSnapshotStore: (initial: Record<string, unknown>) => {
          let snapshot = initial
          return {
            getSnapshot: () => snapshot,
            set: (next: Record<string, unknown>) => {
              snapshot = next
            },
            subscribe: () => () => {},
          }
        },
      }
    }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Menu: () => null, IconAgentPresetOutline16: () => null, IconChevronDownOutline14: () => null }
    }
    throw new Error('unexpected require: ' + id)
  }
}

function makeCtx() {
  const context = {
    get: (name: string) => {
      if (name === 'connection') return { api }
      if (name === 'locale') return { register: (ns: string, dict: Record<string, string>) => localeBundles.push({ ns, dict }) }
      if (name === 'sessions') return sessions
      throw new Error('unexpected service: ' + name)
    },
    effect: (fn: () => unknown) => fn(),
    inject: (names: string[], cb: (scope: Record<string, unknown>) => unknown) => {
      const scope: Record<string, unknown> = {
        get: context.get,
        sessions,
        remote: { $on: () => () => {} },
        slots: {
          register: (opts: { name: string; priority?: number; locale?: string; inject: () => Face }, component: unknown) => {
            registered.push({ opts, component })
            return () => {}
          },
        },
        effect: context.effect,
      }
      return cb(scope)
    },
  }
  return context
}

beforeAll(() => {
  const originalWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    __ModuleLoader__: {
      load: (def: CapturedLoad) => {
        captured = def
      },
    },
  }
  return async () => {
    ;(globalThis as { window?: unknown }).window = originalWindow
  }
})

beforeEach(() => {
  registered = []
  localeBundles = []
  selectCalls = []
  noteCalls = []
  api = {
    agentPresets: {
      list: async () => ({
        result: {
          ok: true,
          value: {
            presets: [
              { id: 'standard', trust: 'system', isDefault: true },
              { id: 'custom', trust: 'user', name: 'My agent', description: 'mine', isDefault: false },
              { id: 'broken', trust: 'user', isDefault: false, broken: 'nope' },
            ],
          },
        },
      }),
      select: async (args: { sessionId: string; agentPreset: string }) => {
        selectCalls.push(args)
        return { result: { ok: true, value: { agentPreset: args.agentPreset } } }
      },
    },
  }
  sessions = {
    list: {
      getSnapshot: () => ({ current: undefined, byId: {} }),
      subscribe: () => () => {},
    },
    noteAgentPreset: (sessionId: string, agentPreset: string) => {
      noteCalls.push([sessionId, agentPreset])
    },
  }
})

describe('mode-menu-plus browser half', () => {
  let exports_: Record<string, unknown>

  async function boot() {
    const path = fileURLToPath(new URL('../../../plugins/mode-menu-plus/src/client.js', import.meta.url))
    await import(path)
    expect(captured).toBeDefined()
    exports_ = captured!.factory(makeRequire()) as Record<string, unknown>
    ;(exports_.apply as (ctx: unknown) => void)(makeCtx())
  }

  it('registers with the module loader and exports apply', async () => {
    await boot()
    expect(captured!.id).toBe('mode-menu-plus')
    expect(typeof exports_.apply).toBe('function')
  })

  it('shadows the hero slot at priority -1 with its own locale', async () => {
    await boot()
    expect(registered).toHaveLength(1)
    expect(registered[0].opts.name).toBe('conversation.hero.agentPreset')
    expect(registered[0].opts.priority).toBe(-1)
    expect(registered[0].opts.locale).toBe('modeMenuPlus')
    const ns = localeBundles.find((bundle) => bundle.ns === 'modeMenuPlus')
    expect(ns?.dict.zh.seeMore).toBe('查看更多插件')
    expect(ns?.dict.en.seeMore).toBe('See more plugins')
  })

  it('loads the roster through the injected seat face, filtering broken presets', async () => {
    await boot()
    const face = registered[0].opts.inject()
    await face.load()
    const state = face.hooks.agentPresetSeat.getSnapshot() as {
      options: Array<{ id: string }>
      current: string
      error: string | null
    }
    expect(state.options.map((option) => option.id)).toEqual(['standard', 'custom'])
    expect(state.current).toBe('standard')
    expect(state.error).toBeNull()
  })

  it('stages and applies a pick to a blank current session, publishing via noteAgentPreset', async () => {
    sessions.list.getSnapshot = () => ({ current: 's1', byId: { s1: { id: 's1', blank: true } } })
    await boot()
    const face = registered[0].opts.inject()
    await face.select('custom')
    expect(selectCalls).toEqual([{ sessionId: 's1', agentPreset: 'custom' }])
    expect(noteCalls).toEqual([['s1', 'custom']])
    const state = face.hooks.agentPresetSeat.getSnapshot() as { current: string; busy: boolean }
    expect(state.current).toBe('custom')
    expect(state.busy).toBe(false)
  })

  it('localizes built-in presets and falls back to file metadata for user presets', async () => {
    await boot()
    const presetDisplayText = exports_.presetDisplayText as (
      preset: { trust: string; id: string; name?: string; description?: string },
      t: (key: string) => string,
    ) => { name: string; description?: string }
    const t = (key: string) => (key === 'presetStandardName' ? 'Standard mode' : key)
    expect(presetDisplayText({ trust: 'system', id: 'standard' }, t).name).toBe('Standard mode')
    expect(presetDisplayText({ trust: 'user', id: 'custom', name: 'My agent', description: 'mine' }, t)).toEqual({
      name: 'My agent',
      description: 'mine',
    })
    expect(presetDisplayText({ trust: 'user', id: 'bare' }, t).name).toBe('bare')
  })

  it('filters broken presets out of the options list', async () => {
    await boot()
    const presetOptions = exports_.presetOptions as (presets: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
    const options = presetOptions([
      { id: 'a', trust: 'system' },
      { id: 'b', trust: 'user', broken: 'x' },
      { id: 'c', trust: 'user', name: 'C', description: 'desc' },
    ])
    expect(options.map((option) => option.id)).toEqual(['a', 'c'])
    expect(options[1]).toEqual({ id: 'c', trust: 'user', name: 'C', description: 'desc' })
  })

  it('ignores select while busy', async () => {
    await boot()
    const face = registered[0].opts.inject()
    face.hooks.agentPresetSeat.set({ ...face.hooks.agentPresetSeat.getSnapshot(), busy: true })
    await face.select('custom')
    expect(selectCalls).toEqual([])
  })

  it('sets error and preserves options/current when load returns ok: false', async () => {
    api.agentPresets.list = async () => ({ result: { ok: false, error: { message: 'boom' } } })
    await boot()
    const face = registered[0].opts.inject()
    await face.load()
    const state = face.hooks.agentPresetSeat.getSnapshot() as { options: unknown[]; current: string; error: string | null }
    expect(state.options).toEqual([])
    expect(state.current).toBe('')
    expect(state.error).toBe('boom')
  })

  it('sets error when load throws', async () => {
    api.agentPresets.list = async () => { throw new Error('network') }
    await boot()
    const face = registered[0].opts.inject()
    await face.load()
    const state = face.hooks.agentPresetSeat.getSnapshot() as { error: string | null }
    expect(state.error).toBe('network')
  })

  it('reverts to fallback and sets error when select returns ok: false', async () => {
    sessions.list.getSnapshot = () => ({ current: 's1', byId: { s1: { id: 's1', blank: true } } })
    api.agentPresets.select = async () => ({ result: { ok: false, error: { message: 'select-fail' } } })
    await boot()
    const face = registered[0].opts.inject()
    await face.load()
    await face.select('custom')
    const state = face.hooks.agentPresetSeat.getSnapshot() as { current: string; error: string | null; busy: boolean }
    expect(state.current).toBe('standard')
    expect(state.error).toBe('select-fail')
    expect(state.busy).toBe(false)
  })

  it('reverts to fallback and sets error when select throws', async () => {
    sessions.list.getSnapshot = () => ({ current: 's1', byId: { s1: { id: 's1', blank: true } } })
    api.agentPresets.select = async () => { throw new Error('select-throw') }
    await boot()
    const face = registered[0].opts.inject()
    await face.load()
    await face.select('custom')
    const state = face.hooks.agentPresetSeat.getSnapshot() as { current: string; error: string | null; busy: boolean }
    expect(state.current).toBe('standard')
    expect(state.error).toBe('select-throw')
    expect(state.busy).toBe(false)
  })
})
