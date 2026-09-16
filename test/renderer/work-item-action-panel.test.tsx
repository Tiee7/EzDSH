import { createWindow } from '@mixmark-io/domino'
import { act, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkItemActionPanel } from '../../src/renderer/work-items/WorkItemActionPanel.js'
import type { WorkActionAnswerRequest, WorkRunControlRequest, WorkTaskSnapshot } from '../../src/shared/work-items.js'

function snapshot(): WorkTaskSnapshot {
  return {
    task: {
      id: 'task-1', revision: 7, title: 'Release', scope: { resourceRefs: [] },
      requirements: [{ version: 2, goal: 'Ship', acceptance: 'Approved', createdAt: '2026-09-15T09:00:00.000Z' }],
      currentRequirementVersion: 2, status: 'active', activeAttemptId: 'attempt-1', acceptedArtifactIds: [],
      createdAt: '2026-09-15T09:00:00.000Z', updatedAt: '2026-09-15T10:00:00.000Z',
    },
    attempts: [],
    runs: [
      { taskId: 'task-1', attemptId: 'attempt-1', runId: 'run-approval', executor: { kind: 'workflow', workflowId: 'release' }, commandId: 'command-1', requirementVersion: 2, status: 'waiting', rawStatus: 'waiting-approval', observedAt: '2026-09-15T10:00:00.000Z', capabilities: { cancel: true, resume: false, append: false } },
      { taskId: 'task-1', attemptId: 'attempt-1', runId: 'run-recovery', executor: { kind: 'workflow', workflowId: 'release' }, commandId: 'command-2', requirementVersion: 2, status: 'failed', rawStatus: 'failed', observedAt: '2026-09-15T10:01:00.000Z', capabilities: { cancel: false, resume: true, append: false } },
      { taskId: 'task-1', attemptId: 'attempt-1', runId: 'run-question', executor: { kind: 'workflow', workflowId: 'release' }, commandId: 'command-3', requirementVersion: 2, status: 'waiting', rawStatus: 'waiting-question', observedAt: '2026-09-15T10:02:00.000Z', capabilities: { cancel: false, resume: false, append: false } },
    ],
    artifacts: [],
    actions: [
      { id: 'approval-1', taskId: 'task-1', runId: 'run-approval', sourceEventId: 'event-approval', requirementVersion: 2, kind: 'approval', status: 'open', nodeId: 'approve' },
      { id: 'recovery-1', taskId: 'task-1', runId: 'run-recovery', sourceEventId: 'event-recovery', requirementVersion: 2, kind: 'recovery', status: 'open' },
      { id: 'question-1', taskId: 'task-1', runId: 'run-question', sourceEventId: 'event-question', requirementVersion: 2, kind: 'question', status: 'open' },
    ],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail }), resolve, reject }
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
  const found = dom.document.querySelector(`button[aria-label="${label}"]`)
  if (!found) throw new Error(`Missing button ${label}`)
  return found as HTMLButtonElement
}

function submitQuestion(dom: ReturnType<typeof createWindow>, actionId: string): void {
  const form = dom.document.querySelector(`[data-action-id="${actionId}"] form`)
  if (!form) throw new Error(`Missing question form ${actionId}`)
  form.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }))
}

describe('WorkItemActionPanel', () => {
  it('answers approval explicitly, suppresses a duplicate click, and only applies the returned snapshot', async () => {
    const pending = deferred<WorkTaskSnapshot>()
    const answer = vi.fn<(request: WorkActionAnswerRequest) => Promise<WorkTaskSnapshot>>(() => pending.promise)
    const changed = vi.fn()
    const current = snapshot()
    const result = { ...current, task: { ...current.task, revision: 8 }, actions: current.actions.map((item) => item.id === 'approval-1' ? { ...item, status: 'resolved' as const } : item) }
    const { dom } = await mount(<WorkItemActionPanel snapshot={current} locale="zh" onAnswer={answer} onControl={vi.fn()} onChanged={changed} onOpenExecutor={vi.fn()} />)

    await act(async () => {
      button(dom, '同意审批 approval-1').click()
      button(dom, '同意审批 approval-1').click()
      await Promise.resolve()
    })
    expect(answer).toHaveBeenCalledOnce()
    expect(answer.mock.calls[0]?.[0]).toMatchObject({
      taskId: 'task-1', actionId: 'approval-1', expectedSourceEventId: 'event-approval', expectedRequirementVersion: 2, answer: true,
    })
    expect(changed).not.toHaveBeenCalled()
    expect(dom.document.body.textContent).toContain('等待批准')

    await act(async () => pending.resolve(result))
    expect(changed).toHaveBeenCalledWith(result)
  })

  it('provides explicit rejection and never invents a question text answer control', async () => {
    const current = snapshot()
    const answer = vi.fn(async () => current)
    const openExecutor = vi.fn()
    const { dom } = await mount(<WorkItemActionPanel snapshot={current} locale="en" onAnswer={answer} onControl={vi.fn()} onChanged={vi.fn()} onOpenExecutor={openExecutor} />)

    await act(async () => button(dom, 'Reject approval approval-1').click())
    expect(answer.mock.calls[0]?.[0]).toMatchObject({ actionId: 'approval-1', answer: false })
    expect(dom.document.querySelector('textarea')).toBeFalsy()
    expect(dom.document.body.textContent).toContain('does not include question text or an answer protocol')
    await act(async () => button(dom, 'Open executor for question-1').click())
    expect(openExecutor).toHaveBeenCalledWith('run-question')
  })

  it('offers recovery and run controls only from persisted capabilities with the current revision', async () => {
    const current = snapshot()
    const control = vi.fn(async () => current)
    const { dom } = await mount(<WorkItemActionPanel snapshot={current} locale="en" onAnswer={vi.fn()} onControl={control} onChanged={vi.fn()} onOpenExecutor={vi.fn()} />)

    expect(dom.document.querySelector('button[aria-label="Resume recovery recovery-1"]')).not.toBeNull()
    expect(dom.document.querySelector('button[aria-label="Resume run run-recovery"]')).not.toBeNull()
    expect(dom.document.querySelector('button[aria-label="Cancel run run-approval"]')).not.toBeNull()
    expect(dom.document.querySelector('button[aria-label="Resume run run-question"]')).toBeFalsy()
    expect(dom.document.querySelector('button[aria-label="Cancel run run-question"]')).toBeFalsy()

    await act(async () => button(dom, 'Resume recovery recovery-1').click())
    expect(control.mock.calls[0]?.[0]).toMatchObject({ taskId: 'task-1', runId: 'run-recovery', expectedRevision: 7, action: 'resume' })
  })

  it('suppresses duplicate run control and keeps the persisted non-terminal state after failure', async () => {
    const pending = deferred<WorkTaskSnapshot>()
    const control = vi.fn<(request: WorkRunControlRequest) => Promise<WorkTaskSnapshot>>(() => pending.promise)
    const changed = vi.fn()
    const current = snapshot()
    const { dom } = await mount(<WorkItemActionPanel snapshot={current} locale="en" onAnswer={vi.fn()} onControl={control} onChanged={changed} onOpenExecutor={vi.fn()} />)

    await act(async () => {
      button(dom, 'Cancel run run-approval').click()
      button(dom, 'Cancel run run-approval').click()
      await Promise.resolve()
    })
    expect(control).toHaveBeenCalledOnce()
    expect(control.mock.calls[0]?.[0]).toMatchObject({ taskId: 'task-1', runId: 'run-approval', expectedRevision: 7, action: 'cancel' })

    await act(async () => pending.reject(new Error('Network unavailable')))
    expect(changed).not.toHaveBeenCalled()
    expect(dom.document.body.textContent).toContain('waiting-approval')
    expect(dom.document.body.textContent).not.toContain('cancelled')
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toContain('Network unavailable')
  })

  it('does not offer recovery when the linked run has not persisted resume capability', async () => {
    const current = snapshot()
    const withoutResume = {
      ...current,
      runs: current.runs.map((item) => item.runId === 'run-recovery' ? { ...item, capabilities: { ...item.capabilities, resume: false } } : item),
    }
    const { dom } = await mount(<WorkItemActionPanel snapshot={withoutResume} locale="en" onAnswer={vi.fn()} onControl={vi.fn()} onChanged={vi.fn()} onOpenExecutor={vi.fn()} />)

    expect(dom.document.querySelector('button[aria-label="Resume recovery recovery-1"]')).toBeFalsy()
    expect(dom.document.body.textContent).toContain('has not declared resume capability')
  })

  it('renders a persisted text question and submits a versioned answer', async () => {
    const current = snapshot()
    const withQuestion: WorkTaskSnapshot = {
      ...current,
      actions: current.actions.map((item) => item.id === 'question-1' ? {
        ...item,
        question: {
          version: 1 as const,
          sourceRevision: 4,
          prompt: 'Who should receive the release?',
          response: { type: 'text' as const, maxLength: 40 },
        },
      } : item),
    }
    const answer = vi.fn(async () => withQuestion)
    const { dom } = await mount(<WorkItemActionPanel snapshot={withQuestion} locale="en" onAnswer={answer} onControl={vi.fn()} onChanged={vi.fn()} onOpenExecutor={vi.fn()} />)

    expect(dom.document.body.textContent).toContain('Who should receive the release?')
    const field = dom.document.querySelector('textarea[aria-label="Answer question question-1"]') as HTMLTextAreaElement
    await act(async () => { Simulate.change(field, { target: { value: 'Teachers' } } as never) })
    await act(async () => submitQuestion(dom, 'question-1'))

    expect(answer).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'question-1',
      expectedSourceEventId: 'event-question',
      expectedRequirementVersion: 2,
      expectedActionVersion: 1,
      answer: 'Teachers',
    }))
  })

  it('submits stable single-choice values and reuses the request id after an explicit failure', async () => {
    const current = snapshot()
    const withQuestion: WorkTaskSnapshot = {
      ...current,
      actions: current.actions.map((item) => item.id === 'question-1' ? {
        ...item,
        question: {
          version: 1 as const,
          sourceRevision: 5,
          prompt: 'Choose a channel',
          response: { type: 'single-choice' as const, options: [{ value: 'web', label: 'Website' }, { value: 'email', label: 'Email' }] },
        },
      } : item),
    }
    const answer = vi.fn<(request: WorkActionAnswerRequest) => Promise<WorkTaskSnapshot>>()
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce(withQuestion)
    const { dom } = await mount(<WorkItemActionPanel snapshot={withQuestion} locale="en" onAnswer={answer} onControl={vi.fn()} onChanged={vi.fn()} onOpenExecutor={vi.fn()} />)
    const field = dom.document.querySelector('select[aria-label="Answer question question-1"]') as HTMLSelectElement

    await act(async () => { Simulate.change(field, { target: { value: 'web' } } as never) })
    await act(async () => submitQuestion(dom, 'question-1'))
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toContain('Network unavailable')
    await act(async () => submitQuestion(dom, 'question-1'))

    expect(answer).toHaveBeenCalledTimes(2)
    expect(answer.mock.calls[0]?.[0].answer).toBe('web')
    expect(answer.mock.calls[1]?.[0].requestId).toBe(answer.mock.calls[0]?.[0].requestId)
  })

  it('collects typed structured fields before submitting', async () => {
    const current = snapshot()
    const withQuestion: WorkTaskSnapshot = {
      ...current,
      actions: current.actions.map((item) => item.id === 'question-1' ? {
        ...item,
        question: {
          version: 1 as const,
          sourceRevision: 6,
          prompt: 'Release details',
          response: { type: 'structured' as const, schema: { fields: [
            { key: 'title', type: 'string' as const, required: true },
            { key: 'copies', type: 'number' as const, required: true },
            { key: 'approved', type: 'boolean' as const, required: true },
          ] } },
        },
      } : item),
    }
    const answer = vi.fn(async () => withQuestion)
    const { dom } = await mount(<WorkItemActionPanel snapshot={withQuestion} locale="en" onAnswer={answer} onControl={vi.fn()} onChanged={vi.fn()} onOpenExecutor={vi.fn()} />)

    for (const [label, value] of [['Release details: title', 'Ship'], ['Release details: copies', '3'], ['Release details: approved', 'true']] as const) {
      const field = dom.document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement
      await act(async () => {
        Simulate.change(field, { target: { value } } as never)
      })
    }
    await act(async () => submitQuestion(dom, 'question-1'))

    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ answer: { title: 'Ship', copies: 3, approved: true } }))
  })
})
