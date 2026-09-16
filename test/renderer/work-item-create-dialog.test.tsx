import { createWindow } from '@mixmark-io/domino'
import { act, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkItemCreateDialog } from '../../src/renderer/work-items/WorkItemCreateDialog.js'
import type { WorkTaskSnapshot } from '../../src/shared/work-items.js'

const createdSnapshot: WorkTaskSnapshot = {
  task: {
    id: 'task-created',
    revision: 2,
    title: '竞品报告',
    scope: { projectId: 'project-1', cwd: '/workspace/project-1', resourceRefs: [] },
    requirements: [{ version: 1, goal: '分析三个竞品', acceptance: '包含来源', createdAt: '2026-09-16' }],
    currentRequirementVersion: 1,
    status: 'open',
    acceptedArtifactIds: [],
    createdAt: '2026-09-16',
    updatedAt: '2026-09-16',
  },
  attempts: [],
  runs: [],
  artifacts: [],
  actions: [],
}

const executedSnapshot: WorkTaskSnapshot = {
  ...createdSnapshot,
  task: { ...createdSnapshot.task, revision: 3, status: 'active' },
  attempts: [{
    id: 'attempt-1',
    taskId: 'task-created',
    requirementVersion: 1,
    reason: 'initial',
    responsibility: { kind: 'employee', employeeId: 'analyst' },
    createdAt: '2026-09-16',
  }],
}

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })

async function mount(element: ReactElement) {
  const dom = createWindow('<html><body><div id="root"></div></body></html>')
  const keys = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    HTMLElement: dom.HTMLElement,
    Node: dom.Node,
    Event: dom.Event,
    MouseEvent: dom.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const root = createRoot(dom.document.getElementById('root')!)
  cleanup = async () => {
    await act(async () => root.unmount())
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
  await act(async () => root.render(element))
  return dom
}

function control<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
  dom: ReturnType<typeof createWindow>,
  label: string,
): T {
  const result = dom.document.querySelector(`[aria-label="${label}"]`)
  if (!result) throw new Error(`Missing control ${label}`)
  return result as T
}

function button(dom: ReturnType<typeof createWindow>, label: string): HTMLButtonElement {
  const result = Array.from(dom.document.querySelectorAll('button')).find((node) => node.textContent?.trim() === label)
  if (!result) throw new Error(`Missing button ${label}`)
  return result as HTMLButtonElement
}

async function change(element: Element, value: string): Promise<void> {
  await act(async () => { Simulate.change(element, { target: { value } } as never) })
}

function dialog(overrides: Partial<React.ComponentProps<typeof WorkItemCreateDialog>> = {}): ReactElement {
  return <WorkItemCreateDialog
    employees={[{ employeeId: 'analyst', label: '分析师' }]}
    workflows={[{ workflowId: 'report-flow', workflowRevision: 7, label: '报告流程' }]}
    projects={[{ projectId: 'project-1', label: '项目一', cwd: '/workspace/project-1' }]}
    onCreate={vi.fn(async () => createdSnapshot)}
    onExecute={vi.fn(async () => executedSnapshot)}
    onCreated={vi.fn()}
    onExecuted={vi.fn()}
    onClose={vi.fn()}
    {...overrides}
  />
}

async function fillRequired(dom: ReturnType<typeof createWindow>): Promise<void> {
  await change(control(dom, '标题'), '竞品报告')
  await change(control(dom, '目标'), '分析三个竞品')
  await change(control(dom, '验收标准'), '包含来源')
}

describe('WorkItemCreateDialog', () => {
  it('creates an unassigned item with an optional project and reports the snapshot to its parent', async () => {
    const create = vi.fn(async () => createdSnapshot)
    const execute = vi.fn(async () => executedSnapshot)
    const created = vi.fn()
    const close = vi.fn()
    const dom = await mount(dialog({ onCreate: create, onExecute: execute, onCreated: created, onClose: close }))

    expect(control(dom, '标题').getAttribute('aria-required')).toBe('true')
    expect(control(dom, '目标').getAttribute('aria-required')).toBe('true')
    expect(control(dom, '验收标准').getAttribute('aria-required')).toBe('true')
    await fillRequired(dom)
    await change(control(dom, '项目'), 'project-1')
    await act(async () => { button(dom, '只创建').click(); await Promise.resolve(); await Promise.resolve() })

    expect(create).toHaveBeenCalledWith({
      requestId: expect.any(String),
      title: '竞品报告',
      goal: '分析三个竞品',
      acceptance: '包含来源',
      scope: { projectId: 'project-1', cwd: '/workspace/project-1', resourceRefs: [] },
    })
    expect(execute).not.toHaveBeenCalled()
    expect(created).toHaveBeenCalledWith(createdSnapshot)
    expect(close).toHaveBeenCalledOnce()
  })

  it('validates required fields and closes without calling create or execute', async () => {
    const create = vi.fn(async () => createdSnapshot)
    const execute = vi.fn(async () => executedSnapshot)
    const close = vi.fn()
    const dom = await mount(dialog({ onCreate: create, onExecute: execute, onClose: close }))

    await act(async () => { button(dom, '只创建').click() })
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toContain('必填')
    expect(create).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()

    await act(async () => { button(dom, '关闭').click() })
    expect(close).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects malformed or non-finite workflow JSON before creating the item', async () => {
    const create = vi.fn(async () => createdSnapshot)
    const execute = vi.fn(async () => executedSnapshot)
    const dom = await mount(dialog({ onCreate: create, onExecute: execute }))
    await fillRequired(dom)
    await change(control(dom, '处理方式'), 'workflow')
    await change(control(dom, 'Workflow 输入（JSON）'), '{bad')
    await act(async () => { button(dom, '创建并执行').click() })
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toContain('有效的 JSON')
    expect(create).not.toHaveBeenCalled()

    await change(control(dom, 'Workflow 输入（JSON）'), '1e400')
    await act(async () => { button(dom, '创建并执行').click() })
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toContain('有限且安全')
    expect(create).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports a created snapshot and retries only execution with the same request id', async () => {
    const create = vi.fn(async () => createdSnapshot)
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error('执行服务暂时不可用'))
      .mockResolvedValueOnce(executedSnapshot)
    const created = vi.fn()
    const executed = vi.fn()
    const close = vi.fn()
    const dom = await mount(dialog({ onCreate: create, onExecute: execute, onCreated: created, onExecuted: executed, onClose: close }))
    await fillRequired(dom)
    await change(control(dom, '处理方式'), 'employee')
    await change(control(dom, '执行说明'), '核对公开来源')

    await act(async () => { button(dom, '创建并执行').click(); await Promise.resolve(); await Promise.resolve() })
    expect(create).toHaveBeenCalledOnce()
    expect(created).toHaveBeenCalledWith(createdSnapshot)
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      taskId: 'task-created',
      expectedRevision: 2,
      executor: { kind: 'employee', employeeId: 'analyst' },
      mode: 'initial',
      input: '核对公开来源',
    })
    expect(dom.document.body.textContent).toContain('执行服务暂时不可用')
    expect(close).not.toHaveBeenCalled()

    await act(async () => { button(dom, '重试执行').click(); await Promise.resolve(); await Promise.resolve() })
    expect(create).toHaveBeenCalledOnce()
    expect(created).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1]?.[0]).toEqual(execute.mock.calls[0]?.[0])
    expect(executed).toHaveBeenCalledWith(executedSnapshot)
    expect(close).toHaveBeenCalledOnce()
  })
})
