import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneRuntimeFiles, shouldPruneRuntimePath } from '../../scripts/prune-runtime-files.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('pruneRuntimeFiles', () => {
  it('removes development-only files while keeping runtime JavaScript and manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-prune-'))
    roots.push(root)
    await mkdir(join(root, 'node_modules', '@deepseek-ai', 'pkg', 'src'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'third-party', 'src'), { recursive: true })
    await mkdir(join(root, 'pkg', 'tests'), { recursive: true })
    await writeFile(join(root, 'node_modules', '@deepseek-ai', 'pkg', 'src', 'index.ts'), '')
    await writeFile(join(root, 'node_modules', 'third-party', 'src', 'index.js'), '')
    await writeFile(join(root, 'pkg', 'tests', 'index.spec.ts'), '')
    await writeFile(join(root, 'pkg', 'lib.js'), '')
    await writeFile(join(root, 'pkg', 'package.json'), '{}')
    await writeFile(join(root, 'pkg', 'README.md'), '')

    await pruneRuntimeFiles(root)

    await expect(readdir(join(root, 'pkg'))).resolves.toEqual(['lib.js', 'package.json'])
    await expect(readdir(join(root, 'node_modules', '@deepseek-ai', 'pkg'))).resolves.toEqual([])
    await expect(readdir(join(root, 'node_modules', 'third-party', 'src'))).resolves.toEqual(['index.js'])
  })

  it('keeps package licenses', () => {
    expect(shouldPruneRuntimePath('pkg/LICENSE')).toBe(false)
  })
})
