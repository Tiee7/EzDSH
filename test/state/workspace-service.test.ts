import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isDirectoryEmpty,
  isWorkspaceTargetInsideSource,
  moveWorkspaceContents,
  readWorkspaceRoot,
  writeWorkspaceRoot,
} from '../../src/main/state/workspace-service'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeTempRoot(): Promise<string> {
  const root = join('/tmp', `ezdsh-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  temporaryRoots.push(root)
  await mkdir(root, { recursive: true })
  return root
}

describe('workspace root persistence', () => {
  it('falls back to the Electron default when no workspace file exists', async () => {
    const root = await makeTempRoot()

    await expect(readWorkspaceRoot(join(root, 'workspace.json'), join(root, 'default')))
      .resolves.toBe(join(root, 'default'))
  })

  it('round-trips an absolute custom workspace root', async () => {
    const root = await makeTempRoot()
    const configPath = join(root, 'workspace.json')
    const customRoot = join(root, 'custom')

    await writeWorkspaceRoot(configPath, customRoot)

    await expect(readWorkspaceRoot(configPath, join(root, 'default'))).resolves.toBe(customRoot)
    await expect(readFile(configPath, 'utf8')).resolves.toContain('"root"')
  })

  it('ignores an invalid configured root', async () => {
    const root = await makeTempRoot()
    const configPath = join(root, 'workspace.json')
    await writeFile(configPath, JSON.stringify({ root: 'relative/path' }))

    await expect(readWorkspaceRoot(configPath, join(root, 'default'))).resolves.toBe(join(root, 'default'))
  })
})

describe('workspace content migration', () => {
  it('moves every entry, including hidden entries, into an empty target', async () => {
    const root = await makeTempRoot()
    const source = join(root, 'source')
    const target = join(root, 'target')
    await mkdir(join(source, 'nested'), { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(source, 'visible.txt'), 'visible')
    await writeFile(join(source, '.hidden'), 'hidden')
    await writeFile(join(source, 'nested', 'file.txt'), 'nested')

    await moveWorkspaceContents(source, target)

    await expect(readFile(join(target, 'visible.txt'), 'utf8')).resolves.toBe('visible')
    await expect(readFile(join(target, '.hidden'), 'utf8')).resolves.toBe('hidden')
    await expect(readFile(join(target, 'nested', 'file.txt'), 'utf8')).resolves.toBe('nested')
    await expect(readdir(source)).resolves.toEqual([])
  })

  it('rejects a non-empty target without changing either directory', async () => {
    const root = await makeTempRoot()
    const source = join(root, 'source')
    const target = join(root, 'target')
    await mkdir(source, { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(source, 'source.txt'), 'source')
    await writeFile(join(target, 'target.txt'), 'target')

    await expect(moveWorkspaceContents(source, target)).rejects.toThrow('empty')
    await expect(readFile(join(source, 'source.txt'), 'utf8')).resolves.toBe('source')
    await expect(readFile(join(target, 'target.txt'), 'utf8')).resolves.toBe('target')
  })

  it('rejects a target nested inside the source', async () => {
    const root = await makeTempRoot()
    const source = join(root, 'source')
    const target = join(source, 'nested-target')
    await mkdir(source, { recursive: true })

    await expect(moveWorkspaceContents(source, target)).rejects.toThrow('inside')
    expect(isWorkspaceTargetInsideSource(source, target)).toBe(true)
    expect(isWorkspaceTargetInsideSource(source, join(root, 'other'))).toBe(false)
  })

  it('reports whether a directory is empty', async () => {
    const root = await makeTempRoot()
    const empty = join(root, 'empty')
    const filled = join(root, 'filled')
    await mkdir(empty, { recursive: true })
    await mkdir(filled, { recursive: true })
    await writeFile(join(filled, '.entry'), '')

    await expect(isDirectoryEmpty(empty)).resolves.toBe(true)
    await expect(isDirectoryEmpty(filled)).resolves.toBe(false)
    await expect(isDirectoryEmpty(join(root, 'missing'))).resolves.toBe(false)
    expect(relative(root, empty)).not.toContain('..')
    await expect(access(empty)).resolves.toBeUndefined()
  })
})
