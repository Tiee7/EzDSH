import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeIdentityPackages } from '../../scripts/normalize-dsh-runtime-links.mjs'

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
  it('materializes identity packages at the runtime root and removes nested copies', async () => {
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
    const rootPackage = join(root, 'node_modules', '@deepseek-ai', 'dsh-scope')
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
      mkdir(rootPackage, { recursive: true }),
      mkdir(nestedCopy, { recursive: true })
    ])
    await writeFile(join(canonical, 'package.json'), '{"name":"@deepseek-ai/dsh-scope"}')
    await writeFile(join(publicPackage, 'package.json'), '{"name":"@deepseek-ai/dsh-scope"}')
    await writeFile(join(rootPackage, 'package.json'), '{"name":"old-copy"}')
    await writeFile(join(nestedCopy, 'package.json'), '{"name":"@deepseek-ai/dsh-scope"}')

    const result = await materializeIdentityPackages(
      pnpmRoot,
      join(pnpmRoot, 'node_modules'),
      join(root, 'node_modules'),
      ['@deepseek-ai/dsh-scope']
    )

    expect(result).toEqual({ materializedCount: 1, nestedRemovedCount: 2 })
    await expect(readFile(join(canonical, 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(rootPackage, 'package.json'), 'utf8')).resolves.toContain('dsh-scope')
    await expect(readFile(join(publicPackage, 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(nestedCopy, 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('can materialize importer packages alongside shared identity packages', async () => {
    const root = await tempRoot()
    const pnpmRoot = join(root, 'node_modules', '.pnpm')
    const publicNodeModules = join(pnpmRoot, 'node_modules')
    const rootNodeModules = join(root, 'node_modules')
    const packageNames = [
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-agent-loop'
    ]

    for (const packageName of packageNames) {
      const packageSegments = packageName.split('/')
      const packageId = packageName === '@deepseek-ai/dsh-tools'
        ? '@deepseek-ai+dsh-tools@file+packages+tools'
        : '@deepseek-ai+dsh-agent-loop@file+packages+core+agent-loop'
      const canonical = join(pnpmRoot, packageId, 'node_modules', ...packageSegments)
      const publicPackage = join(publicNodeModules, ...packageSegments)
      await mkdir(canonical, { recursive: true })
      await mkdir(publicPackage, { recursive: true })
      await writeFile(join(canonical, 'package.json'), JSON.stringify({ name: packageName }))
      await writeFile(join(publicPackage, 'package.json'), JSON.stringify({ name: packageName }))
    }

    const result = await materializeIdentityPackages(
      pnpmRoot,
      publicNodeModules,
      rootNodeModules,
      packageNames
    )

    expect(result).toEqual({ materializedCount: 2, nestedRemovedCount: 2 })
    for (const packageName of packageNames) {
      const packageSegments = packageName.split('/')
      await expect(readFile(join(rootNodeModules, ...packageSegments, 'package.json'), 'utf8'))
        .resolves.toContain(packageName)
      await expect(readFile(join(publicNodeModules, ...packageSegments, 'package.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})
