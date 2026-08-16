import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readDshLocale, writeDshLocale } from '../../src/main/locale/locale-service'

const workdirs: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ezdsh-locale-'))
  workdirs.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all(workdirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('writeDshLocale', () => {
  it('creates the locale section in a missing settings file', async () => {
    const file = await tempFile('settings.yaml')
    await writeDshLocale(file, 'en')
    expect(await readDshLocale(file)).toBe('en')
  })

  it('updates the preference while preserving comments and sibling keys', async () => {
    const file = await tempFile('settings.yaml')
    await writeFile(file, [
      '# harness settings',
      'theme: dark',
      'locale:',
      '  preference: zh',
      ''
    ].join('\n'))
    await writeDshLocale(file, 'en')
    const text = await readFile(file, 'utf8')
    expect(text).toContain('# harness settings')
    expect(text).toContain('theme: dark')
    expect(await readDshLocale(file)).toBe('en')
  })
})
