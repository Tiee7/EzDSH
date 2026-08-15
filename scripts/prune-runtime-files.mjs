import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const PRUNED_DIRECTORY_NAMES = new Set([
  'test',
  'tests',
  '__tests__',
  'example',
  'examples',
  'docs',
  'coverage'
])

const PRUNED_FILE_PATTERNS = [
  /^README(?:\.|$)/i,
  /^CHANGELOG(?:\.|$)/i,
  /^CONTRIBUTING(?:\.|$)/i,
  /^tsconfig(?:\.|$)/i,
  /^tsdown\.config\./i,
  /\.d\.ts(?:\.map)?$/i,
  /\.js\.map$/i
]

export function shouldPruneRuntimePath(relativePath) {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean)
  if (parts.some((part) => PRUNED_DIRECTORY_NAMES.has(part))) return true
  if (parts.includes('@deepseek-ai') && parts.includes('src')) return true
  const basename = parts.at(-1) ?? ''
  return PRUNED_FILE_PATTERNS.some((pattern) => pattern.test(basename))
}

export async function pruneRuntimeFiles(root) {
  async function visit(directory, relativeDirectory = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
      const current = join(directory, entry.name)
      if (shouldPruneRuntimePath(relativePath)) {
        await rm(current, { recursive: true, force: true })
        continue
      }
      if (entry.isDirectory()) await visit(current, relativePath)
    }
  }

  await visit(root)
}
