import { createWindow } from '@mixmark-io/domino'
import { act, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkItemHandoffDialog } from '../../src/renderer/work-items/WorkItemHandoffDialog.js'
import { WorkItemDeliverables } from '../../src/renderer/work-items/WorkItemDeliverables.js'
import type { WorkTaskSnapshot } from '../../src/shared/work-items.js'

const snapshot: WorkTaskSnapshot = {
  task: { id: 'task-1', title: '报告', revision: 5, scope: { resourceRefs: [] }, requirements: [{ version: 2, goal: '核实变化', acceptance: '附来源', createdAt: '2026-09-15' }], currentRequirementVersion: 2, status: 'review', activeAttemptId: 'attempt-1', acceptedArtifactIds: [], createdAt: '2026-09-15', updatedAt: '2026-09-15' },
  attempts: [{ id: 'attempt-1', taskId: 'task-1', reason: 'initial', responsibility: { kind: 'employee', employeeId: 'researcher' }, requirementVersion: 2, createdAt: '2026-09-15' }],
  runs: [{ taskId: 'task-1', runId: 'run-1', attemptId: 'attempt-1', executor: { kind: 'employee', employeeId: 'researcher' }, commandId: 'command-1', requirementVersion: 2, status: 'completed', rawStatus: 'completed', observedAt: '2026-09-15', capabilities: { cancel: false, append: false, resume: false } }],
  artifacts: [{ id: 'draft-1', taskId: 'task-1', attemptId: 'attempt-1', runId: 'run-1', requirementVersion: 2, contentVersion: 3, contentHash: 'hash', kind: 'text', name: '报告 v3', storedPath: '/draft.txt', createdAt: '2026-09-15' }],
  actions: [],
}

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })
async function mount(element: ReactElement) {
  const dom = createWindow('<html><body><div id="root"></div></body></html>')
  const keys = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(dom.document.getElementById('root')!)
  cleanup = async () => { await act(async () => root.unmount()); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } }
  await act(async () => root.render(element))
  return { dom, render: async (next: ReactElement) => { await act(async () => root.render(next)) } }
}
function button(dom: ReturnType<typeof createWindow>, label: string): HTMLButtonElement {
  const result = Array.from(dom.document.querySelectorAll('button')).find((node) => node.textContent === label)
  if (!result) throw new Error(`Missing button ${label}`)
  return result as HTMLButtonElement
}

describe('work item handoff and acceptance UI', () => {
  it('dispatches an explicit new handoff on the same task with source and input, without copying prior conversation', async () => {
    const execute = vi.fn(async () => snapshot)
    const close = vi.fn()
    const executed = vi.fn()
    const { dom } = await mount(<WorkItemHandoffDialog snapshot={snapshot} executors={[{ label: '编辑', executor: { kind: 'employee', employeeId: 'editor' } }]} mode="handoff" onExecute={execute} onExecuted={executed} onClose={close} />)
    const textarea = dom.document.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => { Simulate.change(textarea, { target: { value: '只校对来源' } } as never) })
    await act(async () => { button(dom, '交接这项工作').click() })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ taskId: 'task-1', expectedRevision: 5, mode: 'handoff', executor: { kind: 'employee', employeeId: 'editor' }, sourceRunId: 'run-1', input: '只校对来源' })
    expect(executed).toHaveBeenCalledWith(snapshot)
    expect(close).toHaveBeenCalledOnce()
    expect(dom.document.body.textContent).toContain('内容 v3')
    expect(dom.document.body.textContent).toContain('要求 v2')
  })

  it('rejects malformed workflow inputs and reuses the dispatch request on an unchanged retry', async () => {
    const execute = vi.fn<(request: unknown) => Promise<WorkTaskSnapshot>>().mockRejectedValue(new Error('连接中断'))
    const { dom } = await mount(<WorkItemHandoffDialog snapshot={snapshot} executors={[{ label: '报告流程', executor: { kind: 'workflow', workflowId: 'report', workflowRevision: 4 } }]} mode="redo" onExecute={execute} onExecuted={vi.fn()} onClose={vi.fn()} />)
    const textarea = dom.document.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => { Simulate.change(textarea, { target: { value: '{bad' } } as never) })
    await act(async () => { button(dom, '再做一版').click() })
    expect(execute).not.toHaveBeenCalled()
    expect(dom.document.body.textContent).toContain('有效的流程输入 JSON')
    await act(async () => { Simulate.change(textarea, { target: { value: '{"draft":"v3"}' } } as never) })
    await act(async () => { button(dom, '再做一版').click() })
    await act(async () => { button(dom, '再做一版').click() })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[0]?.[0]).toEqual(execute.mock.calls[1]?.[0])
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ mode: 'redo', input: { draft: 'v3' } })
    expect(dom.document.body.textContent).not.toContain('已采用')
  })

  it('rejects non-finite JSON before dispatch and does not reuse a failed request for changed input', async () => {
    const execute = vi.fn<(request: unknown) => Promise<WorkTaskSnapshot>>().mockRejectedValue(new Error('连接中断'))
    const { dom } = await mount(<WorkItemHandoffDialog snapshot={snapshot} executors={[{ label: '报告流程', executor: { kind: 'workflow', workflowId: 'report', workflowRevision: 4 } }]} mode="redo" onExecute={execute} onExecuted={vi.fn()} onClose={vi.fn()} />)
    const textarea = dom.document.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => { Simulate.change(textarea, { target: { value: '1e400' } } as never) })
    await act(async () => { button(dom, '再做一版').click() })
    expect(execute).not.toHaveBeenCalled()
    expect(dom.document.body.textContent).toContain('有限且安全')
    await act(async () => { Simulate.change(textarea, { target: { value: 'null' } } as never) })
    await act(async () => { button(dom, '再做一版').click() })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ input: null })
  })

  it('shows acceptance only from the returned snapshot, and sends exact content and requirement versions', async () => {
    let resolve!: (value: WorkTaskSnapshot) => void
    const accept = vi.fn(() => new Promise<WorkTaskSnapshot>((done) => { resolve = done }))
    const accepted = vi.fn()
    const { dom, render } = await mount(<WorkItemDeliverables snapshot={snapshot} onAcceptArtifact={accept} onAccepted={accepted} />)
    await act(async () => { button(dom, '接受这一版').click() })
    expect(dom.document.body.textContent).not.toContain('已接受')
    expect(accepted).not.toHaveBeenCalled()
    expect(accept.mock.calls[0]?.[0]).toMatchObject({ taskId: 'task-1', expectedRevision: 5, artifactId: 'draft-1', contentVersion: 3, requirementVersion: 2 })
    const result = { ...snapshot, task: { ...snapshot.task, revision: 6, acceptedArtifactIds: ['draft-1'] } }
    await act(async () => { resolve(result) })
    expect(accepted).toHaveBeenCalledWith(result)
    await render(<WorkItemDeliverables snapshot={result} onAcceptArtifact={accept} onAccepted={accepted} />)
    expect(dom.document.body.textContent).toContain('已接受')
  })

  it('leaves failed acceptance unaccepted and disables older requirement artifacts', async () => {
    const accept = vi.fn().mockRejectedValue(new Error('成果内容已失效'))
    const accepted = vi.fn()
    const { dom, render } = await mount(<WorkItemDeliverables snapshot={snapshot} onAcceptArtifact={accept} onAccepted={accepted} />)
    await act(async () => { button(dom, '接受这一版').click() })
    expect(dom.document.body.textContent).toContain('成果内容已失效')
    expect(dom.document.body.textContent).not.toContain('已接受')
    expect(accepted).not.toHaveBeenCalled()
    const outdated = { ...snapshot, task: { ...snapshot.task, currentRequirementVersion: 3 } }
    await render(<WorkItemDeliverables snapshot={outdated} onAcceptArtifact={accept} onAccepted={accepted} />)
    expect(button(dom, '接受这一版').disabled).toBe(true)
    expect(dom.document.body.textContent).toContain('基于旧版要求')
  })
})
