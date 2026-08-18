import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NavigationService } from '../../src/main/navigation/navigation-service'
import { getDefaultNavConfig, type NavConfig } from '../../src/shared/navigation'

describe('navigation service', () => {
  it('defaults when the config file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-nav-'))
    const service = new NavigationService(dir)
    await service.initialize()
    expect(service.getConfig()).toEqual(getDefaultNavConfig())
  })

  it('round-trips a persisted config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-nav-'))
    const service = new NavigationService(dir)
    await service.initialize()
    const custom: NavConfig = {
      items: [
        ...getDefaultNavConfig().items,
        { kind: 'custom', id: 'c1', label: 'Web', url: 'https://example.com' }
      ]
    }
    await service.setConfig(custom)
    const reloaded = new NavigationService(dir)
    await reloaded.initialize()
    expect(reloaded.getConfig()).toEqual(custom)
  })

  it('rejects an invalid config without persisting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-nav-'))
    const service = new NavigationService(dir)
    await service.initialize()
    const bad: NavConfig = { items: [{ kind: 'custom', id: 'c1', label: 'X', url: 'ftp://x.com' }] }
    await expect(service.setConfig(bad)).rejects.toThrow(/http\(s\)/)
    expect(service.getConfig()).toEqual(getDefaultNavConfig())
  })

  it('normalizes legacy files missing built-in entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-nav-'))
    await writeFile(join(dir, 'navigation.json'), JSON.stringify({ items: [{ kind: 'builtin', id: 'store', visible: false }] }))
    const service = new NavigationService(dir)
    await service.initialize()
    expect(service.getConfig().items.map((i) => i.id)).toEqual(['store', 'harness', 'presets', 'docs', 'settings'])
  })
})
