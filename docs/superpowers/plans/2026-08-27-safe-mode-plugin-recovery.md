# Safe Mode and Plugin Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Give EzDSH a clean Safe Mode, managed-plugin backup and recovery, and compatibility evidence for update rollback.

**Architecture:** Safe Mode runs DSH in an EzDSH-owned clean home under state/safe-mode. It copies only credentials and never reads the original profiles, patches, sessions, or dependencies. A persisted recovery transaction points to a pre-change snapshot; a coordinator stops a live Runtime, applies a managed plugin mutation, restarts it, and launches Safe Mode if normal health fails. Catalog compatibility data is copied to the install registry and snapshot manifest.

**Tech Stack:** Electron, TypeScript, Node filesystem APIs, Vitest, React.

## Global Constraints

- Do not modify vendor/deepseek-harness.
- Safe Mode never changes layout.harness and copies only .credentials.yaml with 0600 permissions.
- Safe Mode excludes profiles, cordis.patch.yml, sessions, and third-party dependencies.
- Each Store-managed DSH plugin install, update, or uninstall creates a pre-plugin-change snapshot before mutation.
- Only a healthy normal Runtime clears a pending transaction. A Safe Mode boot never clears it.
- Unknown compatibility warns. A known incompatible DSH version blocks installation.
- Electron Updater remains responsible for application-binary rollback; EzDSH recovers data, profile, registry, and configuration.
- Use a failing focused Vitest test before each production implementation. Commit passing slices and do not stage the dirty vendor submodule.

---

## File Structure

- src/main/runtime/safe-mode-home.ts owns the temporary safe DSH home and persisted status.
- src/main/runtime/runtime-manager.ts carries a normal or safe launch context to the child process.
- src/main/recovery/recovery-manager.ts owns snapshots and one persisted recovery transaction.
- src/main/recovery/plugin-recovery-coordinator.ts owns stop, mutate, normal health check, and Safe Mode fallback.
- src/main/store/compatibility.ts evaluates plugin DSH version requirements.
- src/main/store/store-service.ts delegates managed DSH plugin mutations and persists compatibility provenance.
- shared contracts, preload, main index, RecoveryPanel, and StoreBrowser expose the lifecycle.

### Task 1: Isolated Safe Mode home and Runtime context

**Files:**
- Create: src/main/runtime/safe-mode-home.ts
- Create: test/runtime/safe-mode-home.test.ts
- Modify: src/main/runtime/runtime-manager.ts
- Modify: src/main/runtime/runtime-types.ts
- Modify: test/runtime/runtime-manager.test.ts

**Interfaces:**
- SafeModeController.initialize(), status(), enable(reason), disable().
- RuntimeLaunchContext = { mode?: 'normal' | 'safe'; dshHome?: string }.
- RuntimeManager.start(context?) and restart(context?).

- [ ] **Step 1: Write the failing isolation test**

~~~ts
it('creates Safe Mode with credentials but no plugin layers or sessions', async () => {
  await writeFile(join(layout.harness, '.credentials.yaml'), 'providers: {}\n', { mode: 0o600 })
  await mkdir(join(layout.harness, 'profiles', 'web'), { recursive: true })
  await writeFile(join(layout.harness, 'cordis.patch.yml'), 'plugins: broken\n')
  await mkdir(join(layout.harness, 'sessions'), { recursive: true })

  const enabled = await controller.enable('manual')

  await expect(readFile(join(enabled.dshHome, '.credentials.yaml'), 'utf8')).resolves.toBe('providers: {}\n')
  await expect(stat(join(enabled.dshHome, 'profiles'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(enabled.dshHome, 'cordis.patch.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(enabled.dshHome, 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' })
})
~~~

- [ ] **Step 2: Run the failing test**

Run: npm test -- --run test/runtime/safe-mode-home.test.ts

Expected: FAIL because the controller module does not exist.

- [ ] **Step 3: Implement the minimal controller**

~~~ts
export type SafeModeReason = 'manual' | 'plugin-recovery' | 'update-recovery' | 'runtime-recovery'

export interface SafeModeStatus {
  readonly active: boolean
  readonly reason?: SafeModeReason
  readonly activatedAt?: string
  readonly excludedPluginCount: number
}

async enable(reason: SafeModeReason): Promise<{ status: SafeModeStatus; dshHome: string }> {
  await rm(this.safeHome, { recursive: true, force: true })
  await mkdir(this.safeHome, { recursive: true, mode: 0o700 })
  if (await pathExists(this.credentialsSource)) {
    await copyFile(this.credentialsSource, join(this.safeHome, '.credentials.yaml'))
    await chmod(join(this.safeHome, '.credentials.yaml'), 0o600)
  }
  const status = { active: true, reason, activatedAt: this.now().toISOString(), excludedPluginCount: await this.pluginCount() }
  await writeAtomic(this.statusPath, JSON.stringify(status), 0o600)
  return { status, dshHome: this.safeHome }
}
~~~

pluginCount reads state/installed.json defensively. disable removes only the owned safe home and status file.

- [ ] **Step 4: Run the passing isolation test**

Run: npm test -- --run test/runtime/safe-mode-home.test.ts

Expected: PASS.

- [ ] **Step 5: Write the failing Runtime context test**

~~~ts
it('uses a supplied safe DSH home and exposes safe mode', async () => {
  const manager = createManager({ allocatePort: async () => 43123 })
  await manager.start({ mode: 'safe', dshHome: '/tmp/ezdsh-safe-home' })

  expect(spawnProcess).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
    env: expect.objectContaining({ DSH_HOME: '/tmp/ezdsh-safe-home' }),
  }))
  expect(manager.snapshot().mode).toBe('safe')
})
~~~

- [ ] **Step 6: Run the failing Runtime test**

Run: npm test -- --run test/runtime/runtime-manager.test.ts

Expected: FAIL because RuntimeSnapshot has no mode and start accepts no context.

- [ ] **Step 7: Implement context-aware startup**

~~~ts
export interface RuntimeLaunchContext {
  readonly mode?: 'normal' | 'safe'
  readonly dshHome?: string
}

async start(context: RuntimeLaunchContext = {}): Promise<RuntimeSnapshot> {
  this.launchContext = {
    mode: context.mode ?? 'normal',
    dshHome: context.dshHome ?? this.config.layout.harness,
  }
  return this.startInternal()
}
~~~

Require dshHome for safe mode, set snapshot.mode for every phase, use selected home as DSH_HOME, and reject switching homes while a Runtime is ready.

- [ ] **Step 8: Verify and commit**

Run: npm test -- --run test/runtime/runtime-manager.test.ts test/runtime/safe-mode-home.test.ts && npm run typecheck

Expected: PASS.

~~~bash
git add src/main/runtime/safe-mode-home.ts src/main/runtime/runtime-manager.ts src/main/runtime/runtime-types.ts test/runtime/safe-mode-home.test.ts test/runtime/runtime-manager.test.ts
git commit -m "feat: add isolated DSH safe mode runtime"
git push
~~~

### Task 2: Generalized recovery transaction and pre-plugin snapshot

**Files:**
- Modify: src/main/recovery/recovery-manager.ts
- Modify: test/recovery/recovery-manager.test.ts

**Interfaces:**
- RecoveryTransaction has kind update or plugin-change, phase, snapshot name, timestamps, source versions, and optional affected plugin.
- RecoveryManager adds preparePluginChange, abortPendingTransaction, completePendingTransaction, hasPendingTransaction, and markBootFailure.
- prepareUpdate and completeUpdate remain backwards-compatible wrappers.

- [ ] **Step 1: Write the failing transaction test**

~~~ts
it('creates a plugin snapshot and requests recovery after the next boot fails', async () => {
  const pending = await manager.preparePluginChange({
    action: 'install', entryId: 'agent-teams', packageName: '@nanmicoder/dsh-agent-teams', profile: 'web',
  })

  expect(pending.kind).toBe('plugin-change')
  expect(pending.snapshotName).toMatch(/^ezdsh-pre-plugin-change-/)
  expect((await manager.markBootFailure('plugin crashed')).phase).toBe('recovery-required')
  expect(manager.snapshot().pendingTransaction?.affectedPlugin?.entryId).toBe('agent-teams')
})
~~~

- [ ] **Step 2: Run the failing test**

Run: npm test -- --run test/recovery/recovery-manager.test.ts

Expected: FAIL because preparePluginChange and pendingTransaction do not exist.

- [ ] **Step 3: Implement the persisted discriminated transaction**

~~~ts
export type RecoverySnapshotKind = 'manual' | 'pre-update' | 'pre-plugin-change' | 'pre-restore'

export interface RecoveryTransaction {
  readonly id: string
  readonly kind: 'update' | 'plugin-change'
  readonly phase: 'prepared' | 'failed'
  readonly snapshotName: string
  readonly fromAppVersion: string
  readonly preparedAt: string
  readonly targetAppVersion?: string
  readonly affectedPlugin?: {
    readonly action: 'install' | 'update' | 'uninstall'
    readonly entryId: string
    readonly packageName: string
    readonly profile: string
  }
  readonly error?: string
}
~~~

Persist this atomically in the existing transaction file. Convert legacy update-shaped files to kind update on read. Extend snapshot validation and rotation for pre-plugin-change. preparePluginChange snapshots first; abort removes an installer-command transaction; complete removes only a healthy transaction; markBootFailure only changes an existing transaction.

- [ ] **Step 4: Verify and commit**

Run: npm test -- --run test/recovery/recovery-manager.test.ts && npm run typecheck

Expected: PASS.

~~~bash
git add src/main/recovery/recovery-manager.ts test/recovery/recovery-manager.test.ts
git commit -m "feat: track plugin recovery transactions"
git push
~~~

### Task 3: Transactional plugin change with health-aware fallback

**Files:**
- Create: src/main/recovery/plugin-recovery-coordinator.ts
- Create: test/recovery/plugin-recovery-coordinator.test.ts
- Modify: src/main/store/store-service.ts
- Modify: src/shared/store.ts
- Modify: test/store/store-service-install.test.ts
- Modify: src/main/index.ts

**Interfaces:**
- PluginRecoveryCoordinator.run(input, mutate) returns { value, transactionId }.
- StoreService uses it only for DSH plugin entries or plugin registry records.
- InstallState adds recoveryTransactionId.

- [ ] **Step 1: Write the failing coordinator test**

~~~ts
it('enters Safe Mode after a plugin restart fails', async () => {
  runtime.snapshot.mockReturnValue({ phase: 'ready', mode: 'normal' })
  runtime.start.mockRejectedValueOnce(new Error('plugin boot failure'))

  await expect(coordinator.run(pluginChange, async () => undefined)).rejects.toThrow('plugin boot failure')

  expect(recovery.preparePluginChange).toHaveBeenCalledWith(pluginChange)
  expect(recovery.markBootFailure).toHaveBeenCalledWith('plugin boot failure')
  expect(safeMode.enable).toHaveBeenCalledWith('plugin-recovery')
  expect(runtime.start).toHaveBeenLastCalledWith({ mode: 'safe', dshHome: '/state/safe-mode/harness' })
})
~~~

- [ ] **Step 2: Run the failing coordinator test**

Run: npm test -- --run test/recovery/plugin-recovery-coordinator.test.ts

Expected: FAIL because the coordinator module does not exist.

- [ ] **Step 3: Implement ordered lifecycle**

~~~ts
async run<T>(input: PluginChangeInput, mutate: () => Promise<T>): Promise<{ value: T; transactionId: string }> {
  const wasRunning = this.runtime.snapshot().phase === 'ready'
  if (wasRunning) await this.runtime.stop()
  const transaction = await this.recovery.preparePluginChange(input)
  try {
    const value = await mutate()
    if (wasRunning) {
      await this.runtime.start({ mode: 'normal' })
      await this.recovery.completePendingTransaction()
    }
    return { value, transactionId: transaction.id }
  } catch (error) {
    if (await this.recovery.hasPendingTransaction()) {
      const state = await this.recovery.markBootFailure(messageOf(error))
      if (state.phase === 'recovery-required') await this.startSafeMode('plugin-recovery')
    }
    throw error
  }
}
~~~

If the installer command fails before mutation completion, call abortPendingTransaction instead of marking recovery-required. A failed normal health check retains the transaction and starts Safe Mode but does not restore automatically.

- [ ] **Step 4: Write and run failing Store delegation test**

~~~ts
it('routes a DSH plugin install through recovery', async () => {
  const state = await service.confirmInstall('skill', 'agent-teams', true)
  expect(coordinator.run).toHaveBeenCalledWith(expect.objectContaining({ action: 'install', entryId: 'agent-teams' }), expect.any(Function))
  expect(state).toMatchObject({ phase: 'done', recoveryTransactionId: 'txn-1' })
})
~~~

Run: npm test -- --run test/store/store-service-install.test.ts

Expected: FAIL because StoreService has no coordinator.

- [ ] **Step 5: Integrate Store and main Runtime events**

Wrap DSH plugin install, uninstall, and a new atomic StoreService.update(kind, id) in the coordinator. Keep ordinary skills, presets, and MCP entries unchanged. Wire the coordinator after RecoveryManager and RuntimeManager initialize. Normal ready completes a transaction, safe ready does not. Normal failed invokes markBootFailure and starts Safe Mode only for recovery-required state.

- [ ] **Step 6: Verify and commit**

Run: npm test -- --run test/recovery/plugin-recovery-coordinator.test.ts test/store/store-service-install.test.ts && npm run typecheck

Expected: PASS.

~~~bash
git add src/main/recovery/plugin-recovery-coordinator.ts test/recovery/plugin-recovery-coordinator.test.ts src/main/store/store-service.ts src/shared/store.ts test/store/store-service-install.test.ts src/main/index.ts
git commit -m "feat: recover managed plugin changes in safe mode"
git push
~~~

### Task 4: Compatibility-aware installation and rollback evidence

**Files:**
- Create: src/main/store/compatibility.ts
- Create: test/store/compatibility.test.ts
- Modify: src/shared/store.ts
- Modify: src/main/store/store-service.ts
- Modify: src/main/recovery/recovery-manager.ts
- Modify: test/recovery/recovery-manager.test.ts

**Interfaces:**
- assessPluginCompatibility(runtimeVersion, requirements) returns compatible, incompatible, or unknown.
- StorePluginConfig gets optional minDshVersion and maxDshVersion limits.
- Installed plugin records capture source, limits, and assessment.
- RecoveryManifest gets optional compatibilityInventory without breaking old manifests.

- [ ] **Step 1: Write the failing evaluator test**

~~~ts
it.each([
  ['0.6.0', { minDshVersion: '0.5.0', maxDshVersion: '0.6.9' }, 'compatible'],
  ['0.4.9', { minDshVersion: '0.5.0' }, 'incompatible'],
  ['0.7.0-rc.1', { maxDshVersion: '0.6.9' }, 'incompatible'],
  ['0.6.0', undefined, 'unknown'],
] as const)('assesses %s', (runtime, limits, status) => {
  expect(assessPluginCompatibility(runtime, limits).status).toBe(status)
})
~~~

- [ ] **Step 2: Run the failing test**

Run: npm test -- --run test/store/compatibility.test.ts

Expected: FAIL because compatibility.ts does not exist.

- [ ] **Step 3: Implement assessment and registry evidence**

~~~ts
export interface PluginCompatibilityAssessment {
  readonly status: 'compatible' | 'incompatible' | 'unknown'
  readonly runtimeVersion: string
  readonly reason: string
}

export function assessPluginCompatibility(runtimeVersion: string, limits?: PluginCompatibilityRequirements): PluginCompatibilityAssessment {
  if (limits === undefined || (limits.minDshVersion === undefined && limits.maxDshVersion === undefined)) {
    return { status: 'unknown', runtimeVersion, reason: 'The catalog does not declare a DSH runtime range.' }
  }
  // Compare numeric dot components and treat a release as newer than its same-number prerelease.
}
~~~

Block known incompatible installation with failureReason incompatible. Persist plugin source, limits, and assessment. Include a compatibility inventory in new snapshot manifests while retaining pluginInventory and accepting manifests written without the new field.

- [ ] **Step 4: Verify and commit**

Run: npm test -- --run test/store/compatibility.test.ts test/store/store-service-install.test.ts test/recovery/recovery-manager.test.ts && npm run typecheck

Expected: PASS.

~~~bash
git add src/main/store/compatibility.ts test/store/compatibility.test.ts src/shared/store.ts src/main/store/store-service.ts src/main/recovery/recovery-manager.ts test/recovery/recovery-manager.test.ts
git commit -m "feat: track DSH plugin compatibility evidence"
git push
~~~

### Task 5: Recovery controls and Store warnings

**Files:**
- Modify: src/shared/contracts.ts
- Modify: src/preload/index.ts
- Modify: src/main/index.ts
- Modify: src/renderer/recovery/RecoveryPanel.tsx
- Modify: src/renderer/recovery/recovery.css
- Modify: src/renderer/store/StoreBrowser.tsx
- Modify: test/preload/index.test.ts
- Modify: test/renderer/recovery-panel.test.tsx
- Modify: test/renderer/store-browser.test.tsx

**Interfaces:**
- Recovery bridge adds enterSafeMode(), exitSafeMode(), rollbackPendingPlugin().
- Store bridge adds update(kind, id).
- Recovery view renders Runtime mode, Safe Mode reason, affected plugin, snapshot, and rollback action.

- [ ] **Step 1: Write the failing Recovery Panel test**

~~~tsx
it('starts Safe Mode and rolls back a pending plugin', async () => {
  mockRecovery.getStatus.mockResolvedValue({
    phase: 'recovery-required',
    pendingTransaction: {
      kind: 'plugin-change',
      snapshotName: 'ezdsh-pre-plugin-change-a.tar.gz',
      affectedPlugin: { entryId: 'agent-teams', action: 'install', packageName: '@nanmicoder/dsh-agent-teams', profile: 'web' },
    },
  })
  render(<RecoveryPanel />)

  await userEvent.click(await screen.findByRole('button', { name: '以安全模式启动' }))
  expect(mockRecovery.enterSafeMode).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByRole('button', { name: '回滚此插件变更' }))
  expect(mockRecovery.rollbackPendingPlugin).toHaveBeenCalledTimes(1)
})
~~~

- [ ] **Step 2: Run the failing test**

Run: npm test -- --run test/renderer/recovery-panel.test.tsx

Expected: FAIL because the actions and buttons do not exist.

- [ ] **Step 3: Implement IPC and UI**

~~~ts
ipcMain.handle('recovery:rollback-pending-plugin', async () => {
  const pending = recoveryManager.snapshot().pendingTransaction
  if (pending?.kind !== 'plugin-change') throw new Error('No pending plugin change can be rolled back')
  await runtimeManager.stop()
  const result = await recoveryManager.restore(pending.snapshotName, false)
  await recoveryManager.resolveRecovery()
  await safeMode.disable()
  await runtimeManager.start({ mode: 'normal' })
  return result
})
~~~

enterSafeMode stops normal Runtime, creates safe home with manual reason, then starts it. exitSafeMode stops safe Runtime, removes only safe files, then starts normal. Always render Safe Mode. For a recovery-required plugin transaction render the Chinese rollback button. Replace Store's current uninstall-then-install update click with one store.update call. Render unknown compatibility as yellow non-blocking text.

- [ ] **Step 4: Verify and commit**

Run: npm test -- --run test/preload/index.test.ts test/renderer/recovery-panel.test.tsx test/renderer/store-browser.test.tsx && npm run typecheck

Expected: PASS.

~~~bash
git add src/shared/contracts.ts src/preload/index.ts src/main/index.ts src/renderer/recovery/RecoveryPanel.tsx src/renderer/recovery/recovery.css src/renderer/store/StoreBrowser.tsx test/preload/index.test.ts test/renderer/recovery-panel.test.tsx test/renderer/store-browser.test.tsx
git commit -m "feat: expose safe mode plugin rollback controls"
git push
~~~

### Task 6: Verify lifecycle and document rollback boundary

**Files:**
- Create: test/integration/plugin-recovery-lifecycle.test.ts
- Modify: docs/architecture.md
- Modify: docs/release-manual.md

- [ ] **Step 1: Write the failing lifecycle test**

~~~ts
it('keeps the original home intact while recovering a failed managed plugin', async () => {
  await coordinator.run(pluginChange, installBrokenPlugin)
  expect(runtime.snapshot().mode).toBe('safe')

  await rollbackPendingPlugin()

  await expect(readFile(profileManifest, 'utf8')).resolves.not.toContain('broken-plugin')
  expect(runtime.snapshot().mode).toBe('normal')
})
~~~

- [ ] **Step 2: Run the failing lifecycle test**

Run: npm test -- --run test/integration/plugin-recovery-lifecycle.test.ts

Expected: FAIL until the collaborating production interfaces are wired.

- [ ] **Step 3: Add deterministic test adapters**

Inject filesystem roots, clock, Runtime health outcomes, and DSH installer runner. Do not spawn Electron or download packages; assert the transition and restored profile content.

- [ ] **Step 4: Verify all code**

Run: npm test -- --run && npm run typecheck && npm run build

Expected: all Vitest files pass, TypeScript passes, and production bundles build.

- [ ] **Step 5: Document operation**

Add Plugin Safe Mode and Recovery to architecture. State that Safe Mode is credentials-only, original harness is untouched, an affected transaction names its exact rollback snapshot, and Electron application binaries are not rolled back. Add release-manual checks for snapshot creation, forced health failure, Safe Mode, rollback, and normal launch.

- [ ] **Step 6: Commit**

~~~bash
git add test/integration/plugin-recovery-lifecycle.test.ts docs/architecture.md docs/release-manual.md
git commit -m "test: cover plugin safe mode recovery lifecycle"
git push
~~~

## Self-Review

**Spec coverage:** Task 1 supplies Safe Mode. Tasks 2 and 3 provide backup, normal health verification, Safe Mode fallback, and plugin rollback. Task 4 records compatibility evidence. Task 5 makes recovery actionable. Task 6 verifies the lifecycle and documents the binary rollback boundary.

**Placeholder scan:** The plan names concrete files, interfaces, tests, commands, and outcomes for every implementation slice.

**Type consistency:** SafeModeController.enable returns the home consumed by RuntimeManager.start. RecoveryTransaction is RecoveryState.pendingTransaction. The coordinator creates it; IPC and Store state surface it. Safe Mode ready never completes it.
