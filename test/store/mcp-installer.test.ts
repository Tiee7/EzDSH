import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installMcpEntry,
  uninstallMcpEntry,
  setMcpDisabled,
  mcpRowId
} from '../../src/main/store/mcp-installer'
import { InstallRegistry } from '../../src/main/store/install-registry'
import type { InstalledRecord, StoreMcpConfig } from '../../src/shared/store'

const workdirs: string[] = []

async function tempPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ezdsh-mcp-'))
  workdirs.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all(workdirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const stdioConfig: StoreMcpConfig = {
  transport: 'stdio',
  serverName: 'feishu',
  command: 'npx',
  args: ['-y', '@feishu/mcp']
}

const httpConfig: StoreMcpConfig = {
  transport: 'streamable-http',
  serverName: 'search',
  url: 'https://api.example.com/mcp'
}

describe('mcp patch editing', () => {
  it('creates a patch file with the insert row when none exists', async () => {
    const file = await tempPath('cordis.patch.yml')
    await installMcpEntry(file, stdioConfig)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('id: mcp-feishu')
    expect(text).toContain('name:')
    expect(text).toContain('@deepseek-ai/dsh-mcp-client')
    expect(text).toContain('serverName: feishu')
  })

  it('appends to an existing patch file and preserves comments and rows', async () => {
    const file = await tempPath('cordis.patch.yml')
    await writeFile(file, [
      '# my manual layer',
      '- id: custom-row',
      '  name: ./local.mjs',
      '  config:',
      '    value: 1',
      ''
    ].join('\n'))
    await installMcpEntry(file, httpConfig)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('# my manual layer')
    expect(text).toContain('custom-row')
    expect(text).toContain('mcp-search')
  })

  it('is idempotent: reinstalling replaces the old row instead of duplicating', async () => {
    const file = await tempPath('cordis.patch.yml')
    await installMcpEntry(file, stdioConfig)
    await installMcpEntry(file, { ...stdioConfig, args: ['-y', '@feishu/mcp@2'] })
    const text = await readFile(file, 'utf8')
    expect(text.match(/mcp-feishu/g)?.length).toBe(1)
    expect(text).toContain('@feishu/mcp@2')
  })

  it('removes the managed row on uninstall and leaves other rows intact', async () => {
    const file = await tempPath('cordis.patch.yml')
    await writeFile(file, '- id: keep\n  name: ./k.mjs\n')
    await installMcpEntry(file, stdioConfig)
    await uninstallMcpEntry(file, 'feishu')
    const text = await readFile(file, 'utf8')
    expect(text).toContain('keep')
    expect(text).not.toContain('mcp-feishu')
  })

  it('toggles disabled on the managed row', async () => {
    const file = await tempPath('cordis.patch.yml')
    await installMcpEntry(file, stdioConfig)
    await setMcpDisabled(file, 'feishu', true)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('disabled: true')
    await setMcpDisabled(file, 'feishu', false)
    const textAfter = await readFile(file, 'utf8')
    expect(textAfter).not.toContain('disabled: true')
  })

  it('exposes the stable row id derivation', () => {
    expect(mcpRowId('feishu')).toBe('mcp-feishu')
  })
})

describe('install registry', () => {
  it('round-trips records through the JSON file', async () => {
    const file = await tempPath('installed.json')
    const registry = new InstallRegistry(file)
    const record: InstalledRecord = {
      kind: 'skill',
      id: 'demo',
      version: '1.0.0',
      sha256: 'ab'.repeat(32),
      installedAt: '2026-08-17T00:00:00.000Z',
      name: 'Demo'
    }
    await registry.upsert(record)
    const second = new InstallRegistry(file)
    expect(await second.list()).toEqual([record])
  })

  it('upsert replaces by kind+id and remove deletes', async () => {
    const file = await tempPath('installed.json')
    const registry = new InstallRegistry(file)
    const base: InstalledRecord = {
      kind: 'skill', id: 'demo', version: '1.0.0', sha256: '0'.repeat(32), installedAt: 't', name: 'Demo'
    }
    await registry.upsert(base)
    await registry.upsert({ ...base, version: '2.0.0' })
    expect((await registry.list()).length).toBe(1)
    expect((await registry.list())[0]?.version).toBe('2.0.0')
    expect(await registry.remove('skill', 'demo')).toBe(true)
    expect(await registry.remove('skill', 'demo')).toBe(false)
    expect(await registry.list()).toEqual([])
  })

  it('finds one record by kind and id', async () => {
    const file = await tempPath('installed.json')
    const registry = new InstallRegistry(file)
    const base: InstalledRecord = {
      kind: 'mcp', id: 'feishu', version: '1.0.0', sha256: '0'.repeat(32), installedAt: 't', name: 'Feishu'
    }
    await registry.upsert(base)
    expect((await registry.find('mcp', 'feishu'))?.id).toBe('feishu')
    expect(await registry.find('skill', 'feishu')).toBeUndefined()
  })

  it('tolerates a missing or corrupt file', async () => {
    const file = await tempPath('installed.json')
    await writeFile(file, 'not json')
    const registry = new InstallRegistry(file)
    expect(await registry.list()).toEqual([])
  })
})
