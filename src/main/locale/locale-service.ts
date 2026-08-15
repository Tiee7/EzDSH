import { unwatchFile, watchFile, type Stats } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { DEFAULT_APP_LOCALE, type AppLocale } from '../../shared/locale.js'

interface LocaleDocument {
  locale?: {
    preference?: unknown
  }
}

export async function readDshLocale(settingsPath: string): Promise<AppLocale> {
  try {
    const document = parse(await readFile(settingsPath, 'utf8')) as LocaleDocument | null
    const preference = document?.locale?.preference
    return preference === 'en' || preference === 'zh' ? preference : DEFAULT_APP_LOCALE
  } catch {
    return DEFAULT_APP_LOCALE
  }
}

export class LocaleService {
  private current: AppLocale = DEFAULT_APP_LOCALE
  private watcher: ((current: Stats, previous: Stats) => void) | undefined
  private listeners = new Set<(locale: AppLocale) => void>()

  constructor(private readonly settingsPath: string) {}

  snapshot(): AppLocale {
    return this.current
  }

  onChange(listener: (locale: AppLocale) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<AppLocale> {
    await this.reload()
    this.watcher = () => { void this.reload() }
    watchFile(this.settingsPath, { persistent: false, interval: 250 }, this.watcher)
    return this.current
  }

  async reload(): Promise<AppLocale> {
    const next = await readDshLocale(this.settingsPath)
    if (next !== this.current) {
      this.current = next
      for (const listener of [...this.listeners]) listener(next)
    }
    return this.current
  }

  stop(): void {
    if (this.watcher !== undefined) unwatchFile(this.settingsPath, this.watcher)
    this.watcher = undefined
    this.listeners.clear()
  }
}
