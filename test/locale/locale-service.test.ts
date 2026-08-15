import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { LocaleService, readDshLocale } from '../../src/main/locale/locale-service'

describe('DSH locale configuration', () => {
  it('reads locale.preference from the shared settings file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-locale-'))
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, 'locale:\n  preference: en\n', 'utf8')

    await expect(readDshLocale(settingsPath)).resolves.toBe('en')
  })

  it('falls back to Chinese when the preference is absent or invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-locale-'))
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, 'permission:\n  defaultPreset: read-only\n', 'utf8')
    await expect(readDshLocale(settingsPath)).resolves.toBe('zh')

    await writeFile(settingsPath, 'locale:\n  preference: fr\n', 'utf8')
    await expect(readDshLocale(settingsPath)).resolves.toBe('zh')
  })

  it('updates when DSH settings changes while the app is running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-locale-'))
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, 'locale:\n  preference: zh\n', 'utf8')
    const service = new LocaleService(settingsPath)
    const changes: string[] = []
    service.onChange((locale) => changes.push(locale))
    await service.start()

    await writeFile(settingsPath, 'locale:\n  preference: en\n', 'utf8')
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (service.snapshot() === 'en') {
          clearInterval(timer)
          resolve()
        }
      }, 10)
    })

    expect(changes).toEqual(['en'])
    service.stop()
  })
})
