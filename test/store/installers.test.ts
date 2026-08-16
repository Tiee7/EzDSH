import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installSkillBundle,
  uninstallSkill,
  SKILL_ID_PATTERN
} from '../../src/main/store/skill-installer'
import {
  installPresetBundle,
  uninstallPreset
} from '../../src/main/store/preset-installer'
import type { DownloadedFile } from '../../src/main/store/downloader'
import type { StoreEntry } from '../../src/shared/store'

const workdirs: string[] = []

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ezdsh-install-'))
  workdirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(workdirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function textFile(path: string, content: string): DownloadedFile {
  return { path, bytes: Buffer.from(content), kind: 'text' }
}

function entry(overrides: Partial<StoreEntry>): StoreEntry {
  return {
    id: 'demo',
    kind: 'skill',
    name: 'Demo',
    description: 'Demo',
    category: 'demo',
    auditLevel: 'verified',
    version: '1.0.0',
    ...overrides
  }
}

describe('skill id validation', () => {
  it('accepts kebab-case ids and rejects others', () => {
    expect(SKILL_ID_PATTERN.test('feishu-calendar')).toBe(true)
    expect(SKILL_ID_PATTERN.test('demo')).toBe(true)
    expect(SKILL_ID_PATTERN.test('Demo')).toBe(false)
    expect(SKILL_ID_PATTERN.test('a_b')).toBe(false)
    expect(SKILL_ID_PATTERN.test('../escape')).toBe(false)
  })
})

describe('skill install', () => {
  it('writes bundle files under the DSH skills directory', async () => {
    const home = await tempHome()
    await installSkillBundle(home, entry({ id: 'demo' }), [
      textFile('demo/SKILL.md', '---\nname: demo\ndescription: d\n---\n\nbody'),
      textFile('demo/helper.sh', 'echo hi')
    ])
    const skillsDir = join(home, 'skills')
    expect(await readdir(join(skillsDir, 'demo'))).toEqual(['SKILL.md', 'helper.sh'])
    expect(await readFile(join(skillsDir, 'demo', 'SKILL.md'), 'utf8')).toContain('body')
  })

  it('rejects bundle files that escape the skill directory', async () => {
    const home = await tempHome()
    await expect(
      installSkillBundle(home, entry({ id: 'demo' }), [textFile('other/SKILL.md', 'x')])
    ).rejects.toThrow(/outside/i)
  })

  it('refuses an invalid skill id', async () => {
    const home = await tempHome()
    await expect(
      installSkillBundle(home, entry({ id: 'Bad_Id' }), [textFile('Bad_Id/SKILL.md', 'x')])
    ).rejects.toThrow(/id/i)
  })

  it('refuses to overwrite a skill that already exists on disk', async () => {
    const home = await tempHome()
    const files = [textFile('demo/SKILL.md', 'x')]
    await installSkillBundle(home, entry({ id: 'demo' }), files)
    await expect(installSkillBundle(home, entry({ id: 'demo' }), files)).rejects.toThrow(/already exists/i)
  })

  it('rolls back partial writes when one file fails', async () => {
    const home = await tempHome()
    const failing = {
      path: 'demo/SKILL.md',
      bytes: Buffer.from('ok'),
      kind: 'text' as const
    }
    const boom: DownloadedFile = new Proxy(failing, {
      get(target, prop) {
        if (prop === 'bytes') throw new Error('disk blew up')
        return Reflect.get(target, prop)
      }
    })
    await expect(installSkillBundle(home, entry({ id: 'demo' }), [failing, boom])).rejects.toThrow()
    const skillsDir = join(home, 'skills')
    expect(await readdir(skillsDir)).toEqual([])
  })

  it('uninstalls a directory bundle and a flat file skill', async () => {
    const home = await tempHome()
    await installSkillBundle(home, entry({ id: 'demo' }), [textFile('demo/SKILL.md', 'x')])
    await writeFile(join(home, 'skills', 'flat.md'), '---\nname: flat\ndescription: f\n---\nx')
    await uninstallSkill(home, 'demo')
    await uninstallSkill(home, 'flat')
    expect(await readdir(join(home, 'skills'))).toEqual([])
  })

  it('uninstall of an unknown skill reports but does not throw', async () => {
    const home = await tempHome()
    await expect(uninstallSkill(home, 'ghost')).resolves.toBe(false)
  })
})

describe('preset install', () => {
  it('writes the composition and metadata under the presets directory', async () => {
    const home = await tempHome()
    await installPresetBundle(home, entry({ id: 'demo', kind: 'preset' }), [
      textFile('demo/agent.cordis.yml', '- id: todo\n  name: @deepseek-ai/dsh-todo\n'),
      textFile('demo/preset.yml', 'name: 标准模式\ndescription: 完整\norder: 1\n')
    ])
    const presetsDir = join(home, '.agent-presets', 'demo')
    expect(await readdir(presetsDir)).toEqual(['agent.cordis.yml', 'preset.yml'])
  })

  it('requires an agent.cordis.yml composition in the bundle', async () => {
    const home = await tempHome()
    await expect(
      installPresetBundle(home, entry({ id: 'demo', kind: 'preset' }), [textFile('demo/other.yml', 'x')])
    ).rejects.toThrow(/agent\.cordis\.yml/i)
  })

  it('strips a trust field a locally installed preset must not claim', async () => {
    const home = await tempHome()
    await installPresetBundle(home, entry({ id: 'demo', kind: 'preset' }), [
      textFile('demo/agent.cordis.yml', '- id: todo\n  name: @deepseek-ai/dsh-todo\n'),
      textFile('demo/preset.yml', 'name: x\ntrust: system\n')
    ])
    const metadata = await readFile(join(home, '.agent-presets', 'demo', 'preset.yml'), 'utf8')
    expect(metadata).not.toContain('trust')
  })

  it('uninstalls the preset directory', async () => {
    const home = await tempHome()
    await installPresetBundle(home, entry({ id: 'demo', kind: 'preset' }), [
      textFile('demo/agent.cordis.yml', '[]\n')
    ])
    expect(await uninstallPreset(home, 'demo')).toBe(true)
    expect(await readdir(join(home, '.agent-presets'))).toEqual([])
  })
})
