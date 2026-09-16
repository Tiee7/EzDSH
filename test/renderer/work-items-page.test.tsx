import { createWindow } from '@mixmark-io/domino'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WorkItemDetail } from '../../src/renderer/work-items/WorkItemDetail.js'
import { WorkItemsPage } from '../../src/renderer/work-items/WorkItemsPage.js'
import { mergeSnapshot, shouldApplySnapshot } from '../../src/renderer/work-items/work-item-view-model.js'
import { createWorkItemNavigation } from '../../src/renderer/work-items/work-item-navigation.js'
import { getAppCopy } from '../../src/shared/locale.js'
import type { WorkTaskSnapshot } from '../../src/shared/work-items.js'
import { workArtifactFixture, workTaskFixture } from '../work-items/fixtures.js'

function snapshot(overrides: Partial<WorkTaskSnapshot> = {}): WorkTaskSnapshot {
  const task = workTaskFixture()
  return {
    task,
    attempts: [{ id: 'attempt-1', taskId: task.id, requirementVersion: 2, reason: 'initial', responsibility: { kind: 'employee', employeeId: 'researcher' }, createdAt: '2026-09-15T00:00:01.000Z' }],
    runs: [{ taskId: task.id, attemptId: 'attempt-1', runId: 'run-1', executor: { kind: 'employee', employeeId: 'researcher' }, commandId: 'command-1', requirementVersion: 2, status: 'running', rawStatus: 'running', observedAt: '2026-09-15T00:00:02.000Z', capabilities: { cancel: true, resume: false, append: false } }],
    artifacts: [workArtifactFixture()],
    actions: [{ id: 'action-1', taskId: task.id, runId: 'run-1', sourceEventId: 'event-1', requirementVersion: 2, kind: 'approval', status: 'open' }],
    ...overrides,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve }
}

async function mountPage(options: {
  list?: () => Promise<WorkTaskSnapshot[]>
  get?: (taskId: string) => Promise<WorkTaskSnapshot | undefined>
  acceptArtifact?: (request: import('../../src/shared/work-items.js').WorkArtifactAcceptRequest) => Promise<WorkTaskSnapshot>
  openArtifact?: (taskId: string, artifactId: string) => Promise<void>
  runtimeAvailable?: boolean
  onNavigate?: (context: import('../../src/renderer/work-items/work-item-navigation.js').WorkItemNavigationContext) => void
  navigation?: import('../../src/renderer/work-items/work-item-navigation.js').WorkItemNavigationContext
} = {}) {
  const previous = {
    window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement, Node: globalThis.Node, Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent, EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH,
  }
  const dom = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  let listener: ((snapshot: WorkTaskSnapshot) => void) | undefined
  const bridge = {
    list: vi.fn(options.list ?? (async () => [snapshot()])),
    get: vi.fn(options.get ?? (async () => snapshot())),
    acceptArtifact: vi.fn(options.acceptArtifact ?? (async () => snapshot())),
    openArtifact: vi.fn(options.openArtifact ?? (async () => undefined)),
    controlRun: vi.fn(),
    onChanged: vi.fn((next: (value: WorkTaskSnapshot) => void) => { listener = next; return () => { listener = undefined } }),
  }
  const employees = { list: vi.fn(async () => [{ id: 'editor', name: '编辑', role: '编辑', enabled: true }]) }
  const workflows = { list: vi.fn(async () => [{ id: 'reporting', name: '报告流程', enabled: true, revision: 4 }]) }
  Object.assign(globalThis, {
    window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
    Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.navigator })
  const ezdsh = { workItems: bridge, employees, workflows }
  Object.assign(dom as unknown as Record<string, unknown>, { EzDSH: ezdsh })
  ;(globalThis as { EzDSH?: unknown }).EzDSH = ezdsh
  const root = createRoot(dom.document.getElementById('root')!)
  await act(async () => {
    root.render(<WorkItemsPage copy={getAppCopy('zh')} runtimeAvailable={options.runtimeAvailable} navigation={options.navigation} onNavigate={options.onNavigate} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return {
    bridge,
    dom,
    emit: async (value: WorkTaskSnapshot) => { await act(async () => { listener?.(value); await Promise.resolve() }) },
    click: async (label: string) => {
      const button = Array.from(dom.document.querySelectorAll('button')).find((element) => element.textContent?.includes(label)) as HTMLButtonElement | undefined
      if (button === undefined) throw new Error(`Missing button: ${label}`)
      await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve() })
    },
    cleanup: async () => {
      await act(async () => { root.unmount() })
      const { navigator: previousNavigator, ...rest } = previous
      Object.assign(globalThis, rest)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    },
  }
}

describe('Work Items renderer', () => {
  it('renders all Main-owned task records and leaves pending actions read-only', () => {
    const markup = renderToStaticMarkup(<WorkItemDetail copy={getAppCopy('zh')} snapshot={snapshot()} onClose={() => {}} />)
    expect(markup).toContain('当前要求')
    expect(markup).toContain('执行轮次')
    expect(markup).toContain('执行记录')
    expect(markup).toContain('成果')
    expect(markup).toContain('待处理事项')
    expect(markup).toContain('本期只读')
  })

  it('localizes the handoff controls in the English detail surface', () => {
    const markup = renderToStaticMarkup(<WorkItemDetail copy={getAppCopy('en')} snapshot={snapshot()} onClose={() => {}} onStartHandoff={() => {}} />)
    expect(markup).toContain('Make another version')
    expect(markup).toContain('Hand off')
    expect(markup).not.toContain('再做一版')
    expect(markup).not.toContain('交接')
  })

  it('reads saved tasks, reopens a detail, and closing it does not cancel the run', async () => {
    const page = await mountPage()
    try {
      await page.click('Prepare release notes')
      expect(page.dom.document.body.textContent).toContain('Prepare the release notes')
      const taskButton = Array.from(page.dom.document.querySelectorAll('button')).find((button) => button.textContent?.includes('Prepare release notes')) as HTMLButtonElement
      const focus = vi.spyOn(taskButton, 'focus')
      await page.click('关闭详情')
      expect(page.dom.document.body.textContent).toContain('从左侧选择一个已保存的工作项。')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(focus).toHaveBeenCalled()
      await page.click('Prepare release notes')
      expect(page.dom.document.body.textContent).toContain('Prepare the release notes')
      expect(page.bridge.controlRun).not.toHaveBeenCalled()
    } finally {
      await page.cleanup()
    }
  })

  it('opens the executor represented by the latest run after a same-attempt handoff', async () => {
    const navigations: import('../../src/renderer/work-items/work-item-navigation.js').WorkItemNavigationContext[] = []
    const current = snapshot({
      runs: [{ taskId: 'task-1', attemptId: 'attempt-1', runId: 'run-workflow', executor: { kind: 'workflow', workflowId: 'handoff-flow', workflowRevision: 4 }, commandId: 'command-2', requirementVersion: 2, status: 'running', rawStatus: 'running', observedAt: '2026-09-15T00:00:03.000Z', capabilities: { cancel: true, resume: false, append: false } }],
    })
    const page = await mountPage({ list: async () => [current], get: async () => current, onNavigate: (context) => { navigations.push(context) } })
    try {
      await page.click('Prepare release notes')
      await page.click('打开执行器')
      expect(navigations).toHaveLength(1)
      expect(navigations[0]).toMatchObject({ destination: 'workflow', workflowId: 'handoff-flow', runId: 'run-workflow', taskId: 'task-1' })
    } finally {
      await page.cleanup()
    }
  })

  it('sends acceptance through Main and renders the returned accepted snapshot', async () => {
    const accepted = snapshot({ task: { ...workTaskFixture(), acceptedArtifactIds: ['artifact-1'], revision: 3 } })
    const page = await mountPage({ acceptArtifact: async (request) => {
      expect(request).toMatchObject({
        taskId: 'task-1',
        expectedRevision: 2,
        artifactId: 'artifact-1',
        contentVersion: 1,
        requirementVersion: 2,
      })
      return accepted
    } })
    try {
      await page.click('Prepare release notes')
      await page.click('接受这一版')
      expect(page.bridge.acceptArtifact).toHaveBeenCalledOnce()
      expect(page.dom.document.body.textContent).toContain('已接受')
    } finally {
      await page.cleanup()
    }
  })

  it('opens the selected immutable artifact through Main', async () => {
    const page = await mountPage()
    try {
      await page.click('Prepare release notes')
      await page.click('查看这一版')
      expect(page.bridge.openArtifact).toHaveBeenCalledWith('task-1', 'artifact-1')
    } finally {
      await page.cleanup()
    }
  })

  it('loads current enabled employees and workflows before opening handoff', async () => {
    const page = await mountPage()
    try {
      await page.click('Prepare release notes')
      await page.click('交接')
      expect(page.dom.document.body.textContent).toContain('交给谁执行')
      expect(page.dom.document.body.textContent).toContain('编辑')
      expect(page.dom.document.body.textContent).toContain('报告流程')
    } finally {
      await page.cleanup()
    }
  })

  it('restores the selected task when an executor explicitly returns to Work Items', async () => {
    const page = await mountPage({ navigation: createWorkItemNavigation({ destination: 'work-items', source: 'employees', taskId: 'task-1' }) })
    try {
      expect(page.dom.document.body.textContent).toContain('Prepare the release notes')
    } finally {
      await page.cleanup()
    }
  })

  it('keeps a newer event when an older selected-task response resolves late', async () => {
    const earlier = snapshot()
    const lateGet = deferred<WorkTaskSnapshot | undefined>()
    const page = await mountPage({ get: () => lateGet.promise })
    try {
      await page.click('Prepare release notes')
      const newer = snapshot({ task: { ...earlier.task, revision: 3, requirements: [{ ...earlier.task.requirements[0], goal: 'Use the corrected release notes' }] } })
      await page.emit(newer)
      await act(async () => { lateGet.resolve(earlier); await Promise.resolve(); await Promise.resolve() })
      expect(page.dom.document.body.textContent).toContain('Use the corrected release notes')
      expect(page.dom.document.body.textContent).not.toContain('Prepare the release notes')
    } finally {
      await page.cleanup()
    }
  })

  it('shows the offline reading notice without inventing a new task', async () => {
    const page = await mountPage({ runtimeAvailable: false })
    try {
      expect(page.dom.document.body.textContent).toContain('Runtime 当前不可用')
      expect(page.bridge.list).toHaveBeenCalledOnce()
      expect(page.bridge.get).not.toHaveBeenCalled()
    } finally {
      await page.cleanup()
    }
  })

  it('renders an explicit empty state and keeps unassigned records visible', async () => {
    const empty = await mountPage({ list: async () => [] })
    try {
      expect(empty.dom.document.body.textContent).toContain('还没有工作项')
    } finally {
      await empty.cleanup()
    }
    const unassigned = await mountPage({ list: async () => [snapshot({ task: { ...workTaskFixture(), scope: { resourceRefs: [] } } })] })
    try {
      expect(unassigned.dom.document.body.textContent).toContain('未归入项目')
    } finally {
      await unassigned.cleanup()
    }
  })

  it('reopens from a fresh mount by reading the durable bridge again', async () => {
    const first = await mountPage()
    await first.cleanup()
    const second = await mountPage()
    try {
      expect(second.bridge.list).toHaveBeenCalledOnce()
      expect(second.dom.document.body.textContent).toContain('Prepare release notes')
    } finally {
      await second.cleanup()
    }
  })

  it('does not let a pending detail read strand a later list refresh in loading state', async () => {
    const lateGet = deferred<WorkTaskSnapshot | undefined>()
    const page = await mountPage({ get: () => lateGet.promise })
    try {
      await page.click('Prepare release notes')
      await page.click('刷新任务')
      expect(page.bridge.list).toHaveBeenCalledTimes(2)
      const refreshButton = Array.from(page.dom.document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '刷新任务') as HTMLButtonElement
      expect(refreshButton.disabled).toBe(false)
    } finally {
      await page.cleanup()
    }
  })

  it('keeps a refresh loading boundary independent from a detail read started during refresh', async () => {
    const refresh = deferred<WorkTaskSnapshot[]>()
    let listCalls = 0
    const page = await mountPage({
      list: async () => {
        listCalls += 1
        return listCalls === 1 ? [snapshot()] : refresh.promise
      },
    })
    try {
      await page.click('刷新任务')
      await page.click('Prepare release notes')
      await act(async () => { refresh.resolve([snapshot()]); await Promise.resolve(); await Promise.resolve() })
      const refreshButton = Array.from(page.dom.document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '刷新任务') as HTMLButtonElement
      expect(refreshButton.disabled).toBe(false)
    } finally {
      await page.cleanup()
    }
  })

  it('rejects stale snapshots in the view model', () => {
    const current = snapshot({ task: { ...workTaskFixture(), revision: 3 } })
    const stale = snapshot({ task: { ...workTaskFixture(), revision: 2 } })
    expect(shouldApplySnapshot(current, stale)).toBe(false)
    expect(mergeSnapshot(new Map([[current.task.id, current]]), stale).get(current.task.id)?.task.revision).toBe(3)
  })
})
