import { createWindow } from '@mixmark-io/domino'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { Simulate } from 'react-dom/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { WorkItemDetail } from '../../src/renderer/work-items/WorkItemDetail.js'
import { WorkItemsPage } from '../../src/renderer/work-items/WorkItemsPage.js'
import { mergeSnapshot, shouldApplySnapshot } from '../../src/renderer/work-items/work-item-view-model.js'
import { createWorkItemNavigation } from '../../src/renderer/work-items/work-item-navigation.js'
import { getAppCopy } from '../../src/shared/locale.js'
import type {
  WorkActionAnswerRequest,
  WorkItemQuery,
  WorkRunControlRequest,
  WorkTaskArchiveRequest,
  WorkTaskCreateRequest,
  WorkTaskExecuteRequest,
  WorkTaskSnapshot,
} from '../../src/shared/work-items.js'
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

function quietTask(id: string, title: string, projectId?: string): WorkTaskSnapshot {
  const base = workTaskFixture()
  return snapshot({
    task: {
      ...base,
      id,
      title,
      scope: { ...(projectId === undefined ? {} : { projectId, cwd: `/workspace/${projectId}` }), resourceRefs: [] },
    },
    attempts: [],
    runs: [],
    artifacts: [],
    actions: [],
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve }
}

async function mountPage(options: {
  list?: (query?: WorkItemQuery) => Promise<WorkTaskSnapshot[]>
  get?: (taskId: string) => Promise<WorkTaskSnapshot | undefined>
  create?: (request: WorkTaskCreateRequest) => Promise<WorkTaskSnapshot>
  execute?: (request: WorkTaskExecuteRequest) => Promise<WorkTaskSnapshot>
  archive?: (request: WorkTaskArchiveRequest) => Promise<WorkTaskSnapshot>
  answerAction?: (request: WorkActionAnswerRequest) => Promise<WorkTaskSnapshot>
  controlRun?: (request: WorkRunControlRequest) => Promise<WorkTaskSnapshot>
  acceptArtifact?: (request: import('../../src/shared/work-items.js').WorkArtifactAcceptRequest) => Promise<WorkTaskSnapshot>
  openArtifact?: (taskId: string, artifactId: string) => Promise<void>
  listEmployees?: () => Promise<Array<{ id: string; name: string; role: string; enabled: boolean }>>
  listProjects?: () => Promise<Array<{ projectId: string; path: string; title: string; sessionIds: string[] }>>
  listWorkflows?: () => Promise<Array<{ id: string; name: string; enabled: boolean; revision: number }>>
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
    create: vi.fn(options.create ?? (async () => snapshot())),
    execute: vi.fn(options.execute ?? (async () => snapshot())),
    archive: vi.fn(options.archive ?? (async (request: WorkTaskArchiveRequest) => snapshot({ task: { ...workTaskFixture(), revision: 3, ...(request.archived ? { archivedAt: '2026-09-16T08:00:00.000Z' } : {}) } }))),
    answerAction: vi.fn(options.answerAction ?? (async () => snapshot())),
    acceptArtifact: vi.fn(options.acceptArtifact ?? (async () => snapshot())),
    openArtifact: vi.fn(options.openArtifact ?? (async () => undefined)),
    controlRun: vi.fn(options.controlRun ?? (async () => snapshot())),
    onChanged: vi.fn((next: (value: WorkTaskSnapshot) => void) => { listener = next; return () => { listener = undefined } }),
  }
  const employees = {
    list: vi.fn(options.listEmployees ?? (async () => [{ id: 'editor', name: '编辑', role: '编辑', enabled: true }])),
    listProjects: vi.fn(options.listProjects ?? (async () => [{ projectId: 'project-1', path: '/workspace/project-1', title: '项目一', sessionIds: [] }])),
  }
  const workflows = { list: vi.fn(options.listWorkflows ?? (async () => [{ id: 'reporting', name: '报告流程', enabled: true, revision: 4 }])) }
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

function pageControl<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
  dom: ReturnType<typeof createWindow>,
  label: string,
): T {
  const result = dom.document.querySelector(`[aria-label="${label}"]`)
  if (result === null) throw new Error(`Missing control: ${label}`)
  return result as T
}

async function changeControl(element: Element, value: string): Promise<void> {
  await act(async () => { Simulate.change(element, { target: { value } } as never) })
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

  it('renders employee identity and highlights failed execution records', () => {
    const current = snapshot({ runs: [{ ...snapshot().runs[0]!, status: 'failed', rawStatus: 'failed' }] })
    const markup = renderToStaticMarkup(<WorkItemDetail
      copy={getAppCopy('zh')}
      snapshot={current}
      employeeDirectory={new Map([['researcher', { name: '林岚', displayName: '林岚', role: '内容策划' }]])}
      onClose={() => {}}
    />)
    expect(markup).toContain('员工 · 林岚（内容策划）')
    expect(markup).toContain('work-item-history-failed')
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

  it('creates an explicit saved work item from the page and keeps it selected', async () => {
    const created = snapshot({
      task: {
        ...workTaskFixture(),
        id: 'task-created',
        revision: 1,
        title: '整理访谈结论',
        scope: { projectId: 'project-1', cwd: '/workspace/project-1', resourceRefs: [] },
        requirements: [{ version: 1, goal: '提炼关键结论', acceptance: '列出来源与下一步', createdAt: '2026-09-16T08:00:00.000Z' }],
        currentRequirementVersion: 1,
      },
      attempts: [], runs: [], artifacts: [], actions: [],
    })
    const page = await mountPage({ create: async () => created })
    try {
      await page.click('新建工作项')
      await changeControl(pageControl(page.dom, '标题'), '整理访谈结论')
      await changeControl(pageControl(page.dom, '目标'), '提炼关键结论')
      await changeControl(pageControl(page.dom, '验收标准'), '列出来源与下一步')
      await changeControl(pageControl(page.dom, '项目'), 'project-1')
      await page.click('只创建')

      expect(page.bridge.create).toHaveBeenCalledWith(expect.objectContaining({
        title: '整理访谈结论',
        goal: '提炼关键结论',
        acceptance: '列出来源与下一步',
        scope: { projectId: 'project-1', cwd: '/workspace/project-1', resourceRefs: [] },
      }))
      expect(page.bridge.execute).not.toHaveBeenCalled()
      expect(page.dom.document.querySelector('[data-work-item-detail="task-created"]')).toBeTruthy()
    } finally {
      await page.cleanup()
    }
  })

  it('keeps a created task when initial execution fails and retries only the execution request', async () => {
    const created = snapshot({
      task: { ...workTaskFixture(), id: 'task-created', revision: 1, title: '安排发布' },
      attempts: [], runs: [], artifacts: [], actions: [],
    })
    const executed = snapshot({ task: { ...created.task, revision: 2, status: 'active' } })
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error('执行器暂时不可用'))
      .mockResolvedValueOnce(executed)
    const page = await mountPage({ create: async () => created, execute })
    try {
      await page.click('新建工作项')
      await changeControl(pageControl(page.dom, '标题'), '安排发布')
      await changeControl(pageControl(page.dom, '目标'), '准备发布材料')
      await changeControl(pageControl(page.dom, '验收标准'), '材料完整')
      await changeControl(pageControl(page.dom, '处理方式'), 'employee')
      await changeControl(pageControl(page.dom, '执行说明'), '检查并整理发布材料')
      await page.click('创建并执行')

      expect(page.bridge.create).toHaveBeenCalledOnce()
      expect(page.bridge.execute).toHaveBeenCalledOnce()
      expect(page.dom.document.body.textContent).toContain('执行器暂时不可用')
      const firstRequest = page.bridge.execute.mock.calls[0]?.[0]

      await page.click('重试执行')
      expect(page.bridge.create).toHaveBeenCalledOnce()
      expect(page.bridge.execute).toHaveBeenCalledTimes(2)
      expect(page.bridge.execute.mock.calls[1]?.[0]).toEqual(firstRequest)
    } finally {
      await page.cleanup()
    }
  })

  it('groups active work by attention and submits approval through Main', async () => {
    const resolved = snapshot({
      task: { ...workTaskFixture(), revision: 3 },
      actions: [{ ...snapshot().actions[0]!, status: 'resolved' }],
    })
    const page = await mountPage({ answerAction: async () => resolved })
    try {
      expect(page.dom.document.querySelector('[data-attention-group="needs-action"]')?.textContent).toContain('Prepare release notes')
      await page.click('Prepare release notes')
      await page.click('同意')
      expect(page.bridge.answerAction).toHaveBeenCalledWith(expect.objectContaining({
        taskId: 'task-1', actionId: 'action-1', expectedSourceEventId: 'event-1', answer: true,
      }))
      expect(page.dom.document.body.textContent).toContain('没有待处理事项')
    } finally {
      await page.cleanup()
    }
  })

  it('filters active work by resolved project and keeps unrelated events out of the visible groups', async () => {
    const alpha = quietTask('task-alpha', 'Alpha task', 'project-1')
    const beta = quietTask('task-beta', 'Beta task', 'project-2')
    const unassigned = quietTask('task-personal', 'Personal task')
    const page = await mountPage({
      list: async () => [alpha, beta, unassigned],
      listProjects: async () => [
        { projectId: 'project-1', path: '/workspace/project-1', title: '项目一', sessionIds: [] },
        { projectId: 'project-2', path: '/workspace/project-2', title: '项目二', sessionIds: [] },
      ],
    })
    try {
      const visible = () => page.dom.document.querySelector('.work-item-attention-view')?.textContent ?? ''
      expect(visible()).toContain('Alpha task')
      expect(visible()).toContain('Beta task')
      expect(visible()).toContain('Personal task')

      await changeControl(pageControl(page.dom, '项目范围'), 'project:project-1')
      expect(visible()).toContain('Alpha task')
      expect(visible()).not.toContain('Beta task')
      expect(visible()).not.toContain('Personal task')
      expect(visible()).toContain('项目一')

      await page.emit({ ...beta, task: { ...beta.task, revision: beta.task.revision + 1, title: 'Updated beta task' } })
      expect(visible()).not.toContain('Updated beta task')

      await changeControl(pageControl(page.dom, '项目范围'), 'unassigned')
      expect(visible()).toContain('Personal task')
      expect(visible()).not.toContain('Alpha task')
    } finally {
      await page.cleanup()
    }
  })

  it('keeps project and archive filters composed', async () => {
    const active = quietTask('task-active', 'Active alpha', 'project-1')
    const archivedAlpha = quietTask('task-archived-alpha', 'Archived alpha', 'project-1')
    archivedAlpha.task.archivedAt = '2026-09-16T08:00:00.000Z'
    const archivedBeta = quietTask('task-archived-beta', 'Archived beta', 'project-2')
    archivedBeta.task.archivedAt = '2026-09-16T08:00:00.000Z'
    const page = await mountPage({
      list: async (query) => query?.includeArchived ? [archivedAlpha, archivedBeta] : [active],
      listProjects: async () => [
        { projectId: 'project-1', path: '/workspace/project-1', title: '项目一', sessionIds: [] },
        { projectId: 'project-2', path: '/workspace/project-2', title: '项目二', sessionIds: [] },
      ],
    })
    try {
      await changeControl(pageControl(page.dom, '项目范围'), 'project:project-1')
      await page.click('查看归档')
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(page.bridge.list).toHaveBeenLastCalledWith({ includeArchived: true })
      const visible = page.dom.document.querySelector('.work-items-list')?.textContent ?? ''
      expect(visible).toContain('Archived alpha')
      expect(visible).not.toContain('Archived beta')
      expect(visible).not.toContain('Active alpha')
    } finally {
      await page.cleanup()
    }
  })

  it('applies an older successful project directory when a newer dialog lookup fails', async () => {
    const initialDirectory = deferred<Array<{ projectId: string; path: string; title: string; sessionIds: string[] }>>()
    let projectCalls = 0
    const task = quietTask('task-alpha', 'Alpha task', 'project-1')
    const page = await mountPage({
      list: async () => [task],
      listProjects: async () => {
        projectCalls += 1
        if (projectCalls === 1) return initialDirectory.promise
        throw new Error('dialog project directory offline')
      },
    })
    try {
      expect(page.dom.document.querySelector('.work-item-attention-view')?.textContent).toContain('project-1')
      await page.click('新建工作项')
      expect(page.dom.document.querySelector('.work-item-create-catalog-notice')?.textContent).toContain('项目')

      await act(async () => {
        initialDirectory.resolve([{ projectId: 'project-1', path: '/workspace/project-1', title: '项目一', sessionIds: [] }])
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(page.dom.document.querySelector('.work-item-attention-view')?.textContent).toContain('项目一')
    } finally {
      await page.cleanup()
    }
  })

  it('shows persisted scope and falls back to a raw project id when the directory has no match', async () => {
    const orphan = quietTask('task-orphan', 'Orphaned project task', 'removed-project')
    orphan.task.scope.resourceRefs = ['docs/brief.md']
    const page = await mountPage({ list: async () => [orphan], get: async () => orphan, listProjects: async () => [] })
    try {
      expect(page.dom.document.querySelector('.work-item-attention-view')?.textContent).toContain('removed-project')
      await page.click('Orphaned project task')
      const scope = page.dom.document.querySelector('[data-work-item-scope-panel="true"]')
      expect(scope?.textContent).toContain('removed-project')
      expect(scope?.textContent).toContain('项目目录不可用')
      expect(scope?.textContent).toContain('/workspace/removed-project')
      expect(scope?.textContent).toContain('docs/brief.md')
      expect(page.dom.document.querySelector('[data-work-item-scope-panel="true"] a')).toBeFalsy()
    } finally {
      await page.cleanup()
    }
  })

  it('opens create-only when optional catalogs fail and reports only the unavailable capabilities', async () => {
    const created = quietTask('task-created-offline', 'Offline capture')
    const page = await mountPage({
      create: async () => created,
      listEmployees: async () => { throw new Error('employee directory offline') },
      listWorkflows: async () => { throw new Error('workflow directory offline') },
      listProjects: async () => { throw new Error('project directory offline') },
    })
    try {
      await page.click('新建工作项')
      expect(page.dom.document.querySelector('.work-item-create-catalog-notice')?.textContent).toContain('员工、Workflow、项目')
      await changeControl(pageControl(page.dom, '标题'), 'Offline capture')
      await changeControl(pageControl(page.dom, '目标'), '先保存任务')
      await changeControl(pageControl(page.dom, '验收标准'), '稍后可继续处理')
      await page.click('只创建')
      expect(page.bridge.create).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Offline capture',
        scope: { resourceRefs: [] },
      }))
      expect(page.bridge.execute).not.toHaveBeenCalled()
    } finally {
      await page.cleanup()
    }
  })

  it('carries the current project filter into an executor and restores it on return', async () => {
    const alpha = snapshot({ task: { ...workTaskFixture(), id: 'task-alpha', title: 'Alpha task', scope: { projectId: 'project-1', cwd: '/workspace/project-1', resourceRefs: [] } } })
    const beta = quietTask('task-beta', 'Beta task', 'project-2')
    const navigations: import('../../src/renderer/work-items/work-item-navigation.js').WorkItemNavigationContext[] = []
    const page = await mountPage({ list: async () => [alpha, beta], get: async () => alpha, onNavigate: (context) => { navigations.push(context) } })
    try {
      await changeControl(pageControl(page.dom, '项目范围'), 'project:project-1')
      await page.click('Alpha task')
      await page.click('打开执行器')
      expect(navigations[0]?.returnTo?.filter).toEqual({ projectId: 'project-1' })
    } finally {
      await page.cleanup()
    }

    const returned = createWorkItemNavigation({
      destination: 'work-items',
      source: 'employees',
      taskId: 'task-alpha',
      returnTo: { destination: 'work-items', source: 'work-items', selectedTaskId: 'task-alpha', filter: { projectId: 'project-1' } },
    })
    const restored = await mountPage({ list: async () => [alpha, beta], get: async () => alpha, navigation: returned })
    try {
      expect(restored.dom.document.querySelector('[data-work-item-detail="task-alpha"]')).toBeTruthy()
      expect(restored.dom.document.querySelector('.work-item-attention-view')?.textContent).not.toContain('Beta task')
      await restored.click('关闭详情')
      expect(restored.dom.document.querySelector('[data-work-item-detail="task-alpha"]')).toBeFalsy()
    } finally {
      await restored.cleanup()
    }
  })

  it('restores the project filter without showing a returned task outside that scope', async () => {
    const alpha = quietTask('task-alpha', 'Alpha task', 'project-1')
    const beta = quietTask('task-beta', 'Beta task', 'project-2')
    const returned = createWorkItemNavigation({
      destination: 'work-items',
      source: 'employees',
      taskId: 'task-beta',
      returnTo: { destination: 'work-items', source: 'work-items', selectedTaskId: 'task-beta', filter: { projectId: 'project-1' } },
    })
    const page = await mountPage({ list: async () => [alpha, beta], get: async () => beta, navigation: returned })
    try {
      expect(page.dom.document.querySelector('.work-item-attention-view')?.textContent).toContain('Alpha task')
      expect(page.dom.document.querySelector('.work-item-attention-view')?.textContent).not.toContain('Beta task')
      expect(page.dom.document.querySelector('[data-work-item-detail="task-beta"]')).toBeFalsy()
    } finally {
      await page.cleanup()
    }
  })

  it('archives only after confirmation and restores from the archived filter', async () => {
    const active = snapshot({ runs: [], actions: [] })
    const archived = snapshot({
      task: { ...active.task, revision: 3, archivedAt: '2026-09-16T08:00:00.000Z' },
      runs: [], actions: [],
    })
    const restored = snapshot({ task: { ...active.task, revision: 4 }, runs: [], actions: [] })
    const archive = vi.fn(async (request: WorkTaskArchiveRequest) => request.archived ? archived : restored)
    const page = await mountPage({
      list: async (query) => query?.includeArchived ? [archived] : [active],
      get: async () => active,
      archive,
    })
    try {
      await page.click('Prepare release notes')
      const archiveButton = Array.from(page.dom.document.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === '归档') as HTMLButtonElement
      await act(async () => { archiveButton.click(); await Promise.resolve() })
      expect(archive).not.toHaveBeenCalled()
      await page.click('确认归档')
      expect(archive).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', expectedRevision: 2, archived: true }))
      expect(page.dom.document.body.textContent).not.toContain('Prepare release notes')

      await page.click('查看归档')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(page.bridge.list).toHaveBeenLastCalledWith({ includeArchived: true })
      await page.click('Prepare release notes')
      await page.click('恢复')
      expect(archive).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: 'task-1', expectedRevision: 3, archived: false }))
      expect(page.dom.document.body.textContent).not.toContain('Prepare release notes')
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

  it.each(['再做一版', '交接'])('opens %s only as a modal overlay outside the detail flow', async (action) => {
    const page = await mountPage()
    try {
      await page.click('Prepare release notes')
      await page.click(action)
      const detail = page.dom.document.querySelector('[data-work-item-detail="task-1"]')
      const dialog = page.dom.document.querySelector('[role="dialog"]')
      expect(page.dom.document.querySelector('.work-item-handoff-backdrop')).toBeTruthy()
      expect(detail?.contains(dialog)).toBe(false)
      expect(dialog?.getAttribute('aria-modal')).toBe('true')
    } finally {
      await page.cleanup()
    }
  })

  it('shows the handoff interaction immediately while executors are still loading', async () => {
    const employees = deferred<Array<{ id: string; name: string; role: string; enabled: boolean }>>()
    const page = await mountPage({ listEmployees: () => employees.promise })
    try {
      await page.click('Prepare release notes')
      await page.click('交接')
      const detail = page.dom.document.querySelector('[data-work-item-detail="task-1"]')
      const dialog = page.dom.document.querySelector('[role="dialog"]')
      expect(dialog).not.toBeNull()
      expect(detail?.contains(dialog)).toBe(false)
      expect(dialog?.textContent).toContain('正在读取可用执行器')
    } finally {
      employees.resolve([])
      await page.cleanup()
    }
  })

  it('keeps a loading handoff closed when its executor request finishes later', async () => {
    const employees = deferred<Array<{ id: string; name: string; role: string; enabled: boolean }>>()
    const page = await mountPage({ listEmployees: () => employees.promise })
    try {
      await page.click('Prepare release notes')
      await page.click('交接')
      const dialog = page.dom.document.querySelector('[role="dialog"]')
      const close = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === '关闭') as HTMLButtonElement
      await act(async () => { close.click(); await Promise.resolve() })
      employees.resolve([])
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(page.dom.document.querySelector('[role="dialog"]')).toBeFalsy()
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
