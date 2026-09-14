import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeLegacyPresetPersona, repairLegacyPresetPersonas } from '../../src/main/store/preset-compatibility'

const roots: string[] = []
const legacy = "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: |\n      认真研究。\n"

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-preset-compat-'))
  roots.push(root)
  return root
}

async function writePreset(home: string, id: string, content = legacy): Promise<string> {
  const path = join(home, '.agent-presets', id, 'agent.cordis.yml')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, { mode: 0o600 })
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('normalizeLegacyPresetPersona', () => {
  it('renames only the legacy persona key and preserves comments, CRLF, Unicode, and JavaScript literals', () => {
    const input = Buffer.from([
      '# 中文配置',
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  disabled: !!js process.exit(99)',
      '  config:',
      "    'text': |+ # 保留注释",
      '      Keep text: in prose.',
      '      你好，世界。',
      '',
      '- id: other',
      "  name: '@example/not-persona'",
      '  config: { text: unchanged }',
      ''
    ].join('\r\n'))
    const output = normalizeLegacyPresetPersona(input)
    expect(output.toString()).toBe(input.toString().replace("'text':", "'prefix':"))
    expect(normalizeLegacyPresetPersona(output)).toBe(output)
  })

  it('recurses through real group rows, leaving similarly shaped business data unchanged', () => {
    const input = Buffer.from(`- id: parent
  name: cordis:group
  group: true
  config:
    - id: inner
      name: cordis:group
      group: true
      config:
        - name: '@deepseek-ai/dsh-persona'
          config: { "text": "nested" }
- id: ordinary-plugin
  name: '@example/plugin'
  config:
    - name: '@deepseek-ai/dsh-persona'
      config: { text: 'business data' }
`)
    expect(normalizeLegacyPresetPersona(input).toString())
      .toBe(input.toString().replace('"text": "nested"', '"prefix": "nested"'))
  })

  it.each(['prefix: existing', 'prefix: ""', 'prefix:', 'prefix: null'])('preserves a present %s even alongside legacy text', (prefix) => {
    const input = Buffer.from(legacy.replace('    text: |', `    ${prefix}\n    text: |`))
    expect(normalizeLegacyPresetPersona(input)).toBe(input)
  })

  it.each(['null', '42', 'true', '[one, two]', '{ nested: value }'])('leaves non-string text %s untouched', (value) => {
    const input = Buffer.from(`- name: '@deepseek-ai/dsh-persona'\n  config: { text: ${value} }\n`)
    expect(normalizeLegacyPresetPersona(input)).toBe(input)
  })

  it('does not resolve aliases or rename a shared config mapping', () => {
    const input = Buffer.from(`- name: '@example/plugin'
  config: &shared { text: shared }
- name: '@deepseek-ai/dsh-persona'
  config: *shared
`)
    expect(normalizeLegacyPresetPersona(input)).toBe(input)
  })

  it('does not rename anchored or merged config fields used outside the persona', () => {
    const input = Buffer.from(`- name: '@deepseek-ai/dsh-persona'
  config: &shared { text: shared }
- name: '@example/plugin'
  config: *shared
- name: '@deepseek-ai/dsh-persona'
  config:
    <<: { prefix: inherited }
    text: legacy
`)
    expect(normalizeLegacyPresetPersona(input)).toBe(input)
  })

  it('rejects malformed YAML without attempting a partial text replacement', () => {
    expect(() => normalizeLegacyPresetPersona(Buffer.from(`${legacy}  broken: [\n`)))
      .toThrow(/preset.*YAML/i)
  })

  it('keeps a composition with no persona byte-identical', () => {
    const input = Buffer.from('- name: other\n  config: { text: unchanged }\n')
    expect(normalizeLegacyPresetPersona(input)).toBe(input)
  })

  it('matches the parsed plugin name even when YAML escapes the at-sign', () => {
    const input = Buffer.from('- name: "\\u0040deepseek-ai/dsh-persona"\n  config: { text: legacy }\n')
    expect(normalizeLegacyPresetPersona(input).toString()).toBe(input.toString().replace('text: legacy', 'prefix: legacy'))
  })
})

describe('repairLegacyPresetPersonas', () => {
  it('backs up original bytes, preserves permissions and becomes a no-op on repeat', async () => {
    const home = await tempHome()
    const path = await writePreset(home, 'research')
    const metadata = join(home, '.agent-presets', 'research', 'preset.yml')
    await writeFile(metadata, 'name: 我的研究\n')
    const result = await repairLegacyPresetPersonas(home)
    expect(result.failed).toEqual([])
    expect(result.repaired).toHaveLength(1)
    expect(result.repaired[0]).toMatchObject({ id: 'research', path })
    expect(await readFile(result.repaired[0].backupPath, 'utf8')).toBe(legacy)
    expect(await readFile(path, 'utf8')).toBe(legacy.replace('    text:', '    prefix:'))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(metadata, 'utf8')).toBe('name: 我的研究\n')
    const entries = await readdir(join(path, '..'))
    expect(await repairLegacyPresetPersonas(home)).toEqual({ repaired: [], failed: [] })
    expect(await readdir(join(path, '..'))).toEqual(entries)
  })

  it('isolates a broken file and ignores invalid preset IDs and missing compositions', async () => {
    const home = await tempHome()
    const broken = `${legacy}  broken: [\n`
    const brokenPath = await writePreset(home, 'broken', broken)
    await writePreset(home, 'good')
    const invalid = await writePreset(home, 'Invalid_Id')
    await mkdir(join(home, '.agent-presets', 'empty'))
    const result = await repairLegacyPresetPersonas(home)
    expect(result.repaired.map((item) => item.id)).toEqual(['good'])
    expect(result.failed).toEqual([{ id: 'broken', path: brokenPath, error: expect.stringMatching(/YAML/) }])
    expect(await readFile(brokenPath, 'utf8')).toBe(broken)
    expect(await readFile(invalid, 'utf8')).toBe(legacy)
    expect(await readdir(join(brokenPath, '..'))).toEqual(['agent.cordis.yml'])
  })

  it('does not follow symlinks for a preset directory or composition', async () => {
    const home = await tempHome()
    const elsewhere = await tempHome()
    const external = await writePreset(elsewhere, 'external')
    await mkdir(join(home, '.agent-presets', 'linked-file'), { recursive: true })
    await symlink(join(external, '..'), join(home, '.agent-presets', 'linked-directory'))
    await symlink(external, join(home, '.agent-presets', 'linked-file', 'agent.cordis.yml'))
    expect(await repairLegacyPresetPersonas(home)).toEqual({ repaired: [], failed: [] })
    expect(await readFile(external, 'utf8')).toBe(legacy)
    expect(await readdir(join(external, '..'))).toEqual(['agent.cordis.yml'])
  })

  it('does not follow a symlinked presets root', async () => {
    const home = await tempHome()
    const elsewhere = await tempHome()
    const external = await writePreset(elsewhere, 'external')
    await symlink(join(elsewhere, '.agent-presets'), join(home, '.agent-presets'))
    expect(await repairLegacyPresetPersonas(home)).toEqual({ repaired: [], failed: [] })
    expect(await readFile(external, 'utf8')).toBe(legacy)
  })

  it('does nothing when the user has no presets directory', async () => {
    expect(await repairLegacyPresetPersonas(await tempHome())).toEqual({ repaired: [], failed: [] })
  })
})
