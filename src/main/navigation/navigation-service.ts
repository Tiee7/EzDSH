import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getDefaultNavConfig,
  normalizeNavConfig,
  pinFixedTabs,
  validateNavConfig,
  type NavConfig,
  type NavItem
} from '../../shared/navigation.js'

const CONFIG_FILE_NAME = 'navigation.json'

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function cloneItems(items: NavItem[]): NavItem[] {
  return items.map((item) => (item.kind === 'builtin' ? { ...item } : { ...item }))
}

export class NavigationService {
  private config: NavConfig = getDefaultNavConfig()
  private readonly configPath: string

  constructor(stateDir: string) {
    this.configPath = join(stateDir, CONFIG_FILE_NAME)
  }

  async initialize(): Promise<void> {
    try {
      const raw = await readFile(this.configPath, 'utf8')
      this.config = normalizeNavConfig(JSON.parse(raw))
    } catch (error) {
      if (isNotFound(error)) return
      console.error('[navigation] failed to load config, falling back to defaults:', error)
      this.config = getDefaultNavConfig()
    }
  }

  getConfig(): NavConfig {
    return { items: cloneItems(this.config.items) }
  }

  async setConfig(config: NavConfig): Promise<void> {
    const error = validateNavConfig(config)
    if (error !== undefined) throw new Error(error)
    this.config = { items: pinFixedTabs(cloneItems(config.items)) }
    await writeFile(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 })
  }
}
