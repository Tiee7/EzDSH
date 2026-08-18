import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdapterRegistry } from '../../src/main/channel-bridge/adapter-registry.js'
import { ChannelAdapterLoader } from '../../src/main/channel-bridge/adapter-loader.js'
import type { ChannelAdapter, ChannelAdapterCreateOptions, ChannelAdapterFactory } from '../../src/main/channel-bridge/types.js'

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ezdsh-loader-'))
}

function createMockFactory(name: string): ChannelAdapterFactory {
  return {
    name,
    create(): ChannelAdapter {
      return {
        name,
        onMessage: () => Promise.resolve(undefined),
        start: async () => {},
        stop: async () => {},
        send: async () => {},
        updateAllowList: () => {},
      }
    },
  }
}

describe('ChannelAdapterLoader', () => {
  let registry: AdapterRegistry
  let logger: { info: typeof console.info; warn: typeof console.warn }

  beforeEach(() => {
    registry = new AdapterRegistry()
    logger = { info: () => {}, warn: () => {} }
  })

  afterEach(() => {
    // cleanup handled per-test
  })

  it('loads an adapter package with a default factory export', async () => {
    const dir = await createTempDir()
    const pkgDir = join(dir, 'channel-mock')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@ezdsh/channel-mock',
        version: '0.1.0',
        ezdsh: { channelAdapter: { name: 'mock', entry: './index.js' } },
      }),
    )
    await writeFile(
      join(pkgDir, 'index.js'),
      `export default { name: 'mock', create: () => ({ name: 'mock', onMessage: () => Promise.resolve(undefined), start: async () => {}, stop: async () => {}, send: async () => {}, updateAllowList: () => {} }) };`,
    )

    const loader = new ChannelAdapterLoader({ registry, logger })
    const loaded = await loader.loadFromDirectory(dir)

    expect(loaded).toHaveLength(1)
    expect(registry.has('mock')).toBe(true)
    expect(registry.create('mock', { config: {}, allowList: [], logger: console }).name).toBe('mock')

    await rm(dir, { recursive: true, force: true })
  })

  it('loads an adapter package with a named factory export', async () => {
    const dir = await createTempDir()
    const pkgDir = join(dir, 'channel-mock')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@ezdsh/channel-mock',
        version: '0.1.0',
        ezdsh: { channelAdapter: { name: 'mock', entry: './index.js' } },
      }),
    )
    await writeFile(
      join(pkgDir, 'index.js'),
      `export const mockFactory = { name: 'mock', create: () => ({ name: 'mock', onMessage: () => Promise.resolve(undefined), start: async () => {}, stop: async () => {}, send: async () => {}, updateAllowList: () => {} }) };`,
    )

    const loader = new ChannelAdapterLoader({ registry, logger })
    await loader.loadFromDirectory(dir)

    expect(registry.has('mock')).toBe(true)

    await rm(dir, { recursive: true, force: true })
  })

  it('skips directories without package.json', async () => {
    const dir = await createTempDir()
    const pkgDir = join(dir, 'not-a-package')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'index.js'), 'export default {}')

    const loader = new ChannelAdapterLoader({ registry, logger })
    const loaded = await loader.loadFromDirectory(dir)

    expect(loaded).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)

    await rm(dir, { recursive: true, force: true })
  })

  it('skips packages without ezdsh.channelAdapter manifest', async () => {
    const dir = await createTempDir()
    const pkgDir = join(dir, 'regular-package')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'regular' }))

    const loader = new ChannelAdapterLoader({ registry, logger })
    const loaded = await loader.loadFromDirectory(dir)

    expect(loaded).toHaveLength(0)

    await rm(dir, { recursive: true, force: true })
  })

  it('skips packages with factory name mismatch', async () => {
    const dir = await createTempDir()
    const pkgDir = join(dir, 'channel-wrong')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@ezdsh/channel-wrong',
        ezdsh: { channelAdapter: { name: 'expected', entry: './index.js' } },
      }),
    )
    await writeFile(
      join(pkgDir, 'index.js'),
      `export default { name: 'actual', create: () => ({ name: 'actual', onMessage: () => Promise.resolve(undefined), start: async () => {}, stop: async () => {}, send: async () => {}, updateAllowList: () => {} }) };`,
    )

    const loader = new ChannelAdapterLoader({ registry, logger })
    const loaded = await loader.loadFromDirectory(dir)

    expect(loaded).toHaveLength(0)
    expect(registry.has('expected')).toBe(false)
    expect(registry.has('actual')).toBe(false)

    await rm(dir, { recursive: true, force: true })
  })

  it('loads from multiple directories', async () => {
    const dir1 = await createTempDir()
    const dir2 = await createTempDir()

    for (const [dir, name] of [
      [dir1, 'alpha'],
      [dir2, 'beta'],
    ] as const) {
      const pkgDir = join(dir, `channel-${name}`)
      await mkdir(pkgDir, { recursive: true })
      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: `@ezdsh/channel-${name}`,
          ezdsh: { channelAdapter: { name, entry: './index.js' } },
        }),
      )
      await writeFile(
        join(pkgDir, 'index.js'),
        `export default { name: '${name}', create: () => ({ name: '${name}', onMessage: () => Promise.resolve(undefined), start: async () => {}, stop: async () => {}, send: async () => {}, updateAllowList: () => {} }) };`,
      )
    }

    const loader = new ChannelAdapterLoader({ registry, logger })
    const loaded = await loader.loadFromDirectories([dir1, dir2])

    expect(loaded).toHaveLength(2)
    expect(registry.has('alpha')).toBe(true)
    expect(registry.has('beta')).toBe(true)

    await rm(dir1, { recursive: true, force: true })
    await rm(dir2, { recursive: true, force: true })
  })
})
