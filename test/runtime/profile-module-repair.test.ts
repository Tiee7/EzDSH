import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { repairProfileModuleDrift } from '../../src/main/runtime/profile-module-repair'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(localPackage: { packageJson?: string }): Promise<{
  root: string
  dshHome: string
  runtimeEntryPath: string
  packagePath: string
  quarantineRoot: string
}> {
  const root = await mkdtemp(join('/tmp', 'ezdsh-profile-repair-'))
  roots.push(root)
  const runtimeRoot = join(root, 'runtime', 'apps', 'cli')
  const runtimeEntryPath = join(runtimeRoot, 'lib', 'bin.js')
  const runtimePackagePath = join(runtimeRoot, 'package.json')
  const packagePath = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json')
  const localPackagePath = join(root, 'harness', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json')
  await mkdir(join(runtimeRoot, 'lib'), { recursive: true })
  await mkdir(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib'), { recursive: true })
  await mkdir(join(root, 'harness', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib'), { recursive: true })
  await writeFile(runtimeEntryPath, '')
  await writeFile(runtimePackagePath, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }))
  await writeFile(packagePath, JSON.stringify({
    name: '@deepseek-ai/dsh-llm',
    version: '0.1.5-rc.2',
    exports: { './package.json': './package.json', '.': './lib/index.js' },
  }))
  await writeFile(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'), '')
  if (localPackage.packageJson !== undefined) await writeFile(localPackagePath, localPackage.packageJson)
  await writeFile(join(root, 'harness', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'), 'stale')
  const dshHome = join(root, 'harness')
  const quarantineRoot = join(root, 'quarantine')
  return { root, dshHome, runtimeEntryPath, packagePath: localPackagePath, quarantineRoot }
}

describe('profile module repair', () => {
  it('quarantines a core package whose metadata was pruned', async () => {
    const current = await fixture({})

    const result = await repairProfileModuleDrift({
      dshHome: current.dshHome,
      profile: 'web',
      runtimeEntryPath: current.runtimeEntryPath,
      quarantineRoot: current.quarantineRoot,
    })

    expect(result.moved).toHaveLength(1)
    await expect(readFile(current.packagePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(current.quarantineRoot, 'web', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'), 'utf8')).resolves.toBe('stale')
  })

  it('quarantines an older profile copy so the current Runtime fallback wins', async () => {
    const current = await fixture({ packageJson: JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.1.0-rc.8' }) })

    const result = await repairProfileModuleDrift({
      dshHome: current.dshHome,
      profile: 'web',
      runtimeEntryPath: current.runtimeEntryPath,
      quarantineRoot: current.quarantineRoot,
    })

    expect(result.moved).toEqual(['@deepseek-ai/dsh-llm'])
  })

  it('leaves a profile copy from the selected Runtime untouched', async () => {
    const current = await fixture({ packageJson: JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.1.5-rc.2' }) })

    await expect(repairProfileModuleDrift({
      dshHome: current.dshHome,
      profile: 'web',
      runtimeEntryPath: current.runtimeEntryPath,
      quarantineRoot: current.quarantineRoot,
    })).resolves.toEqual({ moved: [] })
  })
})
