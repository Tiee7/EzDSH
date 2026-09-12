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
async function mount(options: { list?: () => Promise<WorkflowDeadLetterPage>; execute?: (request: WorkflowRecoveryExecuteRequest) => Promise<unknown> } = {}) {
  const { WorkflowDeadLetterPanel } = await import('../../src/renderer/workflow/WorkflowDeadLetterPanel.js')
  const dom = createWindow('<html><body><div id="root"></div></body></html>')
  const original = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node, EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT }
  const listDeadLetters = vi.fn(options.list ?? (async () => page()))
  const previewRecovery = vi.fn(async ({ runIds }: { runIds: string[] }) => runIds.map((runId) => ({ runId, expectedStateToken: token, decision: runId.endsWith('-1') ? 'blocked' : 'eligible', reason: runId.endsWith('-1') ? 'compensation-present' : 'safe-to-resume' })))
  const executeRecovery = vi.fn(options.execute ?? (async (request) => request.items.map((item) => ({ runId: item.runId, status: 'queued', reason: 'safe-to-resume' }))))
  Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true,
    EzDSH: { workflows: { listDeadLetters, previewRecovery, executeRecovery } } })
  const root = createRoot(dom.document.getElementById('root')!)
  const render = async (workflowId = 'workflow-a') => { await act(async () => { root.render(<StrictMode><WorkflowDeadLetterPanel workflowId={workflowId} locale="en" /></StrictMode>) }) }
  const button = (action: string) => dom.document.querySelector(`[data-dlq-action="${action}"]`) as HTMLButtonElement
  const click = async (action: string) => { await act(async () => { button(action).click(); await Promise.resolve() }) }
  const select = async (id: string) => { await act(async () => { const input = dom.document.querySelector(`input[value="${id}"]`) as HTMLInputElement; Simulate.change(input, { target: { checked: true } } as never) }) }
  await render()
  await click('toggle')
  return { dom, render, button, click, select, listDeadLetters, previewRecovery, executeRecovery,
    cleanup: async () => { await act(async () => { root.unmount() }); Object.assign(globalThis, original) } }
}

describe('dead-letter recovery panel', () => {
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
