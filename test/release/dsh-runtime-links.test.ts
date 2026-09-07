import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeNestedIdentityLinks } from '../../scripts/normalize-dsh-runtime-links.mjs'

const roots: string[] = []

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-links-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('DSH Runtime identity links', () => {
  it('removes nested identity-package copies while keeping the canonical package', async () => {
    const root = await tempRoot()
    const pnpmRoot = join(root, 'node_modules', '.pnpm')
    const canonical = join(
      pnpmRoot,
      '@deepseek-ai+dsh-scope@file+packages+core+scope',
      'node_modules',
      '@deepseek-ai',
      'dsh-scope'
    )
    const publicPackage = join(pnpmRoot, 'node_modules', '@deepseek-ai', 'dsh-scope')
    const nestedCopy = join(
      pnpmRoot,
      '@deepseek-ai+dsh-agent-presets@file+packages+preset+agent-presets',
      'node_modules',
      '@deepseek-ai',
      'dsh-scope'
    )

    await Promise.all([
      mkdir(canonical, { recursive: true }),
      mkdir(publicPackage, { recursive: true }),
      mkdir(nestedCopy, { recursive: true })
    ])
    await writeFile(join(canonical, 'package.json'), '{"name":"@deepseek-ai/dsh-scope"}')
    await writeFile(join(publicPackage, 'package.json'), '{"name":"@deepseek-ai/dsh-scope"}')
    await writeFile(join(nestedCopy, 'package.json'), '{"name":"@deepseek-ai/dsh-scope"}')

    const removed = await removeNestedIdentityLinks(pnpmRoot, [
      '@deepseek-ai/dsh-scope'
    ], [canonical])

    expect(removed).toBe(1)
    await expect(readFile(join(canonical, 'package.json'), 'utf8')).resolves.toContain('dsh-scope')
    await expect(readFile(join(publicPackage, 'package.json'), 'utf8')).resolves.toContain('dsh-scope')
    await expect(readFile(join(nestedCopy, 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
