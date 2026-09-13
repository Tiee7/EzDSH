import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type { RecoveryRestoreResult, RecoverySnapshot } from '../../main/recovery/recovery-manager.js'

interface RecoveryRestoreState {
  busy: boolean
  pendingRuntimeRestore?: RecoveryRestoreResult
  message?: string
  error?: string
}

export interface RecoveryRestoreFlow extends RecoveryRestoreState {
  restore(snapshot: RecoverySnapshot | string, refresh?: () => Promise<void>): Promise<boolean>
  retryRuntime(refresh?: () => Promise<void>): Promise<void>
  onRuntimeReady(): void
  clear(): void
}

function missingCredentialsNote(copy: AppCopy, paths: readonly string[]): string {
  if (paths.length === 0) return ''
  const kinds = paths.map((path): Parameters<AppCopy['settingsRecoveryCredentialLabel']>[0] => {
    switch (path) {
      case 'harness/.credentials.yaml': return 'model'
      case 'harness/.env': return 'environment'
      case 'harness/qq-bridge/config.json': return 'qq'
      case 'state/.workflow-credentials.json':
      case 'state/.workflow-credentials.json.key': return 'workflow'
      default: return 'other'
    }
  })
  return copy.settingsRecoveryMissingCredentials([...new Set(kinds)].map(copy.settingsRecoveryCredentialLabel))
}

/** Keep a restore and its startup retry alive when Runtime changes unmount settings. */
export function useRecoveryRestore(copy: AppCopy): RecoveryRestoreFlow {
  const [state, setState] = useState<RecoveryRestoreState>({ busy: false })
  const current = useRef(state)
  const generation = useRef(0)
  const publish = useCallback((next: RecoveryRestoreState): void => {
    current.current = next
    setState(next)
  }, [])
  const clear = useCallback((): void => {
    generation.current += 1
    publish({ busy: false })
  }, [publish])
  const onRuntimeReady = useCallback((): void => {
    if (!current.current.busy && current.current.pendingRuntimeRestore !== undefined) clear()
  }, [clear])

  useEffect(() => () => { generation.current += 1 }, [])

  const restartRestoredRuntime = async (result: RecoveryRestoreResult, operation: number, refresh?: () => Promise<void>): Promise<void> => {
    if (generation.current !== operation) return
    const runtime = await window.EzDSH.runtime.restart()
    if (generation.current !== operation) return
    if (runtime.phase !== 'ready') throw new Error(copy.settingsRecoveryRestoredRuntimeFailed)
    const remainingCredentials = missingCredentialsNote(copy, result.missingCredentials)
    publish({ busy: true, message: `${copy.settingsRecoveryRestored}${remainingCredentials === '' ? '' : ` ${remainingCredentials}`}` })
    try {
      await refresh?.()
    } catch {
      if (generation.current === operation) publish({ ...current.current, error: copy.settingsRecoveryRefreshFailed })
    }
  }

  const retryRuntime = async (refresh?: () => Promise<void>): Promise<void> => {
    const pending = current.current.pendingRuntimeRestore
    if (current.current.busy || pending === undefined) return
    const operation = ++generation.current
    publish({ busy: true, pendingRuntimeRestore: pending })
    try {
      await restartRestoredRuntime(pending, operation, refresh)
    } catch {
      if (generation.current === operation) publish({ ...current.current, error: copy.settingsRecoveryRestoredRuntimeFailed })
    } finally {
      if (generation.current === operation) publish({ ...current.current, busy: false })
    }
  }

  const restore = async (target: RecoverySnapshot | string, refresh?: () => Promise<void>): Promise<boolean> => {
    if (current.current.busy) return false
    const operation = ++generation.current
    publish({ busy: true, pendingRuntimeRestore: current.current.pendingRuntimeRestore })
    let restoreCompleted = false
    try {
      let snapshot: RecoverySnapshot
      if (typeof target === 'string') {
        const snapshots = await window.EzDSH.recovery.listSnapshots()
        if (generation.current !== operation) return false
        const selected = snapshots.find((item) => item.archiveName === target)
        if (selected === undefined) throw new Error(copy.recoverySnapshotUnavailable)
        snapshot = selected
      } else {
        snapshot = target
      }
      const preview = await window.EzDSH.recovery.restore(snapshot.archiveName, true)
      if (generation.current !== operation) return false
      if (!preview.dryRun || preview.snapshotName !== snapshot.archiveName) throw new Error(copy.settingsRecoveryInvalidResult)
      const credentialNote = missingCredentialsNote(copy, preview.missingCredentials)
      if (!window.confirm(copy.settingsRecoveryRestoreConfirm(snapshot.archiveName, snapshot.manifest.createdAt, credentialNote, snapshot.manifest.components.includes('workflow')))) return false
      if (generation.current !== operation) return false
      const result = await window.EzDSH.recovery.restore(snapshot.archiveName, false)
      if (generation.current !== operation) return false
      if (result.dryRun || result.snapshotName !== snapshot.archiveName) throw new Error(copy.settingsRecoveryInvalidResult)
      restoreCompleted = true
      publish({ busy: true, pendingRuntimeRestore: result })
      await restartRestoredRuntime(result, operation, refresh)
    } catch (reason) {
      if (generation.current === operation) publish({ ...current.current, error: restoreCompleted ? copy.settingsRecoveryRestoredRuntimeFailed : reason instanceof Error ? reason.message : copy.recoveryRestoreFailed })
    } finally {
      if (generation.current === operation) publish({ ...current.current, busy: false })
    }
    return restoreCompleted && generation.current === operation
  }

  return { ...state, restore, retryRuntime, onRuntimeReady, clear }
}
