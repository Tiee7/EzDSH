import { chmod, lstat, mkdir, mkdtemp, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fixBinPermissions } from '../../scripts/fix-bin-permissions.mjs'

const temporaryRoots: string[] = []

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-bin-permissions-'))
  temporaryRoots.push(root)
  const nodeModules = join(root, 'node_modules')
  const binDir = join(nodeModules, '.bin')
  await mkdir(binDir, { recursive: true })
  return { root, nodeModules, binDir }
}

async function makeBinTarget(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  name: string,
  mode: number
) {
  const packageDir = join(fixture.nodeModules, name)
  const target = join(packageDir, 'cli.js')
  await mkdir(packageDir, { recursive: true })
  await writeFile(target, '#!/usr/bin/env node\n')
  await chmod(target, mode)
  await symlink(join('..', name, 'cli.js'), join(fixture.binDir, name))
  return target
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('fixBinPermissions', () => {
  it('repairs a stale valid root .bin symlink with the executable mode npm uses', async () => {
    const fixture = await makeFixture()
    const target = await makeBinTarget(fixture, 'tool', 0o644)
    const previousUmask = process.umask(0o027)

    try {
      await expect(fixBinPermissions(fixture.root)).resolves.toEqual(['node_modules/tool/cli.js'])
    } finally {
      process.umask(previousUmask)
    }

    expect((await stat(target)).mode & 0o777).toBe(0o750)
  })

  it('is idempotent and leaves an already executable target unchanged', async () => {
    const fixture = await makeFixture()
    const repaired = await makeBinTarget(fixture, 'repaired', 0o644)
    const executable = await makeBinTarget(fixture, 'executable', 0o744)

    await expect(fixBinPermissions(fixture.root)).resolves.toEqual(['node_modules/repaired/cli.js'])
    const executableMode = (await stat(executable)).mode & 0o777
    await expect(fixBinPermissions(fixture.root)).resolves.toEqual([])

    expect((await stat(repaired)).mode & 0o111).not.toBe(0)
    expect((await stat(executable)).mode & 0o777).toBe(executableMode)
  })

  it('scans only the repository root node_modules/.bin', async () => {
    const fixture = await makeFixture()
    const nestedNodeModules = join(fixture.nodeModules, 'parent', 'node_modules')
    const nestedBinDir = join(nestedNodeModules, '.bin')
    const nestedTarget = join(nestedNodeModules, 'nested', 'cli.js')
    await mkdir(join(nestedNodeModules, 'nested'), { recursive: true })
    await mkdir(nestedBinDir, { recursive: true })
    await writeFile(nestedTarget, '#!/usr/bin/env node\n')
    await chmod(nestedTarget, 0o644)
    await symlink(join('..', 'nested', 'cli.js'), join(nestedBinDir, 'nested'))

    await expect(fixBinPermissions(fixture.root)).resolves.toEqual([])
    expect((await stat(nestedTarget)).mode & 0o777).toBe(0o644)
  })

  it('leaves regular, broken, and external .bin entries unchanged', async () => {
    const fixture = await makeFixture()
    const regularEntry = join(fixture.binDir, 'regular')
    const brokenEntry = join(fixture.binDir, 'broken')
    const externalDir = await mkdtemp(join(tmpdir(), 'ezdsh-bin-external-'))
    temporaryRoots.push(externalDir)
    const externalTarget = join(externalDir, 'cli.js')
    await writeFile(regularEntry, '#!/usr/bin/env node\n', { mode: 0o644 })
    await symlink(join('..', 'missing', 'cli.js'), brokenEntry)
    await writeFile(externalTarget, '#!/usr/bin/env node\n')
    await chmod(externalTarget, 0o644)
    await symlink(externalTarget, join(fixture.binDir, 'external'))

    await expect(fixBinPermissions(fixture.root)).resolves.toEqual([])

    expect((await lstat(regularEntry)).mode & 0o777).toBe(0o644)
    expect(await readlink(brokenEntry)).toBe(join('..', 'missing', 'cli.js'))
    expect((await stat(externalTarget)).mode & 0o777).toBe(0o644)
  })

  it('does nothing when the injected platform is win32', async () => {
    const fixture = await makeFixture()
    const target = await makeBinTarget(fixture, 'tool', 0o644)

    await expect(fixBinPermissions(fixture.root, { platform: 'win32' })).resolves.toEqual([])
    expect((await stat(target)).mode & 0o777).toBe(0o644)
  })

  it('reports target failures after attempting every eligible target', async () => {
    const fixture = await makeFixture()
    const first = await makeBinTarget(fixture, 'first', 0o644)
    const second = await makeBinTarget(fixture, 'second', 0o644)
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const attempted: string[] = []

    const result = fixBinPermissions(fixture.root, {
      chmod: async (target: string, mode: number) => {
        const packageName = basename(dirname(target))
        attempted.push(packageName)
        if (packageName === 'first') throw denied
        await chmod(target, mode)
      }
    })

    await expect(result).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [denied]
    })
    expect(attempted).toEqual(['first', 'second'])
    expect((await stat(first)).mode & 0o777).toBe(0o644)
    expect((await stat(second)).mode & 0o111).not.toBe(0)
  })
})
