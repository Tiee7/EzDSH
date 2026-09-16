import { createWindow } from '@mixmark-io/domino'
import { act, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkItemAttentionView } from '../../src/renderer/work-items/WorkItemAttentionView.js'
import type { WorkTaskSnapshot } from '../../src/shared/work-items.js'

function snapshot(id: string, title: string, group: 'needs-action' | 'in-progress' | 'review' | 'failed' | 'completed' | 'cancelled'): WorkTaskSnapshot {
  const base: WorkTaskSnapshot = {
    task: {
      id,
      revision: 1,
      title,
      scope: { resourceRefs: [] },
      requirements: [{ version: 1, goal: title, acceptance: 'Done', createdAt: '2026-09-15T09:00:00.000Z' }],
      currentRequirementVersion: 1,
      status: group === 'completed' ? 'completed' : group === 'cancelled' ? 'cancelled' : 'active',
      acceptedArtifactIds: [],
      createdAt: '2026-09-15T09:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
    },
    attempts: [],
    runs: [],
    artifacts: [],
    actions: [],
  }
  if (group === 'needs-action') {
    base.actions.push({ id: `${id}-action`, taskId: id, runId: `${id}-run`, sourceEventId: `${id}-event`, requirementVersion: 1, kind: 'question', status: 'open' })
  } else if (group === 'in-progress') {
    base.runs.push({ taskId: id, attemptId: `${id}-attempt`, runId: `${id}-run`, executor: { kind: 'employee', employeeId: 'writer' }, commandId: `${id}-command`, requirementVersion: 1, status: 'running', rawStatus: 'running', observedAt: '2026-09-15T10:00:00.000Z', capabilities: { cancel: true, resume: false, append: false } })
  } else if (group === 'review') {
    base.artifacts.push({ id: `${id}-artifact`, taskId: id, attemptId: `${id}-attempt`, runId: `${id}-run`, requirementVersion: 1, contentVersion: 1, contentHash: 'hash', kind: 'text', name: `${id}.md`, storedPath: `/${id}.md`, createdAt: '2026-09-15T10:00:00.000Z' })
  } else if (group === 'failed') {
    base.runs.push({ taskId: id, attemptId: `${id}-attempt`, runId: `${id}-run`, executor: { kind: 'employee', employeeId: 'writer' }, commandId: `${id}-command`, requirementVersion: 1, status: 'failed', rawStatus: 'failed', observedAt: '2026-09-15T10:00:00.000Z', capabilities: { cancel: false, resume: false, append: false } })
  }
  return base
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
  return dom
}

describe('WorkItemAttentionView', () => {
  it('renders deterministic groups, counts, and stable task ids without needing a bridge', () => {
    const markup = renderToStaticMarkup(<WorkItemAttentionView
      snapshots={[
        snapshot('task-review', 'Review draft', 'review'),
        snapshot('task-action', 'Answer editor', 'needs-action'),
        snapshot('task-running', 'Generate report', 'in-progress'),
        snapshot('task-failed', 'Retry research', 'failed'),
        snapshot('task-done', 'Published release', 'completed'),
        snapshot('task-cancelled', 'Stopped release', 'cancelled'),
      ]}
      onSelect={() => {}}
    />)

    expect(markup).toContain('Needs action')
    expect(markup).toContain('In progress')
    expect(markup).toContain('Review')
    expect(markup).toContain('Failed')
    expect(markup).toContain('Completed')
    expect(markup).toContain('Cancelled')
    expect(markup.match(/data-attention-count="1"/gu)).toHaveLength(6)
    for (const id of ['task-action', 'task-running', 'task-review', 'task-failed', 'task-done', 'task-cancelled']) {
      expect(markup).toContain(`data-task-id="${id}"`)
      expect(markup).toContain(id)
    }
  })

  it('shows a per-group empty state and selects by the stable task id', async () => {
    const selected = vi.fn()
    const dom = await mount(<WorkItemAttentionView snapshots={[snapshot('task-action', 'Answer editor', 'needs-action')]} onSelect={selected} />)

    expect(dom.document.querySelectorAll('[data-attention-empty="true"]')).toHaveLength(5)
    const task = dom.document.querySelector('[data-task-id="task-action"]') as HTMLButtonElement
    await act(async () => task.click())
    expect(selected).toHaveBeenCalledWith('task-action')
  })
})
