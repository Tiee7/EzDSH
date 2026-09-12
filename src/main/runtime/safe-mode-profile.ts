import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { UserDataLayout } from '../../shared/state.js'

const SAFE_MODE_PROFILE = 'ezdsh-safe'
const SAFE_MODE_OWNER = 'ezdsh-safe-mode-profile-v1'
const DEFAULT_PRESET_IDS = ['standard', 'minimal', 'ptc', 'cordis'] as const
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i

export interface SafeModeProfileControllerOptions {
  readonly layout: UserDataLayout
}

export interface SafeModeProfile {
  readonly dshHome: string
  readonly profile: string
  readonly presetIds: readonly string[]
}

/**
 * Builds an EzDSH-owned profile inside the normal DSH_HOME. The profile loads
 * only the built-in base and Web bundles, and its private preset roster omits
 * local instruction and Skill providers. Normal profiles and workspaces remain
 * byte-for-byte untouched.
 */
export class SafeModeProfileController {
  private readonly profileDirectory: string
  private readonly safeRoot: string
  private readonly presetRoot: string

  constructor(private readonly options: SafeModeProfileControllerOptions) {
    this.profileDirectory = join(options.layout.harness, 'profiles', SAFE_MODE_PROFILE)
    this.safeRoot = join(options.layout.state, 'safe-mode-profile')
    this.presetRoot = join(this.safeRoot, 'presets')
  }

  async enable(): Promise<SafeModeProfile> {
    await this.assertProfileAvailable()
    await rm(this.safeRoot, { recursive: true, force: true })
    await rm(this.profileDirectory, { recursive: true, force: true })
    await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 })
    await mkdir(this.presetRoot, { recursive: true, mode: 0o700 })

    const configuredDefault = await this.readConfiguredDefaultPreset()
    const defaultPreset = configuredDefault ?? 'standard'
    const presetIds = await this.resolvePresetIds(configuredDefault)
    await Promise.all(presetIds.map(async (presetId) => {
      const directory = join(this.presetRoot, presetId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeAtomic(join(directory, 'agent.cordis.yml'), SAFE_AGENT_COMPOSITION)
      await writeAtomic(join(directory, 'preset.yml'), 'name: 安全模式\ndescription: 保留当前工作文件夹，但不加载第三方插件、Skills、自定义 Agent 模式或项目指令。\n')
    }))

    const manifest = {
      name: `dsh-profile-${SAFE_MODE_PROFILE}`,
      private: true,
      dependencies: {},
      ezdsh: { owner: SAFE_MODE_OWNER },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
          patchReload: 'startup',
        },
      },
    }
    await writeAtomic(join(this.profileDirectory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeAtomic(join(this.profileDirectory, 'cordis.patch.yml'), safeProfilePatch(this.presetRoot, defaultPreset))
    await writeAtomic(join(this.profileDirectory, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

    return { dshHome: this.options.layout.harness, profile: SAFE_MODE_PROFILE, presetIds }
  }

  async disable(): Promise<void> {
    if (await this.isOwnedProfile()) {
      await rm(this.profileDirectory, { recursive: true, force: true })
    }
    await rm(this.safeRoot, { recursive: true, force: true })
  }

  private async assertProfileAvailable(): Promise<void> {
    try {
      await stat(this.profileDirectory)
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return
      throw error
    }
    if (!await this.isOwnedProfile()) {
      throw new Error(`Safe Mode profile ${SAFE_MODE_PROFILE} exists but is not owned by EzDSH`)
    }
  }

  private async isOwnedProfile(): Promise<boolean> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.profileDirectory, 'package.json'), 'utf8'))
      return typeof parsed === 'object' && parsed !== null
        && typeof (parsed as { ezdsh?: unknown }).ezdsh === 'object'
        && (parsed as { ezdsh: { owner?: unknown } }).ezdsh.owner === SAFE_MODE_OWNER
    } catch {
      return false
    }
  }

  private async resolvePresetIds(configuredDefault?: string): Promise<string[]> {
    const ids = new Set<string>(DEFAULT_PRESET_IDS)
    if (configuredDefault !== undefined) ids.add(configuredDefault)
    try {
      const entries = await readdir(join(this.options.layout.harness, '.agent-presets'), { withFileTypes: true })
      for (const entry of entries) {
        if ((entry.isDirectory() || entry.isSymbolicLink()) && PRESET_ID_PATTERN.test(entry.name)) ids.add(entry.name)
      }
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error
    }
    return [...ids].sort((left, right) => left.localeCompare(right))
  }

  private async readConfiguredDefaultPreset(): Promise<string | undefined> {
    try {
      const parsed: unknown = parseYaml(await readFile(join(this.options.layout.harness, 'settings.yaml'), 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const section = (parsed as Record<string, unknown>)['agent-presets']
      if (typeof section !== 'object' || section === null) return undefined
      const value = (section as Record<string, unknown>).default
      return typeof value === 'string' && PRESET_ID_PATTERN.test(value) ? value : undefined
    } catch {
      return undefined
    }
  }
}

function safeProfilePatch(presetRoot: string, defaultPreset: string): string {
  return [
    '- id: agent-presets',
    '  config:',
    `    default: ${JSON.stringify(defaultPreset)}`,
    '    roots:',
    `      - path: ${JSON.stringify(presetRoot)}`,
    '        trust: system',
    '    includeShippedRoot: false',
    '    includeUserRoot: false',
    '',
  ].join('\n')
}

const SAFE_AGENT_COMPOSITION = `# EzDSH Safe Mode: built-in tools only; no project instructions, Skills, custom presets, or delegation.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: Your working directory is {{cwd}}.
    prefix: You are a coding agent running in EzDSH Safe Mode.

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'

- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true

- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    searchTimeoutMs: 60000

- id: present
  name: '@deepseek-ai/dsh-tool-present'
`

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = join(dirname(path), `.${basename(path)}.tmp-${String(process.pid)}-${String(Date.now())}`)
  await writeFile(temporaryPath, content, { mode: 0o600 })
  await rename(temporaryPath, path)
}
