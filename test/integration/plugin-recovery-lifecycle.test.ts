import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginRecoveryCoordinator } from '../../src/main/recovery/plugin-recovery-coordinator'
import { RecoveryManager } from '../../src/main/recovery/recovery-manager'
import { SafeModeController } from '../../src/main/runtime/safe-mode-home'
import type { RuntimeMode, RuntimePhase } from '../../src/main/runtime/runtime-types'
import { ensureUserDataLayout, getUserDataLayout } from '../../src/main/state/user-data'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('managed plugin recovery lifecycle', () => {
  it('recovers an original profile after a failed plugin boot through Safe Mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-plugin-lifecycle-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await ensureUserDataLayout(layout)
    const profileManifest = join(layout.harness, 'profiles', 'web', 'package.json')
    await mkdir(join(layout.harness, 'profiles', 'web'), { recursive: true })
    await writeFile(profileManifest, '{"dependencies":{"working-plugin":"1.0.0"}}\n')
    await writeFile(join(layout.harness, '.credentials.yaml'), 'providers: {}\n')
    await writeFile(join(layout.state, 'installed.json'), JSON.stringify([
      { kind: 'skill', id: 'agent-teams', version: '0.1.13', pluginPackageName: '@nanmicoder/dsh-agent-teams' },
    ]))
    const recovery = new RecoveryManager({
      layout,
      appVersion: '1.8.1536',
      dshRuntimeVersion: '0.1.1-rc.2',
    })
    await recovery.initialize()
    const safeMode = new SafeModeController({ layout })
    let phase: RuntimePhase = 'ready'
    let mode: RuntimeMode = 'normal'
    let normalStartFails = true
    const runtime = {
      snapshot: () => ({ phase, mode }),
      stop: async () => { phase = 'stopped' },
      start: async (context?: { mode?: RuntimeMode }) => {
        mode = context?.mode ?? 'normal'
        if (mode === 'normal' && normalStartFails) {
          phase = 'failed'
          throw new Error('broken plugin boot')
        }
        phase = 'ready'
      },
    }
    const coordinator = new PluginRecoveryCoordinator({ runtime, recovery, safeMode })

    await expect(coordinator.run({
      action: 'install',
      entryId: 'agent-teams',
      packageName: '@nanmicoder/dsh-agent-teams',
      profile: 'web',
    }, async () => {
      await writeFile(profileManifest, '{"dependencies":{"working-plugin":"1.0.0","broken-plugin":"9.9.9"}}\n')
    }, async () => undefined)).rejects.toThrow('broken plugin boot')

    expect(runtime.snapshot()).toEqual({ phase: 'ready', mode: 'safe' })
    await expect(readFile(join(safeMode.homePath(), 'profiles', 'web', 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const pending = recovery.snapshot().pendingTransaction
    expect(pending).toMatchObject({ kind: 'plugin-change', phase: 'failed' })

    await runtime.stop()
    await recovery.restore(pending!.snapshotName, false)
    await safeMode.disable()
    normalStartFails = false
    await runtime.start({ mode: 'normal' })
    await recovery.resolveRecovery()

    await expect(readFile(profileManifest, 'utf8')).resolves.toBe('{"dependencies":{"working-plugin":"1.0.0"}}\n')
    expect(runtime.snapshot()).toEqual({ phase: 'ready', mode: 'normal' })
    expect(recovery.snapshot().phase).toBe('idle')
  })
})
