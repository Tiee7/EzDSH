import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { UserDataLayout } from '../../shared/state.js'

const DIRECTORY_NAMES = ['launch-root', 'harness', 'logs', 'state', 'backups'] as const

/** Resolve all persistent EzDSH paths from one trusted Main-process root. */
export function getUserDataLayout(userDataPath: string): UserDataLayout {
  if (!isAbsolute(userDataPath)) {
    throw new TypeError('EzDSH userDataPath must be absolute')
  }

  const root = resolve(userDataPath)
  const path = (name: (typeof DIRECTORY_NAMES)[number]): string => join(root, name)
  return {
    root,
    launchRoot: path('launch-root'),
    harness: path('harness'),
    logs: path('logs'),
    state: path('state'),
    backups: path('backups')
  }
}

/** Ensure the durable directory layout exists and remains safe to call repeatedly. */
export async function ensureUserDataLayout(layout: UserDataLayout): Promise<void> {
  const root = normalize(resolve(layout.root))
  const paths = [layout.launchRoot, layout.harness, layout.logs, layout.state, layout.backups]

  for (const candidate of paths) {
    const resolved = normalize(resolve(candidate))
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
      throw new Error(`EzDSH user-data path escapes its root: ${candidate}`)
    }
  }

  await Promise.all(paths.map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })))
}
