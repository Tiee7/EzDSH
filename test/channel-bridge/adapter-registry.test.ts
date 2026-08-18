import { describe, expect, it, vi } from 'vitest'
import { AdapterRegistry } from '../../src/main/channel-bridge/adapter-registry.js'
import type { ChannelAdapter, ChannelAdapterCreateOptions, ChannelAdapterFactory } from '../../src/main/channel-bridge/types.js'

function createMockFactory(name: string): ChannelAdapterFactory {
  return {
    name,
    create(): ChannelAdapter {
      return {
        name,
        start: vi.fn(),
        stop: vi.fn(),
        send: vi.fn(),
        updateAllowList: vi.fn(),
      }
    },
  }
}

describe('AdapterRegistry', () => {
  it('creates an adapter by name', () => {
    const registry = new AdapterRegistry()
    registry.register(createMockFactory('mock'))

    const adapter = registry.create('mock', {
      config: { token: 'abc' },
      allowList: [],
      logger: console,
    })

    expect(adapter.name).toBe('mock')
  })

  it('throws when creating an unknown adapter', () => {
    const registry = new AdapterRegistry()
    expect(() =>
      registry.create('unknown', {
        config: {},
        allowList: [],
        logger: console,
      } as ChannelAdapterCreateOptions),
    ).toThrow('Unknown adapter "unknown"')
  })

  it('throws when registering a duplicate adapter name', () => {
    const registry = new AdapterRegistry()
    registry.register(createMockFactory('mock'))
    expect(() => registry.register(createMockFactory('mock'))).toThrow('Adapter "mock" is already registered')
  })

  it('lists registered adapter names', () => {
    const registry = new AdapterRegistry()
    registry.register(createMockFactory('a'))
    registry.register(createMockFactory('b'))
    expect(registry.list()).toEqual(['a', 'b'])
    expect(registry.has('a')).toBe(true)
    expect(registry.has('c')).toBe(false)
  })
})
