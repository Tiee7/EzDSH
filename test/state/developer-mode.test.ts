import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readDeveloperMode, writeDeveloperMode } from '../../src/main/state/developer-mode.js'

describe('developer mode state', () => {
  it('defaults to disabled when the state file does not exist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-developer-mode-'))

    await expect(readDeveloperMode(join(directory, 'developer-mode.json'))).resolves.toBe(false)
  })

  it('persists and reads the enabled flag', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-developer-mode-'))
    const filePath = join(directory, 'developer-mode.json')

    await writeDeveloperMode(filePath, true)

    await expect(readDeveloperMode(filePath)).resolves.toBe(true)
    await expect(readFile(filePath, 'utf8')).resolves.toContain('"enabled": true')
  })
})
