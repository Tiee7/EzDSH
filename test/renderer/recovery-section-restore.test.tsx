import { createWindow } from '@mixmark-io/domino'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { useRecoveryRestore, type RecoveryRestoreFlow } from '../../src/renderer/recovery/useRecoveryRestore'
import { RecoveryRestoreFeedback } from '../../src/renderer/recovery/RecoveryRestoreFeedback'
import { RecoverySection } from '../../src/renderer/settings/RecoverySection'
import { getAppCopy } from '../../src/shared/locale'
import type { RecoveryDryRun, RecoveryRestoreResult, RecoverySnapshot } from '../../src/main/recovery/recovery-manager'
import type { RuntimeSnapshot } from '../../src/main/runtime/runtime-types'

const snapshot: RecoverySnapshot = {
  archiveName: 'ezdsh-manual-20260913080100000.tar.gz',
  archivePath: '/backups/selected.tar.gz', checksumPath: '/backups/selected.sha256', manifestPath: '/backups/selected.json',
  manifest: {
    formatVersion: 1, kind: 'manual', reason: 'manual', note: 'Before plugin upgrade',
    createdAt: '2026-09-13T08:01:00.000Z', appVersion: '1.8.1550', dshRuntimeVersion: '0.1.5-rc.1', dataSchemaVersion: 1,
    archiveName: 'ezdsh-manual-20260913080100000.tar.gz', sha256: 'abc', components: ['harness', 'state', 'workflow'],
    redactedFiles: [], pluginInventory: [],
  },
}
const preview: RecoveryDryRun = { dryRun: true, snapshotName: snapshot.archiveName, entries: ['harness/', 'state/', 'workflow/'], redactedFiles: [], missingCredentials: [], preflight: [] }
const restored: RecoveryRestoreResult = { dryRun: false, snapshotName: snapshot.archiveName, restoredAt: '2026-09-13T09:00:00.000Z', preRestoreSnapshotName: 'current-before-restore.tar.gz', missingCredentials: [], entries: preview.entries }
const ready: RuntimeSnapshot = { phase: 'ready', mode: 'normal', launchDirectory: '/workspace', logPath: '/logs/runtime.log' }

async function withSection(run: (h: Awaited<ReturnType<typeof mount>>) => Promise<void>, locale: 'zh' | 'en' = 'zh', selected = snapshot) {
  const h = await mount(locale, selected)
  try { await run(h) } finally { await h.cleanup() }
}

async function mount(locale: 'zh' | 'en', selected: RecoverySnapshot, restoreFlow?: unknown) {
  const previous = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const api = {
    listSnapshots: vi.fn(async () => [selected]),
    restore: vi.fn(async (_name: string, dryRun: boolean): Promise<RecoveryDryRun | RecoveryRestoreResult> => dryRun ? preview : restored),
    createSnapshot: vi.fn(async () => snapshot),
    restart: vi.fn(async (): Promise<RuntimeSnapshot> => ready),
  }
  const confirm = vi.fn((_message: string) => true)
  Object.assign(dom, { EzDSH: { recovery: api, runtime: { restart: api.restart } }, confirm })
  const root = createRoot(dom.document.getElementById('root')!)
  const copy = getAppCopy(locale)
  let sharedFlow: RecoveryRestoreFlow | undefined
  function SharedFlowHarness({ showSection }: { showSection: boolean }) {
    sharedFlow = useRecoveryRestore(copy)
    return showSection
      ? <RecoverySection copy={copy} restoreFlow={sharedFlow} />
      : <RecoveryRestoreFeedback copy={copy} flow={sharedFlow} />
  }
  await act(async () => { root.render(restoreFlow === 'managed'
    ? <SharedFlowHarness showSection />
    : <RecoverySection copy={copy} restoreFlow={restoreFlow as never} />) })
  const click = async (label: string) => {
    const button = (Array.from(dom.document.querySelectorAll('button')) as HTMLButtonElement[]).filter((item) => item.textContent?.trim() === label).at(-1)
    if (!button) throw new Error(`Missing button: ${label}`)
    await act(async () => { button.click() })
  }
  return {
    api, confirm, dom, copy, click, restore: () => click(copy.settingsRecoveryRestore),
    flow: () => sharedFlow!,
    showSection: (showSection: boolean) => act(async () => { root.render(<SharedFlowHarness showSection={showSection} />) }),
    alert: () => dom.document.querySelector('[role="alert"]')?.textContent,
    status: () => dom.document.querySelector('[role="status"]')?.textContent,
    cleanup: async () => {
      await act(async () => { root.unmount() })
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[key]
        else Object.defineProperty(globalThis, key, descriptor)
      }
    },
  }
}

describe('RecoverySection backup restore flow', () => {
  it.each([
    ['zh', ['会话、设置、凭据、插件和工作流数据', '另存当前状态', '应用版本不会回退'], '备份已还原，Runtime 已启动。'],
    ['en', ['sessions, settings, credentials, plugins, and workflow data', 'save the current state', 'app version will not be downgraded'], 'Backup restored. Runtime has started.'],
  ] as const)('explains the selected backup and replacement in %s, then verifies Runtime before reporting success', async (locale, expected, success) => {
    await withSection(async (h) => {
      await h.restore()
      expect(h.confirm).toHaveBeenCalledOnce()
      const confirmation = h.confirm.mock.calls[0]![0] as string
      expect(confirmation).toContain(snapshot.archiveName)
      expect(confirmation).toContain(snapshot.manifest.createdAt)
      for (const phrase of expected) expect(confirmation).toContain(phrase)
      expect(confirmation).not.toMatch(/harness|entries will replace/u)
      expect(h.api.restore.mock.calls).toEqual([[snapshot.archiveName, true], [snapshot.archiveName, false]])
      expect(h.api.restart).toHaveBeenCalledOnce()
      expect(h.status()).toBe(success)
      expect(h.dom.document.body.textContent).not.toContain(h.copy.settingsRecoveryCreated)
      expect(h.status()).not.toMatch(/所有|all services/iu)
    }, locale)
  })

  it.each([
    ['zh', ['需要重新授权或填写', '模型及插件凭据', '环境变量', 'QQ 连接配置', '工作流凭据', '其他凭据']],
    ['en', ['sign in again or re-enter', 'Model and plugin credentials', 'Environment variables', 'QQ connection settings', 'Workflow credentials', 'Other credentials']],
  ] as const)('explains missing credential categories in %s without showing sensitive file paths', async (locale, expected) => {
    await withSection(async (h) => {
      h.api.restore.mockResolvedValueOnce({ ...preview, missingCredentials: ['harness/.credentials.yaml', 'harness/.env', 'harness/qq-bridge/config.json', 'state/.workflow-credentials.json', 'state/.workflow-credentials.json.key', 'custom/private-key.json'] })
      h.confirm.mockReturnValueOnce(false)
      await h.restore()
      const confirmation = h.confirm.mock.calls[0]![0] as string
      for (const phrase of expected) expect(confirmation).toContain(phrase)
      expect(confirmation).not.toMatch(/\.credentials|\.env|\.workflow|private-key|qq-bridge/u)
      expect(confirmation.split(expected[4]!).length).toBe(2)
      expect(h.api.restore).toHaveBeenCalledOnce()
      expect(h.api.restart).not.toHaveBeenCalled()
    }, locale)
  })


  it.each([
    ['zh', '工作流配置和记录', '备份不包含工作流工作文件，现有工作文件会保留'],
    ['en', 'workflow settings and records', 'does not include workflow working files; existing working files will be kept'],
  ] as const)('describes the narrower working-file scope of an older backup in %s', async (locale, replaced, kept) => {
    await withSection(async (h) => {
      h.confirm.mockReturnValueOnce(false)
      await h.restore()
      const confirmation = h.confirm.mock.calls[0]![0]
      expect(confirmation).toContain(replaced)
      expect(confirmation).toContain(kept)
      expect(h.api.restore).toHaveBeenCalledOnce()
      expect(h.api.restart).not.toHaveBeenCalled()
    }, locale, { ...snapshot, manifest: { ...snapshot.manifest, components: ['harness', 'state'] } })
  })


  it('uses the App-owned restore flow and feedback instead of starting a component-local restore', async () => {
    const shared = { busy: false, pendingRuntimeRestore: restored, message: undefined, error: 'Data restored; startup needs retry', restore: vi.fn(async () => {}), retryRuntime: vi.fn(async () => {}), onRuntimeReady: vi.fn(), clear: vi.fn() }
    const h = await mount('en', snapshot, shared)
    try {
      expect(h.alert()).toBe(shared.error)
      await h.click('Retry startup')
      expect(shared.retryRuntime).toHaveBeenCalledOnce()
      await h.restore()
      expect(shared.restore).toHaveBeenCalledWith(snapshot, expect.any(Function))
      expect(h.api.restore).not.toHaveBeenCalled()
      expect(h.api.restart).not.toHaveBeenCalled()
    } finally { await h.cleanup() }
  })


  it('retains restore progress and startup retry when settings unmounts', async () => {
    const h = await mount('en', snapshot, 'managed')
    let finishRestore!: (value: RecoveryRestoreResult) => void
    const restoring = new Promise<RecoveryRestoreResult>((resolve) => { finishRestore = resolve })
    try {
      h.api.restore.mockResolvedValueOnce(preview).mockImplementationOnce(() => restoring)
      h.api.restart.mockResolvedValueOnce({ ...ready, phase: 'failed' })
      await h.restore()
      expect(h.flow().busy).toBe(true)
      await h.showSection(false)
      await act(async () => { finishRestore(restored) })
      expect(h.alert()).toContain('Backup restored, but Runtime has not started')
      expect(h.flow().busy).toBe(false)
      await h.click('Retry startup')
      expect(h.status()).toBe('Backup restored. Runtime has started.')
      expect(h.api.restore).toHaveBeenCalledTimes(2)
      expect(h.api.restart).toHaveBeenCalledTimes(2)
      await h.showSection(true)
      expect(h.status()).toBe('Backup restored. Runtime has started.')
    } finally { await h.cleanup() }
  })

  it.each(['preview', 'restore', 'startup'] as const)('clearing on workspace change ignores a late %s result', async (stage) => {
    const h = await mount('en', snapshot, 'managed')
    let finish!: (value: any) => void
    const pending = new Promise<any>((resolve) => { finish = resolve })
    try {
      const clear = h.flow().clear
      if (stage === 'preview') h.api.restore.mockImplementationOnce(() => pending)
      else if (stage === 'restore') h.api.restore.mockResolvedValueOnce(preview).mockImplementationOnce(() => pending)
      else h.api.restart.mockImplementationOnce(() => pending)
      await h.restore()
      expect(h.flow().busy).toBe(true)
      expect(h.flow().clear).toBe(clear)
      await act(async () => { clear() })
      expect(h.flow().busy).toBe(false)
      expect(h.flow().pendingRuntimeRestore).toBeUndefined()
      await act(async () => { finish(stage === 'preview' ? preview : stage === 'restore' ? restored : ready) })
      expect(h.api.restore).toHaveBeenCalledTimes(stage === 'preview' ? 1 : 2)
      expect(h.api.restart).toHaveBeenCalledTimes(stage === 'startup' ? 1 : 0)
      expect(h.confirm).toHaveBeenCalledTimes(stage === 'preview' ? 0 : 1)
      expect(h.alert()).toBeUndefined()
      expect(h.status()).toBeUndefined()
      expect(h.flow().busy).toBe(false)
      expect(h.flow().clear).toBe(clear)
    } finally { await h.cleanup() }
  })

  it('canceling a different restore keeps the previous completed restore available for startup retry', async () => {
    const h = await mount('en', snapshot, 'managed')
    try {
      h.api.restart.mockResolvedValueOnce({ ...ready, phase: 'failed' })
      await h.restore()
      h.confirm.mockReturnValueOnce(false)
      await h.restore()
      expect(h.flow().pendingRuntimeRestore).toEqual(restored)
      await h.click('Retry startup')
      expect(h.api.restore.mock.calls.filter(([, dryRun]) => !dryRun)).toHaveLength(1)
      expect(h.api.restart).toHaveBeenCalledTimes(2)
      expect(h.status()).toBe('Backup restored. Runtime has started.')
    } finally { await h.cleanup() }
  })


  it('clears stale startup failure after Runtime becomes ready through another recovery action', async () => {
    const h = await mount('en', snapshot, 'managed')
    try {
      const onRuntimeReady = h.flow().onRuntimeReady
      h.api.restart.mockResolvedValueOnce({ ...ready, phase: 'failed' })
      await h.restore()
      expect(h.flow().pendingRuntimeRestore).toEqual(restored)
      expect(h.alert()).toContain('Backup restored, but Runtime has not started')
      expect(h.flow().onRuntimeReady).toBe(onRuntimeReady)
      await act(async () => { onRuntimeReady() })
      expect(h.flow().pendingRuntimeRestore).toBeUndefined()
      expect(h.alert()).toBeUndefined()
      expect(h.dom.document.body.textContent).not.toContain('Retry startup')
      expect(h.api.restore).toHaveBeenCalledTimes(2)
      expect(h.api.restart).toHaveBeenCalledOnce()
      expect(h.flow().onRuntimeReady).toBe(onRuntimeReady)
    } finally { await h.cleanup() }
  })

  it('lets its own active restore finish when a Runtime ready event arrives first', async () => {
    const h = await mount('en', snapshot, 'managed')
    let finishStartup!: (value: RuntimeSnapshot) => void
    const startup = new Promise<RuntimeSnapshot>((resolve) => { finishStartup = resolve })
    try {
      h.api.restart.mockImplementationOnce(() => startup)
      await h.restore()
      expect(h.flow().busy).toBe(true)
      expect(h.flow().pendingRuntimeRestore).toEqual(restored)
      await act(async () => { h.flow().onRuntimeReady() })
      expect(h.flow().busy).toBe(true)
      expect(h.flow().pendingRuntimeRestore).toEqual(restored)
      await act(async () => { finishStartup(ready) })
      expect(h.flow().busy).toBe(false)
      expect(h.flow().pendingRuntimeRestore).toBeUndefined()
      expect(h.status()).toBe('Backup restored. Runtime has started.')
      expect(h.alert()).toBeUndefined()
    } finally { await h.cleanup() }
  })

  it('canceling confirmation leaves user data and Runtime untouched', async () => {
    await withSection(async (h) => {
      h.confirm.mockReturnValueOnce(false)
      await h.restore()
      expect(h.api.restore.mock.calls).toEqual([[snapshot.archiveName, true]])
      expect(h.api.restart).not.toHaveBeenCalled()
      expect(h.alert()).toBeUndefined()
      expect(h.status()).toBeUndefined()
    })
  })

  it('does not ask for confirmation or write after preview fails', async () => {
    await withSection(async (h) => {
      h.api.restore.mockRejectedValueOnce(new Error('Checksum mismatch'))
      await h.restore()
      expect(h.confirm).not.toHaveBeenCalled()
      expect(h.api.restore).toHaveBeenCalledOnce()
      expect(h.api.restart).not.toHaveBeenCalled()
      expect(h.alert()).toContain('Checksum mismatch')
      expect(h.status()).toBeUndefined()
    })
  })

  it('rejects an invalid preview without writing or restarting', async () => {
    await withSection(async (h) => {
      h.api.restore.mockResolvedValueOnce(restored)
      await h.restore()
      expect(h.confirm).not.toHaveBeenCalled()
      expect(h.api.restore).toHaveBeenCalledOnce()
      expect(h.api.restart).not.toHaveBeenCalled()
      expect(h.alert()).toContain('未返回预期结果')
      expect(h.status()).toBeUndefined()
    })
  })

  it('does not restart or report success when the restore fails', async () => {
    await withSection(async (h) => {
      h.api.restore.mockResolvedValueOnce(preview).mockRejectedValueOnce(new Error('Failed to save current state'))
      await h.restore()
      expect(h.api.restore).toHaveBeenCalledTimes(2)
      expect(h.api.restart).not.toHaveBeenCalled()
      expect(h.alert()).toContain('Failed to save current state')
      expect(h.status()).toBeUndefined()
    })
  })

  it.each(['failed', 'starting', 'stopped'] as const)('does not claim success when Runtime returns %s after restoring', async (phase) => {
    await withSection(async (h) => {
      h.api.restart.mockResolvedValueOnce({ ...ready, phase })
      await h.restore()
      expect(h.api.restart).toHaveBeenCalledOnce()
      expect(h.alert()).toContain('备份已还原，但 Runtime 暂未启动')
      expect(h.status()).toBeUndefined()
    })
  })

  it('explains that data was already restored when restarting rejects', async () => {
    await withSection(async (h) => {
      h.api.restart.mockRejectedValueOnce(new Error('Cannot spawn runtime'))
      await h.restore()
      expect(h.alert()).toContain('Backup restored, but Runtime has not started')
      expect(h.status()).toBeUndefined()
    }, 'en')
  })


  it('retries Runtime in place after a completed restore without replacing data again', async () => {
    await withSection(async (h) => {
      h.api.restart.mockResolvedValueOnce({ ...ready, phase: 'failed' })
      await h.restore()
      await h.click('重试启动')
      expect(h.api.restore.mock.calls).toEqual([[snapshot.archiveName, true], [snapshot.archiveName, false]])
      expect(h.confirm).toHaveBeenCalledOnce()
      expect(h.api.restart).toHaveBeenCalledTimes(2)
      expect(h.status()).toBe('备份已还原，Runtime 已启动。')
      expect(h.alert()).toBeUndefined()
      expect(h.dom.document.body.textContent).not.toContain('重试启动')
    })
  })

  it('keeps Runtime retry available after another failure and preserves missing-credential guidance', async () => {
    await withSection(async (h) => {
      h.api.restore.mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...restored, missingCredentials: ['harness/.credentials.yaml'] })
      h.api.restart.mockRejectedValueOnce(new Error('first failure')).mockResolvedValueOnce({ ...ready, phase: 'failed' })
      await h.restore()
      await h.click('Retry startup')
      expect(h.alert()).toContain('Backup restored, but Runtime has not started')
      expect(h.status()).toBeUndefined()
      await h.click('Retry startup')
      expect(h.api.restart).toHaveBeenCalledTimes(3)
      expect(h.api.restore).toHaveBeenCalledTimes(2)
      expect(h.status()).toContain('Backup restored. Runtime has started.')
      expect(h.status()).toContain('Model and plugin credentials')
      expect(h.alert()).toBeUndefined()
    }, 'en')
  })

  it('does not misreport a list refresh failure as a restore or Runtime failure', async () => {
    await withSection(async (h) => {
      h.api.listSnapshots.mockRejectedValueOnce(new Error('list temporarily unavailable'))
      await h.restore()
      expect(h.status()).toBe('备份已还原，Runtime 已启动。')
      expect(h.alert()).toContain('备份列表未能刷新')
      expect(h.alert()).not.toMatch(/还原失败|暂未启动/u)
      expect(h.dom.document.body.textContent).not.toContain('重试启动')
    })
  })

  it('clears a previous backup success message when a later restore fails', async () => {
    await withSection(async (h) => {
      await h.click(h.copy.settingsRecoveryCreate)
      await h.click(h.copy.settingsRecoveryCreate)
      expect(h.status()).toBe(h.copy.settingsRecoveryCreated)
      h.api.restore.mockRejectedValueOnce(new Error('Checksum mismatch'))
      await h.restore()
      expect(h.status()).toBeUndefined()
      expect(h.alert()).toContain('Checksum mismatch')
    })
  })
})
