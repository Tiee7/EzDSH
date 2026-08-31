import { access, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureUserDataLayout, getUserDataLayout } from '../../src/main/state/user-data'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('getUserDataLayout', () => {
  it('keeps every directory inside the supplied userData root', () => {
    const root = '/tmp/ezdsh-user-data'
    const layout = getUserDataLayout(root)

    expect(layout.root).toBe(root)
    expect(layout.workflowRoot).toBe(join(root, 'workflow'))
    for (const directory of [layout.launchRoot, layout.harness, layout.logs, layout.state, layout.backups, layout.workflowRoot]) {
      expect(relative(layout.root, directory).startsWith('..')).toBe(false)
    }
  })

  it('rejects a relative root', () => {
    expect(() => getUserDataLayout('relative-user-data')).toThrow('must be absolute')
  })
})

describe('ensureUserDataLayout', () => {
  it('creates the expected directories and is idempotent', async () => {
    const root = join('/tmp', `ezdsh-test-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    temporaryRoots.push(root)
    const layout = getUserDataLayout(root)

    await ensureUserDataLayout(layout)
    await ensureUserDataLayout(layout)

    await Promise.all([layout.launchRoot, layout.harness, layout.logs, layout.state, layout.backups, layout.workflowRoot].map((directory) => access(directory)))
  })

  it('rejects a layout path escaping its root', async () => {
    const layout = getUserDataLayout('/tmp/ezdsh-user-data')
    await expect(ensureUserDataLayout({ ...layout, logs: '/tmp/other-logs' })).rejects.toThrow('escapes')
  })
})
