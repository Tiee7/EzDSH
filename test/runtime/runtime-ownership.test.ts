import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntimeOwnershipStore } from '../../src/main/runtime/runtime-process-manager'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Runtime ownership records', () => {
  it('persists EzDSH-owned PIDs across manager instances and removes them on unregister', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-owner-'))
    roots.push(root)
    const first = createRuntimeOwnershipStore(root)
    first.register(12345)

    const second = createRuntimeOwnershipStore(root)
    expect(second.listOwnedPids()).toEqual(new Set([12345]))

    second.unregister(12345)
    expect(createRuntimeOwnershipStore(root).listOwnedPids()).toEqual(new Set())
  })

  it('prunes records for PIDs that are no longer detected as DSH Runtimes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-owner-prune-'))
    roots.push(root)
    const store = createRuntimeOwnershipStore(root)
    store.register(12345)
    store.register(67890)

    store.prune(new Set([12345]))

    expect(store.listOwnedPids()).toEqual(new Set([12345]))
  })
})
