import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readLanguageTagVisible, writeLanguageTagVisible } from '../../src/main/state/language-tag.js'

describe('language tag visibility state', () => {
  it('defaults to visible when the state file does not exist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-language-tag-'))

    await expect(readLanguageTagVisible(join(directory, 'language-tag.json'))).resolves.toBe(true)
  })

  it('persists and reads the visibility flag', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-language-tag-'))
    const filePath = join(directory, 'language-tag.json')

    await writeLanguageTagVisible(filePath, false)

    await expect(readLanguageTagVisible(filePath)).resolves.toBe(false)
    await expect(readFile(filePath, 'utf8')).resolves.toContain('"visible": false')
  })
})
