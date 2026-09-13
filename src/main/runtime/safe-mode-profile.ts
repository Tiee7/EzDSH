import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
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
  private readonly selectionPath: string

  constructor(private readonly options: SafeModeProfileControllerOptions) {
    this.profileDirectory = join(options.layout.harness, 'profiles', SAFE_MODE_PROFILE)
    this.safeRoot = join(options.layout.state, 'safe-mode-profile')
    this.presetRoot = join(this.safeRoot, 'presets')
    this.selectionPath = join(options.layout.state, 'safe-mode-selection.json')
  }

  /** A missing choice means normal startup; unreadable or invalid choices must not load extensions. */
  async restoreIfEnabled(): Promise<SafeModeProfile | undefined> {
    try {
      await lstat(this.selectionPath)
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return undefined
      throw error
    }
    const content = await readFile(this.selectionPath, 'utf8')

    let selection: unknown
    try {
      selection = JSON.parse(content)
    } catch {
      throw new Error('Cannot restore Safe Mode selection: invalid JSON')
    }
    if (typeof selection !== 'object' || selection === null
      || (selection as Record<string, unknown>).version !== 1
      || (selection as Record<string, unknown>).mode !== 'safe') {
      throw new Error('Cannot restore Safe Mode selection: unsupported saved choice')
    }
    return this.enable()
  }

  async enable(): Promise<SafeModeProfile> {
    await this.assertProfileAvailable()
    await this.assertSafeRootAvailable()
    const configuredDefault = await this.readConfiguredDefaultPreset()
    const defaultPreset = configuredDefault ?? 'standard'
    const presetIds = await this.resolvePresetIds(configuredDefault)

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
    await mkdir(dirname(this.profileDirectory), { recursive: true, mode: 0o700 })
    await mkdir(this.options.layout.state, { recursive: true, mode: 0o700 })
    const stagedSafeRoot = await mkdtemp(join(this.options.layout.state, '.safe-mode-profile-'))
    let stagedProfile: string | undefined
    try {
      stagedProfile = await mkdtemp(join(dirname(this.profileDirectory), '.ezdsh-safe-'))
      await writeAtomic(join(stagedSafeRoot, 'owner.json'), `${JSON.stringify({ owner: SAFE_MODE_OWNER })}\n`)
      for (const presetId of presetIds) {
        const directory = join(stagedSafeRoot, 'presets', presetId)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await writeAtomic(join(directory, 'agent.cordis.yml'), SAFE_AGENT_COMPOSITION)
        await writeAtomic(join(directory, 'preset.yml'), 'name: 安全模式\ndescription: 保留当前工作文件夹，但不加载第三方插件、Skills、自定义 Agent 模式或项目指令。\n')
      }
      await writeAtomic(join(stagedProfile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      await writeAtomic(join(stagedProfile, 'cordis.patch.yml'), safeProfilePatch(this.presetRoot, defaultPreset))
      await writeAtomic(join(stagedProfile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

      // Recheck ownership before publishing; only fully generated directories
      // with an owner marker can become the active profile and preset root.
      await this.assertProfileAvailable()
      await this.assertSafeRootAvailable()
      await replaceGeneratedDirectory(stagedSafeRoot, this.safeRoot)
      await replaceGeneratedDirectory(stagedProfile, this.profileDirectory)
      await writeAtomic(this.selectionPath, `${JSON.stringify({ version: 1, mode: 'safe' })}\n`)
    } finally {
      await rm(stagedSafeRoot, { recursive: true, force: true })
      if (stagedProfile !== undefined) await rm(stagedProfile, { recursive: true, force: true })
    }

    return { dshHome: this.options.layout.harness, profile: SAFE_MODE_PROFILE, presetIds }
  }

  async disable(): Promise<void> {
    const ownedSafeRoot = await this.isOwnedSafeRoot()
    if (await this.isOwnedProfile()) {
      await rm(this.profileDirectory, { recursive: true, force: true })
    }
    if (ownedSafeRoot) await rm(this.safeRoot, { recursive: true, force: true })
    await rm(this.selectionPath, { force: true })
  }

  private async assertSafeRootAvailable(): Promise<void> {
    try {
      const entry = await lstat(this.safeRoot)
      if (entry.isDirectory() && await this.isOwnedSafeRoot()) return
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return
      throw error
    }
    throw new Error('Safe Mode generated-resource directory exists but is not owned by EzDSH')
  }

  private async isOwnedSafeRoot(): Promise<boolean> {
    let content: string
    try {
      content = await readFile(join(this.safeRoot, 'owner.json'), 'utf8')
    } catch (error) {
      // Before persisted Safe Mode, the owned profile was the only owner
      // marker for its generated preset root. Keep that upgrade path usable.
      return hasErrorCode(error, 'ENOENT') && await this.isOwnedProfile()
    }
    try {
      const owner: unknown = JSON.parse(content)
      return typeof owner === 'object' && owner !== null
        && (owner as Record<string, unknown>).owner === SAFE_MODE_OWNER
    } catch {
      return false
    }
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

/** Replace generated content without leaving a partial directory at the public path. */
async function replaceGeneratedDirectory(stagedPath: string, destination: string): Promise<void> {
  const previousPath = `${stagedPath}.previous`
  let hadPrevious = false
  try {
    await rename(destination, previousPath)
    hadPrevious = true
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error
  }
  try {
    await rename(stagedPath, destination)
  } catch (error) {
    if (hadPrevious) {
      try {
        await rename(previousPath, destination)
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Could not restore the previous generated Safe Mode directory')
      }
    }
    throw error
  }
  if (hadPrevious) await rm(previousPath, { recursive: true, force: true })
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = join(dirname(path), `.${basename(path)}.tmp-${String(process.pid)}-${String(Date.now())}`)
  try {
    await writeFile(temporaryPath, content, { mode: 0o600 })
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}
