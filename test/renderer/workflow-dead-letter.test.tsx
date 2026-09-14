import { createWindow } from '@mixmark-io/domino'
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowDeadLetterPage, WorkflowRecoveryExecuteRequest } from '../../src/shared/workflow-dead-letter.js'

const token = 'a'.repeat(64)
function page(workflowId = 'workflow-a', count = 2): WorkflowDeadLetterPage {
  return { items: Array.from({ length: count }, (_, i) => ({ runId: `${workflowId}-run-${i}`, workflowId, workflowRevision: 7, environmentId: 'production', releaseId: 'release-7', status: 'failed', expectedStateToken: token, decision: i === 1 ? 'blocked' : 'eligible', reason: i === 1 ? 'compensation-present' : 'safe-to-resume', failureCategory: 'legacy-failure-unclassified', retentionHold: i === 1 })), total: count, offset: 0, limit: 50 }
}
async function mount(options: { locale?: 'zh' | 'en'; list?: () => Promise<WorkflowDeadLetterPage>; execute?: (request: WorkflowRecoveryExecuteRequest) => Promise<unknown> } = {}) {
  const { WorkflowDeadLetterPanel } = await import('../../src/renderer/workflow/WorkflowDeadLetterPanel.js')
  const dom = createWindow('<html><body><div id="root"></div></body></html>')
  const original = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node, EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT }
  const listDeadLetters = vi.fn(options.list ?? (async () => page()))
  const previewRecovery = vi.fn(async ({ runIds }: { runIds: string[] }) => runIds.map((runId) => ({ runId, expectedStateToken: token, decision: runId.endsWith('-1') ? 'blocked' : 'eligible', reason: runId.endsWith('-1') ? 'compensation-present' : 'safe-to-resume' })))
  const executeRecovery = vi.fn(options.execute ?? (async (request) => request.items.map((item) => ({ runId: item.runId, status: 'queued', reason: 'safe-to-resume' }))))
  Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true,
    EzDSH: { workflows: { listDeadLetters, previewRecovery, executeRecovery } } })
  const root = createRoot(dom.document.getElementById('root')!)
  const render = async (workflowId = 'workflow-a') => { await act(async () => { root.render(<StrictMode><WorkflowDeadLetterPanel workflowId={workflowId} locale={options.locale ?? 'en'} /></StrictMode>) }) }
  const button = (action: string) => dom.document.querySelector(`[data-dlq-action="${action}"]`) as HTMLButtonElement
  const click = async (action: string) => { await act(async () => { button(action).click(); await Promise.resolve() }) }
  const select = async (id: string) => { await act(async () => { const input = dom.document.querySelector(`input[value="${id}"]`) as HTMLInputElement; Simulate.change(input, { target: { checked: true } } as never) }) }
  await render()
  await click('toggle')
  return { dom, render, button, click, select, listDeadLetters, previewRecovery, executeRecovery,
    cleanup: async () => { await act(async () => { root.unmount() }); Object.assign(globalThis, original) } }
}

describe('dead-letter recovery panel', () => {
  it.each(['zh', 'en'] as const)('localizes run states, decisions, categories, reasons and outcomes in %s', async (locale) => {
    const reasons = ['safe-to-resume', 'not-found', 'not-resumable', 'run-busy', 'service-unavailable', 'definition-unavailable', 'environment-inactive', 'access-revoked', 'legacy-loop-uncheckpointed', 'effect-reconciliation-required', 'compensation-present', 'state-changed', 'request-conflict', 'queue-full', 'recovery-failed', 'receipt-capacity', 'source-deleted-audit-only'] as const
    const reasonLabels = locale === 'en' ? ['Safe to resume', 'Run not found', 'Not resumable', 'Run busy', 'Service unavailable', 'Fixed revision or release unavailable', 'Environment inactive', 'Access unavailable', 'Legacy loop requires review', 'Effects require reconciliation', 'Compensation requires review', 'Preview is stale', 'Request conflict', 'Queue full', 'Recovery failed', 'Recovery receipt capacity reached', 'Source deleted; audit only'] : ['可安全恢复', '运行不存在', '只有暂停或失败的运行可以恢复', '运行正在执行或变更', '运行服务暂不可用', '固定版本或发布不可用', '环境未启用', '执行权限不可用', '旧版循环缺少逐迭代副作用记录', '副作用需要人工核对', '补偿栈存在，不能自动恢复', '状态已变化，请重新预览', '请求标识与已接受的预览不一致', '运行队列已满', '恢复未完成，请重试或检查状态', '恢复审计容量已满', '来源已删除，仅保留审计']
    const states = ['queued', 'running', 'paused', 'waiting-approval', 'completed', 'failed', 'cancelled'] as const
    const categories = ['legacy-failure-unclassified', 'paused', 'unresolved-audit'] as const
    const decisions = ['eligible', 'blocked', 'not-found'] as const
    const outcomes = ['queued', 'already-accepted', 'stale', 'blocked', 'not-found', 'failed'] as const
    const data = page('workflow-a', reasons.length + 1)
    data.items = data.items.map((item, i) => ({ ...item, reason: reasons[i] ?? 'SECRET-REASON', status: states[i % states.length], failureCategory: categories[i % categories.length], decision: decisions[i % decisions.length] })) as typeof data.items
    Object.assign(data.items.at(-1)!, { status: 'SECRET-STATE', failureCategory: 'SECRET-CATEGORY', decision: 'toString' })
    const f = await mount({ locale, list: async () => data, execute: async (request) => request.items.map((item, i) => ({ runId: item.runId, status: outcomes[i] ?? 'SECRET-OUTCOME', reason: i < outcomes.length ? 'state-changed' : 'SECRET-REASON' })) })
    try {
      const text = f.dom.document.body.textContent!
      for (const label of reasonLabels) expect(text).toContain(label)
      for (const label of locale === 'en' ? ['Queued', 'Running', 'Paused', 'Awaiting approval', 'Completed', 'Failed', 'Cancelled', 'Eligible', 'Blocked', 'Not found', 'Unclassified legacy failure', 'Unresolved audit evidence', 'Unknown state', 'Details unavailable', 'Unknown decision'] : ['已排队', '运行中', '已暂停', '等待审批', '已完成', '已失败', '已取消', '可恢复', '已阻止', '未找到', '旧版失败未分类', '审计证据待核对', '未知状态', '详情不可用', '未知恢复决定']) expect(text).toContain(label)
      expect(text).not.toContain('SECRET-'); expect(text).not.toContain('toString')
      if (locale === 'en') expect(text).not.toMatch(/[\u3400-\u9fff]/u)
      for (const reason of reasons) expect(text).not.toContain(reason)
      for (const i of [0, 2, 3, 4, 5, 6, 7]) await f.select(`workflow-a-run-${i}`)
      await f.click('preview'); await f.click('execute')
      const resultText = Array.from(f.dom.document.querySelectorAll('td[role="status"]')).map((el) => el.textContent).join(' ')
      for (const label of locale === 'en' ? ['Queued for execution; completion is not confirmed', 'Already accepted; check the current run state', 'Preview is stale', 'Blocked', 'Not found', 'Failed', 'Unknown outcome', 'Details unavailable'] : ['已排队等待执行，尚未确认完成', '此请求已接受，请查看运行当前状态', '预览已过期', '已阻止', '未找到', '恢复失败', '未知恢复结果', '详情不可用']) expect(resultText).toContain(label)
      expect(resultText).not.toContain('SECRET-')
      if (locale === 'en') expect(resultText).not.toMatch(/[\u3400-\u9fff]/u)
    } finally { await f.cleanup() }
  })
  it('requires explicit selection and preview; only selected eligible items execute and queued is not business success', async () => {
    const f = await mount()
    try {
      expect(f.button('preview').disabled).toBe(true)
      expect(f.button('execute').disabled).toBe(true)
      expect(f.dom.document.body.textContent).toContain('release-7')
      await f.select('workflow-a-run-0')
      await f.select('workflow-a-run-1')
      await f.click('preview')
      expect(f.previewRecovery).toHaveBeenCalledWith({ runIds: ['workflow-a-run-0', 'workflow-a-run-1'] })
      expect(f.dom.document.body.textContent).toContain('Compensation requires review')
      await f.click('execute')
      expect(f.executeRecovery).toHaveBeenCalledWith({ requestId: expect.any(String), items: [{ runId: 'workflow-a-run-0', expectedStateToken: token }] })
      expect(f.dom.document.body.textContent).toContain('Queued for execution; completion is not confirmed')
    } finally { await f.cleanup() }
  })

  it('retains the exact request after response loss instead of assigning a fresh acceptance identity', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('secret-provider')).mockResolvedValueOnce([{ runId: 'workflow-a-run-0', status: 'already-accepted', reason: 'safe-to-resume' }])
    const f = await mount({ execute })
    try {
      await f.select('workflow-a-run-0'); await f.click('preview'); await f.click('execute')
      expect(f.dom.document.body.textContent).not.toContain('secret-provider')
      await f.click('execute')
      expect(execute.mock.calls[0]![0]).toEqual(execute.mock.calls[1]![0])
      expect(f.dom.document.body.textContent).toContain('Already accepted')
    } finally { await f.cleanup() }
  })

  it('ignores deferred execution responses after the workflow target changes', async () => {
    let resolve!: (result: unknown) => void
    const f = await mount({ execute: () => new Promise((done) => { resolve = done }) })
    try {
      await f.select('workflow-a-run-0'); await f.click('preview'); await f.click('execute')
      f.listDeadLetters.mockResolvedValue(page('workflow-b'))
      await f.render('workflow-b'); await f.click('toggle')
      await act(async () => { resolve([{ runId: 'workflow-a-run-0', status: 'queued', reason: 'safe-to-resume' }]); await Promise.resolve() })
      expect(f.dom.document.body.textContent).not.toContain('workflow-a-run-0')
      expect(f.dom.document.body.textContent).not.toContain('Queued for execution; completion is not confirmed')
      expect(f.button('execute').disabled).toBe(true)
    } finally { await f.cleanup() }
  })

  it('limits selection to 20 and invalidates a preview when selection changes', async () => {
    const f = await mount({ list: async () => page('workflow-a', 21) })
    try {
      await f.select('workflow-a-run-0'); await f.click('preview')
      await f.select('workflow-a-run-2')
      expect(f.button('execute').disabled).toBe(true)
      for (let i = 1; i < 21; i++) if (i !== 2) await f.select(`workflow-a-run-${i}`)
      await f.click('preview')
      expect(f.previewRecovery.mock.calls.at(-1)![0].runIds).toHaveLength(20)
      expect((f.dom.document.querySelector('input[value="workflow-a-run-20"]') as HTMLInputElement).disabled).toBe(true)
    } finally { await f.cleanup() }
  })

  it('ignores deferred list and preview responses after target changes', async () => {
    let finishList!: (value: WorkflowDeadLetterPage) => void
    const f = await mount({ list: () => new Promise((resolve) => { finishList = resolve }) })
    try {
      f.listDeadLetters.mockResolvedValue(page('workflow-b'))
      await f.render('workflow-b'); await f.click('toggle')
      await act(async () => { finishList(page('workflow-a')); await Promise.resolve() })
      expect(f.dom.document.body.textContent).not.toContain('workflow-a-run-0')
      await f.select('workflow-b-run-0')
      let finishPreview!: (value: never[]) => void
      f.previewRecovery.mockImplementationOnce(() => new Promise((resolve) => { finishPreview = resolve }))
      await f.click('preview')
      f.listDeadLetters.mockResolvedValue(page('workflow-c'))
      await f.render('workflow-c'); await f.click('toggle')
      await act(async () => { finishPreview([{ runId: 'workflow-b-run-0', expectedStateToken: token, decision: 'eligible', reason: 'safe-to-resume' }] as never[]); await Promise.resolve() })
      expect(f.button('execute').disabled).toBe(true)
      expect(f.dom.document.body.textContent).not.toContain('workflow-b-run-0')
    } finally { await f.cleanup() }
  })

  it('shows per-run mixed results instead of presenting a batch as completed', async () => {
    const f = await mount({ list: async () => page('workflow-a', 3), execute: async () => [
      { runId: 'workflow-a-run-0', status: 'queued', reason: 'safe-to-resume' }, { runId: 'workflow-a-run-2', status: 'stale', reason: 'state-changed' },
    ] })
    try {
      await f.select('workflow-a-run-0'); await f.select('workflow-a-run-2'); await f.click('preview'); await f.click('execute')
      const results = Array.from(f.dom.document.querySelectorAll('td[role="status"]')).map((element) => element.textContent)
      expect(results).toHaveLength(2)
      expect(results[0]).toContain('Queued for execution; completion is not confirmed')
      expect(results[1]).toContain('Preview is stale')
    } finally { await f.cleanup() }
  })
})
