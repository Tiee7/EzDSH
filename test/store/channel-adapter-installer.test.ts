import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installChannelAdapterBundle,
  uninstallChannelAdapter,
  ChannelAdapterConflictError
} from '../../src/main/store/channel-adapter-installer.js'
import type { StoreEntry } from '../../src/shared/store.js'

describe('channel adapter installer', () => {
  it('installs a channel adapter bundle into the channel-adapters directory', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'ezdsh-ca-'))
    const entry: StoreEntry = {
      id: 'channel-mock',
      kind: 'channel-adapter',
      name: 'Mock Adapter',
      description: 'A test adapter',
      category: 'im',
      auditLevel: 'verified',
      version: '1.0.0',
      files: [
        { path: 'channel-mock/package.json', url: 'https://example.com/package.json', sha256: 'a'.repeat(64), kind: 'text' },
        { path: 'channel-mock/index.js', url: 'https://example.com/index.js', sha256: 'b'.repeat(64), kind: 'script' }
      ]
    }
    const bundle = {
      files: [
        { path: 'channel-mock/package.json', bytes: Buffer.from('{"name":"mock"}') },
        { path: 'channel-mock/index.js', bytes: Buffer.from('export const mockFactory = {}') }
      ]
    }

    await installChannelAdapterBundle(dshHome, entry, bundle)

    const packageJson = await readFile(join(dshHome, 'channel-adapters', 'channel-mock', 'package.json'), 'utf8')
    expect(packageJson).toBe('{"name":"mock"}')
    const indexJs = await readFile(join(dshHome, 'channel-adapters', 'channel-mock', 'index.js'), 'utf8')
    expect(indexJs).toBe('export const mockFactory = {}')

    const info = await stat(join(dshHome, 'channel-adapters', 'channel-mock', 'package.json'))
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('refuses to install over an existing adapter', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'ezdsh-ca-'))
    const entry: StoreEntry = {
      id: 'channel-mock',
      kind: 'channel-adapter',
      name: 'Mock Adapter',
      description: 'A test adapter',
      category: 'im',
      auditLevel: 'verified',
      version: '1.0.0',
      files: []
    }

    await installChannelAdapterBundle(dshHome, entry, {
      files: [{ path: 'channel-mock/package.json', bytes: Buffer.from('{}') }]
    })

    await expect(
      installChannelAdapterBundle(dshHome, entry, {
        files: [{ path: 'channel-mock/package.json', bytes: Buffer.from('{}') }]
      })
    ).rejects.toBeInstanceOf(ChannelAdapterConflictError)
  })

  it('uninstalls a channel adapter', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'ezdsh-ca-'))
    const entry: StoreEntry = {
      id: 'channel-mock',
      kind: 'channel-adapter',
      name: 'Mock Adapter',
      description: 'A test adapter',
      category: 'im',
      auditLevel: 'verified',
      version: '1.0.0',
      files: []
    }

    await installChannelAdapterBundle(dshHome, entry, {
      files: [{ path: 'channel-mock/package.json', bytes: Buffer.from('{}') }]
    })

    const removed = await uninstallChannelAdapter(dshHome, 'channel-mock')
    expect(removed).toBe(true)

    await expect(stat(join(dshHome, 'channel-adapters', 'channel-mock'))).rejects.toThrow()

    const removedAgain = await uninstallChannelAdapter(dshHome, 'channel-mock')
    expect(removedAgain).toBe(false)
  })

  it('rejects files outside the adapter directory', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'ezdsh-ca-'))
    const entry: StoreEntry = {
      id: 'channel-mock',
      kind: 'channel-adapter',
      name: 'Mock Adapter',
      description: 'A test adapter',
      category: 'im',
      auditLevel: 'verified',
      version: '1.0.0',
      files: []
    }

    await expect(
      installChannelAdapterBundle(dshHome, entry, {
        files: [{ path: 'other-file.txt', bytes: Buffer.from('') }]
      })
    ).rejects.toThrow('outside')
  })
})
