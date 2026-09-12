import { createWindow } from '@mixmark-io/domino'
import { createRoot } from 'react-dom/client'
import { act, Simulate } from 'react-dom/test-utils'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import * as workflowPage from '../../src/renderer/workflow/WorkflowPage.js'
import { getAppCopy } from '../../src/shared/locale.js'
import { createDefaultWorkflow, type WorkflowDefinition, type WorkflowNodeType, type WorkflowRunRecord } from '../../src/shared/workflow.js'
import type { WorkflowCustomerEnvironment, WorkflowOperationalHealth, WorkflowReleaseSummary } from '../../src/shared/workflow-operations.js'
import { ReactFlow, type Edge, type Node } from '@xyflow/react'
import type { ComponentType } from 'react'

async function unknownOperationalHealth(query: { workflowId: string; environmentId: string }): Promise<WorkflowOperationalHealth> {
  return { ...query, status: 'unknown', reason: 'service-initializing', observedAt: '2026-09-12T00:00:00.000Z', service: { lifecycle: 'initializing' }, worker: { state: 'starting', activeRunCount: 0, consecutiveClaimFailures: 0 }, environment: { state: 'unchecked' }, release: { state: 'unchecked' }, execution: { state: 'unchecked' } }
}

function graphWithRemovedNode(): WorkflowDefinition {
  const workflow = createDefaultWorkflow('Graph')
  const aiTask = workflow.nodes.find((node) => node.type === 'ai-task')
  if (aiTask === undefined) throw new Error('starter graph should contain an AI task')
  return workflow
}

function workflowWithUnknownLoopEffect(): { workflow: WorkflowDefinition; run: WorkflowRunRecord; bodyNodeId: string } {
  const source = createDefaultWorkflow('Effect acceptance')
  const originalLoop = source.nodes.find((node) => node.type === 'ai-task')!
  const body = source.nodes.find((node) => node.type === 'output')!
  const loop = { ...originalLoop, type: 'loop', label: 'Receipt loop', config: { maxIterations: 3 } } as never
  const workflow = {
    ...source,
    nodes: source.nodes.map((node) => node.id === originalLoop.id ? loop : node),
    edges: [{ id: 'loop-body', source: loop.id, target: body.id, sourcePort: 'loop-body' }],
  }
  const run: WorkflowRunRecord = {
    id: 'run-effect-acceptance', workflowId: workflow.id, workflowRevision: workflow.revision, status: 'paused', input: { task: 'send receipts' }, events: [], allowShellFile: false,
    nodeStates: [{ nodeId: loop.id, status: 'cancelled', loopIterations: [{ iterationId: 'iteration-0', iterationIndex: 0, input: { recipient: 'Ada' }, status: 'running', nodeStates: [{ nodeId: body.id, status: 'cancelled', effectState: 'unknown', input: { recipient: 'Ada', receipt: 'R-42' } }] }] }],
    effectReconciliationTargets: [{ key: 'run-effect-acceptance:iteration-0', nodeId: body.id, nodeLabel: body.label, iterationId: 'iteration-0', iterationIndex: 0, loopNodeLabel: loop.label, input: { recipient: 'Ada', receipt: 'R-42' } }],
  }
  return { workflow, run, bodyNodeId: body.id }
}

async function mountWorkflowEffectReviewPage(
  locale: 'zh' | 'en',
  reconcileEffect: (runId: string, request: unknown) => Promise<WorkflowRunRecord>,
  reconcileCompensation?: (runId: string, request: unknown) => Promise<WorkflowRunRecord>,
  compensationMode = false,
  options: { compensationStack?: WorkflowRunRecord['compensationStack']; compensate?: (runId: string) => Promise<WorkflowRunRecord> } = {},
): Promise<{ domWindow: ReturnType<typeof createWindow>; cleanup: () => Promise<void>; workflow: WorkflowDefinition; run: WorkflowRunRecord; bodyNodeId: string; compensate: ReturnType<typeof vi.fn> }> {
  const { workflow, run, bodyNodeId } = workflowWithUnknownLoopEffect()
  if (compensationMode) {
    run.effectReconciliationTargets = []
    run.compensationStack = options.compensationStack ?? [{ sourceNodeId: 'charge', action: { type: 'workflow', workflowId: 'refund' }, status: 'failed', effectState: 'unknown', occurrenceId: 'run-effect-acceptance:compensation:charge:ordinary' }]
  }
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    CustomEvent: globalThis.CustomEvent,
    getComputedStyle: globalThis.getComputedStyle,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH,
  }
  const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  class TestResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const requestAnimationFrame = (_callback: FrameRequestCallback): number => 0
  const cancelAnimationFrame = (_id: number): void => {}
  Object.defineProperty(domWindow.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 960, bottom: 640, width: 960, height: 640, toJSON: () => ({}) }),
  })
  Object.assign(globalThis, {
    window: domWindow,
    document: domWindow.document,
    HTMLElement: domWindow.HTMLElement,
    Element: domWindow.Element,
    Node: domWindow.Node,
    Event: domWindow.Event,
    MouseEvent: domWindow.MouseEvent,
    KeyboardEvent: domWindow.KeyboardEvent,
    CustomEvent: domWindow.CustomEvent,
    getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
    ResizeObserver: TestResizeObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
  })
  Object.assign(domWindow as unknown as Record<string, unknown>, { ResizeObserver: TestResizeObserver, requestAnimationFrame, cancelAnimationFrame })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
  const compensate = vi.fn(options.compensate ?? (async () => run))
  const bridge = {
    workflows: {
      list: vi.fn(async () => [workflow]),
      listRuns: vi.fn(async () => [run]),
      getRunDefinition: vi.fn(async () => workflow),
      reconcileEffect,
      reconcileCompensation: reconcileCompensation ?? (async () => run),
      compensate,
      onStateChange: vi.fn(() => () => {}),
      listModificationHistory: vi.fn(async () => []),
      onModificationStateChange: vi.fn(() => () => {}),
    },
    employees: { list: vi.fn(async () => []), onStateChange: vi.fn(() => () => {}) },
    workflowCredentials: { list: vi.fn(async () => []) },
    workflowConnectors: { list: vi.fn(async () => []) },
    workflowEnvironments: { list: vi.fn(async () => []) },
    workflowReleases: { list: vi.fn(async () => []), listObservations: vi.fn(async () => []), getOperationalHealth: vi.fn(unknownOperationalHealth) },
  }
  ;(globalThis as { EzDSH?: unknown }).EzDSH = bridge
  ;(domWindow as unknown as { EzDSH?: unknown }).EzDSH = bridge
  const root = createRoot(domWindow.document.getElementById('root')!)
  await act(async () => {
    root.render(<workflowPage.WorkflowPage copy={getAppCopy(locale)} locale={locale} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const open = domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement
  await act(async () => { open.click(); await Promise.resolve() })
  const executions = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy(locale).workflowExecutions) as HTMLButtonElement
  await act(async () => { executions.click(); await Promise.resolve() })
  const runButton = domWindow.document.querySelector('.workflow-run-item-main') as HTMLButtonElement
  await act(async () => { runButton.click(); await Promise.resolve() })
  return {
    domWindow,
    workflow,
    run,
    bodyNodeId,
    compensate,
    cleanup: async () => {
      await act(async () => { root.unmount() })
      delete (globalThis as { EzDSH?: unknown }).EzDSH
      const { navigator: previousNavigator, ...previousGlobalsWithoutNavigator } = previousGlobals
      Object.assign(globalThis, previousGlobalsWithoutNavigator)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    },
  }
}

async function mountWorkflowRunCachePage(workflows: Record<string, unknown>): Promise<{
  domWindow: ReturnType<typeof createWindow>
  settle: () => Promise<void>
  cleanup: () => Promise<void>
}> {
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    CustomEvent: globalThis.CustomEvent,
    getComputedStyle: globalThis.getComputedStyle,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH,
  }
  const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
  const requestAnimationFrame = (_callback: FrameRequestCallback): number => 0
  const cancelAnimationFrame = (_id: number): void => {}
  Object.defineProperty(domWindow.HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 960, bottom: 640, width: 960, height: 640, toJSON: () => ({}) }) })
  Object.assign(globalThis, { window: domWindow, document: domWindow.document, HTMLElement: domWindow.HTMLElement, Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, CustomEvent: domWindow.CustomEvent, getComputedStyle: domWindow.getComputedStyle.bind(domWindow), ResizeObserver: TestResizeObserver, requestAnimationFrame, cancelAnimationFrame })
  Object.assign(domWindow as unknown as Record<string, unknown>, { ResizeObserver: TestResizeObserver, requestAnimationFrame, cancelAnimationFrame, confirm: () => true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
  const bridge = {
    workflows: { getRunDefinition: vi.fn(async () => undefined), ...workflows },
    employees: { list: vi.fn(async () => []), onStateChange: vi.fn(() => () => {}) },
    workflowCredentials: { list: vi.fn(async () => []) },
    workflowConnectors: { list: vi.fn(async () => []) },
    workflowEnvironments: { list: vi.fn(async () => []), upsert: vi.fn() },
    workflowReleases: { list: vi.fn(async () => []), publish: vi.fn(), start: vi.fn(), rollback: vi.fn(), listObservations: vi.fn(async () => []), getOperationalHealth: vi.fn(unknownOperationalHealth) },
  }
  ;(globalThis as { EzDSH?: unknown }).EzDSH = bridge
  ;(domWindow as unknown as { EzDSH?: unknown }).EzDSH = bridge
  const root = createRoot(domWindow.document.getElementById('root')!)
  const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) }
  await act(async () => { root.render(<workflowPage.WorkflowPage copy={getAppCopy('zh')} locale="zh" />); await settle() })
  return {
    domWindow,
    settle,
    cleanup: async () => {
      await act(async () => { root.unmount() })
      delete (globalThis as { EzDSH?: unknown }).EzDSH
      const { navigator: previousNavigator, ...rest } = previousGlobals
      Object.assign(globalThis, rest)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    },
  }
}

describe('release operational health', () => {
  const environment: WorkflowCustomerEnvironment = { id: 'health-env', customerName: 'Acme', name: 'Production', kind: 'production', status: 'active', connectorIds: [], allowShellFile: false, allowCode: false, createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' }
  const workflow = createDefaultWorkflow('Operational health')
  const healthy = (workflowId = workflow.id): WorkflowOperationalHealth => ({
    workflowId, environmentId: environment.id, status: 'healthy', reason: 'healthy', observedAt: '2026-09-12T00:01:00.000Z',
    service: { lifecycle: 'accepting' }, worker: { state: 'ready', consecutiveClaimFailures: 0, activeRunCount: 1, activeRunHeartbeatAt: '2026-09-12T00:00:59.000Z', lastPollSucceededAt: '2026-09-12T00:00:58.000Z' },
    environment: { state: 'active' }, release: { state: 'active', id: 'health-release', revision: 3, activation: { kind: 'publish', at: '2026-09-12T00:00:01.000Z' } },
    execution: { state: 'completed', runId: 'health-run', time: '2026-09-12T00:00:10.000Z' },
  })
  const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } => {
    let resolve!: (value: T) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  async function mount(getOperationalHealth = vi.fn(async (_query: { workflowId: string; environmentId: string }) => healthy())) {
    const previousGlobals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent, KeyboardEvent: globalThis.KeyboardEvent, CustomEvent: globalThis.CustomEvent, getComputedStyle: globalThis.getComputedStyle, EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH }
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, { window: domWindow, document: domWindow.document, HTMLElement: domWindow.HTMLElement, Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, CustomEvent: domWindow.CustomEvent, getComputedStyle: domWindow.getComputedStyle.bind(domWindow) })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
    const release: WorkflowReleaseSummary = { id: 'health-release', environmentId: environment.id, workflowId: workflow.id, workflowRevision: 3, contentSha256: 'a'.repeat(64), status: 'published', createdAt: environment.createdAt, publishedAt: environment.createdAt, launchFields: [] }
    const bridge = { workflowEnvironments: { list: vi.fn(async () => [environment]), upsert: vi.fn() }, workflowReleases: {
      getHealth: vi.fn(async () => healthy()), getOperationalHealth,
      list: vi.fn(async () => [release, { ...release, id: 'old-release', status: 'superseded' as const }]), listObservations: vi.fn(async () => []),
      publish: vi.fn(async () => release), rollback: vi.fn(async () => release), start: vi.fn(async () => ({ id: 'new-run', workflowId: workflow.id, status: 'queued' })),
    } }
    ;(globalThis as { EzDSH?: unknown }).EzDSH = bridge
    const root = createRoot(domWindow.document.getElementById('root')!)
    vi.useFakeTimers()
    const render = async (target = workflow, active = true): Promise<void> => { await act(async () => { root.render(<workflowPage.WorkflowReleasePanel copy={getAppCopy('zh')} locale="en" workflow={target} active={active} />) }) }
    await render()
    let unmounted = false
    return {
      bridge, render, document: domWindow.document,
      text: () => domWindow.document.body.textContent ?? '',
      tick: async (ms = 5000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) },
      click: async (label: string) => { const button = Array.from(domWindow.document.querySelectorAll('button')).find((item) => item.textContent === label); expect(button, label).toBeTruthy(); await act(async () => { button!.click() }) },
      unmount: async () => { await act(async () => { root.unmount() }); unmounted = true },
      cleanup: async () => {
        if (!unmounted) await act(async () => { root.unmount() })
        vi.useRealTimers()
        const { navigator: previousNavigator, ...rest } = previousGlobals
        Object.assign(globalThis, rest)
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
      },
    }
  }

  it('queries the exact target and renders only safe local operational evidence', async () => {
    const getHealth = vi.fn(async (_query: { workflowId: string; environmentId: string }) => ({ ...healthy(), secret: 'DO-NOT-RENDER', workflowSnapshot: { name: 'DO-NOT-RENDER' } }))
    const view = await mount(getHealth)
    try {
      expect(getHealth).toHaveBeenCalledWith({ workflowId: workflow.id, environmentId: environment.id })
      expect(view.bridge.workflowReleases.getHealth).not.toHaveBeenCalled()
      for (const text of ['healthy', 'Observed at', healthy().observedAt, 'Local process evidence only', 'Service', 'accepting', 'Worker', 'ready', 'Environment', 'active', 'Release', 'health-release', 'v3', 'publish', 'Execution', 'health-run', 'completed', '2026-09-12T00:00:59.000Z']) expect(view.text()).toContain(text)
      expect(view.text()).not.toContain('DO-NOT-RENDER')
    } finally { await view.cleanup() }
  })

  it('polls healthy to degraded on the same target five seconds after completion', async () => {
    const getHealth = vi.fn(async (_query: { workflowId: string; environmentId: string }) => healthy())
    const view = await mount(getHealth)
    try {
      expect(view.text()).toContain('Health: healthy')
      getHealth.mockResolvedValue({ ...healthy(), status: 'degraded', reason: 'worker-backing-off', worker: { ...healthy().worker, state: 'backing-off' } })
      await view.tick(4999)
      expect(getHealth).toHaveBeenCalledTimes(1)
      await view.tick(1)
      expect(view.text()).toContain('Health: degraded')
      expect(view.text()).toContain('worker-backing-off')
      expect(view.text()).not.toContain('Health: healthy')
    } finally { await view.cleanup() }
  })

  it('clears old green immediately on health failure even when release metadata is pending, and redacts errors', async () => {
    const getHealth = vi.fn(async (_query: { workflowId: string; environmentId: string }) => healthy())
    const view = await mount(getHealth)
    const metadata = deferred<WorkflowReleaseSummary[]>()
    try {
      expect(view.text()).toContain('Health: healthy')
      view.bridge.workflowReleases.list.mockReturnValue(metadata.promise)
      getHealth.mockRejectedValue(new Error('Bearer DO-NOT-RENDER'))
      await view.click('Refresh health')
      expect(view.text()).toContain('Unable to read operational health')
      expect(view.text()).not.toContain('Health: healthy')
      expect(view.text()).not.toContain('DO-NOT-RENDER')
      getHealth.mockResolvedValue(healthy())
      await view.tick()
      expect(view.text()).toContain('Health: healthy')
      expect(view.text()).not.toContain('Unable to read operational health')
    } finally { metadata.resolve([]); await view.cleanup() }
  })

  it('never overlaps slow requests and starts the next poll only after settlement', async () => {
    const pending = deferred<WorkflowOperationalHealth>()
    const getHealth = vi.fn((_query: { workflowId: string; environmentId: string }) => pending.promise)
    const view = await mount(getHealth)
    try {
      await view.tick(20000)
      expect(getHealth).toHaveBeenCalledTimes(1)
      await act(async () => { pending.resolve(healthy()) })
      await view.tick(4999)
      expect(getHealth).toHaveBeenCalledTimes(1)
      await view.tick(1)
      expect(getHealth).toHaveBeenCalledTimes(2)
    } finally { pending.resolve(healthy()); await view.cleanup() }
  })

  it('coalesces manual refresh while a request is pending without overlap', async () => {
    const pending = deferred<WorkflowOperationalHealth>()
    const getHealth = vi.fn((_query: { workflowId: string; environmentId: string }) => pending.promise)
    const view = await mount(getHealth)
    try {
      await view.click('Refresh health')
      await view.click('Refresh health')
      expect(getHealth).toHaveBeenCalledTimes(1)
      getHealth.mockResolvedValue({ ...healthy(), status: 'degraded', reason: 'worker-stale' })
      await act(async () => { pending.resolve(healthy()) })
      expect(getHealth).toHaveBeenCalledTimes(2)
      expect(view.text()).toContain('Health: degraded')
    } finally { pending.resolve(healthy()); await view.cleanup() }
  })

  it('invalidates pending responses and timers on unmount', async () => {
    const pending = deferred<WorkflowOperationalHealth>()
    const getHealth = vi.fn((_query: { workflowId: string; environmentId: string }) => pending.promise)
    const view = await mount(getHealth)
    try {
      expect(getHealth).toHaveBeenCalledTimes(1)
      await view.unmount()
      await act(async () => { pending.resolve(healthy()) })
      await view.tick(20000)
      expect(getHealth).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { pending.resolve(healthy()); await view.cleanup() }
  })

  it('invalidates stale target responses including an A to B to A race', async () => {
    const pending = deferred<WorkflowOperationalHealth>()
    const getHealth = vi.fn((_query: { workflowId: string; environmentId: string }) => pending.promise)
    const view = await mount(getHealth)
    try {
      await view.render({ ...workflow, id: 'other-workflow' })
      await view.render(workflow)
      getHealth.mockResolvedValue({ ...healthy(), status: 'degraded', reason: 'worker-stale' })
      await act(async () => { pending.resolve(healthy()) })
      expect(view.text()).toContain('Health: degraded')
      expect(view.text()).not.toContain('Health: healthy')
      expect(getHealth.mock.calls.at(-1)?.[0]).toEqual({ workflowId: workflow.id, environmentId: environment.id })
    } finally { pending.resolve(healthy()); await view.cleanup() }
  })

  it('stops polling while hidden or without a target and refreshes immediately when visible', async () => {
    const view = await mount()
    try {
      await view.render(workflow, false)
      await view.tick(20000)
      expect(view.bridge.workflowReleases.getOperationalHealth).toHaveBeenCalledTimes(1)
      await view.render(workflow, true)
      expect(view.bridge.workflowReleases.getOperationalHealth).toHaveBeenCalledTimes(2)
      const select = view.document.querySelector('select')!
      await act(async () => { Simulate.change(select, { target: { value: '' } }) })
      await view.tick(20000)
      expect(view.bridge.workflowReleases.getOperationalHealth).toHaveBeenCalledTimes(2)
      expect(view.text()).not.toContain('Health: healthy')
    } finally { await view.cleanup() }
  })

  it('refreshes immediately after publishing, rollback and starting a release', async () => {
    const view = await mount()
    try {
      await view.click('Publish to customer environment')
      expect(view.bridge.workflowReleases.getOperationalHealth).toHaveBeenCalledTimes(2)
      await view.click('Rollback')
      expect(view.bridge.workflowReleases.getOperationalHealth).toHaveBeenCalledTimes(3)
      await view.click('Start release')
      const button = view.document.querySelector<HTMLButtonElement>('[role="dialog"] .workflow-button-primary')!
      expect(button).toBeTruthy()
      await act(async () => { button.click() })
      expect(view.bridge.workflowReleases.start).toHaveBeenCalledTimes(1)
      expect(view.bridge.workflowReleases.getOperationalHealth).toHaveBeenCalledTimes(4)
    } finally { await view.cleanup() }
  })

  it('ignores pending health when the document is hidden and refreshes on visibility restoration', async () => {
    const pending = deferred<WorkflowOperationalHealth>()
    const getHealth = vi.fn((_query: { workflowId: string; environmentId: string }) => pending.promise)
    const view = await mount(getHealth)
    const visibility = async (state: string) => { await act(async () => {
      Object.defineProperty(view.document, 'visibilityState', { configurable: true, value: state })
      view.document.dispatchEvent(new Event('visibilitychange'))
    }) }
    try {
      await visibility('hidden')
      await act(async () => { pending.resolve(healthy()) })
      expect(view.text()).not.toContain('Health: healthy')
      await view.tick(20000)
      expect(getHealth).toHaveBeenCalledTimes(1)
      await visibility('visible')
      expect(getHealth).toHaveBeenCalledTimes(2)
      expect(view.text()).toContain('Health: healthy')
    } finally { pending.resolve(healthy()); await view.cleanup() }
  })

  it('fails closed on an absent operational snapshot rather than silently treating it as a successful read', async () => {
    const getHealth = vi.fn(async (_query: { workflowId: string; environmentId: string }) => healthy())
    const view = await mount(getHealth)
    try {
      getHealth.mockResolvedValue(undefined as unknown as WorkflowOperationalHealth)
      await view.click('Refresh health')
      expect(view.text()).toContain('Unable to read operational health')
      expect(view.text()).not.toContain('Health: healthy')
    } finally { await view.cleanup() }
  })

  it('does not retain old green when a superseded pending query fails before the fresh query settles', async () => {
    const getHealth = vi.fn(async (_query: { workflowId: string; environmentId: string }) => healthy())
    const view = await mount(getHealth)
    const old = deferred<WorkflowOperationalHealth>()
    const fresh = deferred<WorkflowOperationalHealth>()
    try {
      getHealth.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
      await view.tick()
      await view.click('Refresh health')
      await act(async () => { old.reject(new Error('superseded')) })
      expect(view.text()).not.toContain('Health: healthy')
      expect(getHealth).toHaveBeenCalledTimes(3)
      await act(async () => { fresh.resolve({ ...healthy(), status: 'degraded', reason: 'worker-stale' }) })
      expect(view.text()).toContain('Health: degraded')
    } finally { old.resolve(healthy()); fresh.resolve(healthy()); await view.cleanup() }
  })
})

describe('WorkflowPage regressions', () => {
  it('publishes the selected workflow revision into a selected customer environment', async () => {
    const workflow = createDefaultWorkflow('发布控制')
    const publish = vi.fn(async () => undefined)
    const listEnvironments = vi.fn(async () => [{
      id: 'customer-acme-prod',
      customerName: 'Acme',
      name: 'Acme Production',
      kind: 'production',
      status: 'active',
      connectorIds: [],
      allowShellFile: false,
      allowCode: false,
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
    }])
    const previousGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      navigator: globalThis.navigator,
      HTMLElement: globalThis.HTMLElement,
      Node: globalThis.Node,
      Event: globalThis.Event,
      MouseEvent: globalThis.MouseEvent,
      KeyboardEvent: globalThis.KeyboardEvent,
      CustomEvent: globalThis.CustomEvent,
      getComputedStyle: globalThis.getComputedStyle,
      EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH,
    }
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, {
      window: domWindow,
      document: domWindow.document,
      HTMLElement: domWindow.HTMLElement,
      Node: domWindow.Node,
      Event: domWindow.Event,
      MouseEvent: domWindow.MouseEvent,
      KeyboardEvent: domWindow.KeyboardEvent,
      CustomEvent: domWindow.CustomEvent,
      getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
    })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
    ;(globalThis as { EzDSH?: unknown }).EzDSH = {
      workflowEnvironments: {
        list: listEnvironments,
        upsert: vi.fn(),
      },
      workflowReleases: {
        publish,
        list: vi.fn(async () => []),
        get: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
        listObservations: vi.fn(async () => []),
        getOperationalHealth: vi.fn(unknownOperationalHealth),
      },
    }

    try {
      const root = createRoot(domWindow.document.getElementById('root')!)
      await act(async () => {
        root.render(<workflowPage.WorkflowReleasePanel copy={getAppCopy('zh')} workflow={workflow} />)
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      const button = domWindow.document.querySelector('button[type="button"]')
      if (button === null) throw new Error('release publish button should render')
      expect(button.textContent).toContain('发布到客户环境')
      expect(button.hasAttribute('disabled')).toBe(false)
      await act(async () => {
        button.click()
        await Promise.resolve()
      })
      expect(publish).toHaveBeenCalledWith({ workflowId: workflow.id, environmentId: 'customer-acme-prod' })
    } finally {
      delete (globalThis as { EzDSH?: unknown }).EzDSH
      const { navigator: previousNavigator, ...previousGlobalsWithoutNavigator } = previousGlobals
      Object.assign(globalThis, previousGlobalsWithoutNavigator)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    }
  })

  it('shows workflow release controls in the browser view', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowPage copy={getAppCopy('zh')} locale="zh" />,
    )

    expect(markup).toContain('发布到客户环境')
  })

  it('localizes release-summary boundaries and selector placeholders in English', () => {
    const markup = renderToStaticMarkup(<workflowPage.WorkflowReleasePanel
      copy={getAppCopy('en')}
      locale="en"
      workflows={[createDefaultWorkflow('English workflow')]}
    />)

    expect(markup).toContain('The release summary excludes run input and output, credentials, and request headers.')
    expect(markup).toContain('Select workflow')
    expect(markup).not.toContain('Renderer 只接收')
  })

  it('opens a frozen typed release form and starts with parsed default-applied input only', async () => {
    const workflow = createDefaultWorkflow('编辑中的 v2')
    const record: WorkflowRunRecord = { id: 'run-frozen-v1', workflowId: workflow.id, workflowRevision: 1, releaseId: 'release-v1', environmentId: 'customer-acme-prod', status: 'queued', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    const environment: WorkflowCustomerEnvironment = { id: 'customer-acme-prod', customerName: 'Acme', name: 'Production', kind: 'production', status: 'active', connectorIds: [], allowShellFile: false, allowCode: false, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' }
    const release: WorkflowReleaseSummary = {
      id: 'release-v1', environmentId: environment.id, workflowId: workflow.id, workflowRevision: 1, contentSha256: 'a'.repeat(64), status: 'published', createdAt: environment.createdAt, publishedAt: environment.createdAt,
      launchFields: [
        { name: 'topic', label: 'v1 主题', type: 'string', required: true },
        { name: 'count', label: '数量', type: 'number', defaultValue: 2 },
        { name: 'enabled', label: '启用', type: 'boolean', defaultValue: false },
        { name: 'payload', label: '参数', type: 'json', defaultValue: { mode: 'safe' } },
        { name: 'document', label: '文档', type: 'file', defaultValue: 'docs/a.txt' },
        { name: 'attachments', label: '附件', type: 'file-list', defaultValue: ['docs/a.txt', 'docs/b.txt'] },
      ],
    }
    const start = vi.fn(async () => record)
    const onRunStarted = vi.fn()
    const previousGlobals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent, KeyboardEvent: globalThis.KeyboardEvent, CustomEvent: globalThis.CustomEvent, getComputedStyle: globalThis.getComputedStyle, EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH }
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, { window: domWindow, document: domWindow.document, HTMLElement: domWindow.HTMLElement, Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, CustomEvent: domWindow.CustomEvent, getComputedStyle: domWindow.getComputedStyle.bind(domWindow) })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
    const bridge = {
      workflowEnvironments: { list: vi.fn(async () => [environment]), upsert: vi.fn() },
      workflowReleases: { list: vi.fn(async () => [release]), publish: vi.fn(), start, rollback: vi.fn(), listObservations: vi.fn(async () => []), getOperationalHealth: vi.fn(unknownOperationalHealth) },
    }
    ;(globalThis as { EzDSH?: unknown }).EzDSH = bridge
    ;(domWindow as unknown as { EzDSH?: unknown }).EzDSH = bridge
    const root = createRoot(domWindow.document.getElementById('root')!)
    try {
      await act(async () => { root.render(<workflowPage.WorkflowReleasePanel copy={getAppCopy('zh')} workflow={workflow} onRunStarted={onRunStarted} />); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) })
      const openButton = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '启动发布') as HTMLButtonElement
      await act(async () => { openButton.click() })

      const dialog = domWindow.document.querySelector('[role="dialog"]') as HTMLElement
      expect(dialog).not.toBeNull()
      expect(start).not.toHaveBeenCalled()
      expect(dialog.textContent).toContain('v1 主题 *')
      expect(dialog.querySelectorAll('select')).toHaveLength(0)
      expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
      const topic = dialog.querySelector('textarea[aria-label="v1 主题"]') as HTMLTextAreaElement
      expect(topic.getAttribute('aria-required')).toBe('true')
      await act(async () => { Simulate.change(topic, { target: { value: '发布主题' } }) })
      const submit = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowStartRun) as HTMLButtonElement
      await act(async () => { submit.click(); await Promise.resolve() })

      expect(start).toHaveBeenCalledWith('release-v1', {
        topic: '发布主题', count: 2, enabled: false, payload: { mode: 'safe' }, document: 'docs/a.txt', attachments: ['docs/a.txt', 'docs/b.txt'],
      })
      expect(onRunStarted).toHaveBeenCalledWith(record)
    } finally {
      await act(async () => { root.unmount() })
      delete (globalThis as { EzDSH?: unknown }).EzDSH
      const { navigator: previousNavigator, ...rest } = previousGlobals
      Object.assign(globalThis, rest)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    }
  })

  it('keeps a missing required-by-default release input in the dialog without calling Main', async () => {
    const workflow = createDefaultWorkflow('发布校验')
    const environment: WorkflowCustomerEnvironment = { id: 'customer-acme-prod', customerName: 'Acme', name: 'Production', kind: 'production', status: 'active', connectorIds: [], allowShellFile: false, allowCode: false, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' }
    const release: WorkflowReleaseSummary = { id: 'release-invalid', environmentId: environment.id, workflowId: workflow.id, workflowRevision: 1, contentSha256: 'a'.repeat(64), status: 'published', createdAt: environment.createdAt, publishedAt: environment.createdAt, launchFields: [{ name: 'title', label: '标题', type: 'string' }] }
    const start = vi.fn()
    const previousGlobals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent, KeyboardEvent: globalThis.KeyboardEvent, CustomEvent: globalThis.CustomEvent, getComputedStyle: globalThis.getComputedStyle, EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH }
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, { window: domWindow, document: domWindow.document, HTMLElement: domWindow.HTMLElement, Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, CustomEvent: domWindow.CustomEvent, getComputedStyle: domWindow.getComputedStyle.bind(domWindow) })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
    const bridge = { workflowEnvironments: { list: vi.fn(async () => [environment]), upsert: vi.fn() }, workflowReleases: { list: vi.fn(async () => [release]), publish: vi.fn(), start, rollback: vi.fn(), listObservations: vi.fn(async () => []), getOperationalHealth: vi.fn(unknownOperationalHealth) } }
    ;(globalThis as { EzDSH?: unknown }).EzDSH = bridge
    ;(domWindow as unknown as { EzDSH?: unknown }).EzDSH = bridge
    const root = createRoot(domWindow.document.getElementById('root')!)
    try {
      await act(async () => { root.render(<workflowPage.WorkflowReleasePanel copy={getAppCopy('zh')} workflow={workflow} />); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) })
      const openButton = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '启动发布') as HTMLButtonElement
      await act(async () => { openButton.click() })
      const dialog = domWindow.document.querySelector('[role="dialog"]') as HTMLElement
      const title = dialog.querySelector('textarea[aria-label="标题"]') as HTMLTextAreaElement
      expect(title.getAttribute('aria-required')).toBe('true')
      const submit = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowStartRun) as HTMLButtonElement
      await act(async () => { submit.click(); await Promise.resolve() })
      expect(start).not.toHaveBeenCalled()
      expect(dialog.textContent).toContain('“标题”为必填项。')
    } finally {
      await act(async () => { root.unmount() })
      delete (globalThis as { EzDSH?: unknown }).EzDSH
      const { navigator: previousNavigator, ...rest } = previousGlobals
      Object.assign(globalThis, rest)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    }
  })

  it('waits for an async workflow selection before exposing a matching release start', async () => {
    const workflowA = createDefaultWorkflow('工作流 A')
    const workflowB = createDefaultWorkflow('工作流 B')
    const environment: WorkflowCustomerEnvironment = { id: 'environment-a', customerName: 'Acme', name: 'A', kind: 'production', status: 'active', connectorIds: [], allowShellFile: false, allowCode: false, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' }
    const releaseA: WorkflowReleaseSummary = { id: 'release-a', environmentId: environment.id, workflowId: workflowA.id, workflowRevision: 1, contentSha256: 'a'.repeat(64), status: 'published', createdAt: environment.createdAt, publishedAt: environment.createdAt, launchFields: [] }
    const previousGlobals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent, KeyboardEvent: globalThis.KeyboardEvent, CustomEvent: globalThis.CustomEvent, getComputedStyle: globalThis.getComputedStyle, EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH }
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, { window: domWindow, document: domWindow.document, HTMLElement: domWindow.HTMLElement, Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, CustomEvent: domWindow.CustomEvent, getComputedStyle: domWindow.getComputedStyle.bind(domWindow) })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
    const bridge = { workflowEnvironments: { list: vi.fn(async () => [environment]), upsert: vi.fn() }, workflowReleases: { list: vi.fn(async () => [releaseA]), publish: vi.fn(), start: vi.fn(), rollback: vi.fn(), listObservations: vi.fn(async () => []), getOperationalHealth: vi.fn(unknownOperationalHealth) } }
    ;(globalThis as { EzDSH?: unknown }).EzDSH = bridge
    ;(domWindow as unknown as { EzDSH?: unknown }).EzDSH = bridge
    const root = createRoot(domWindow.document.getElementById('root')!)
    try {
      await act(async () => { root.render(<workflowPage.WorkflowReleasePanel copy={getAppCopy('zh')} workflows={[]} />); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(Array.from(domWindow.document.querySelectorAll('button')).some((button) => button.textContent === '启动发布')).toBe(false)

      await act(async () => { root.render(<workflowPage.WorkflowReleasePanel copy={getAppCopy('zh')} workflows={[workflowA, workflowB]} />); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) })
      const workflowSelect = domWindow.document.querySelector('.workflow-release-panel select') as HTMLSelectElement
      expect(workflowSelect).not.toBeNull()
      expect(bridge.workflowReleases.list).toHaveBeenCalledWith(workflowA.id, environment.id)
      expect(Array.from(domWindow.document.querySelectorAll('button')).some((button) => button.textContent === '启动发布')).toBe(true)
    } finally {
      await act(async () => { root.unmount() })
      delete (globalThis as { EzDSH?: unknown }).EzDSH
      const { navigator: previousNavigator, ...rest } = previousGlobals
      Object.assign(globalThis, rest)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    }
  })

  it('ignores out-of-order release data across workflow and environment target changes', async () => {
    const workflowA = createDefaultWorkflow('工作流 A')
    const workflowB = createDefaultWorkflow('工作流 B')
    const environmentA: WorkflowCustomerEnvironment = { id: 'environment-a', customerName: 'Acme', name: 'A', kind: 'production', status: 'active', connectorIds: [], allowShellFile: false, allowCode: false, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' }
    const environmentB: WorkflowCustomerEnvironment = { ...environmentA, id: 'environment-b', name: 'B' }
    const releaseA: WorkflowReleaseSummary = { id: 'release-a', environmentId: environmentA.id, workflowId: workflowA.id, workflowRevision: 1, contentSha256: 'a'.repeat(64), status: 'published', createdAt: environmentA.createdAt, publishedAt: environmentA.createdAt, launchFields: [{ name: 'input-a', label: 'A 输入' }] }
    const releaseB: WorkflowReleaseSummary = { ...releaseA, id: 'release-b', environmentId: environmentB.id, workflowId: workflowB.id, contentSha256: 'b'.repeat(64), launchFields: [{ name: 'input-b', label: 'B 输入' }] }
    let resolveReleaseA!: (releases: WorkflowReleaseSummary[]) => void
    const staleReleaseA = new Promise<WorkflowReleaseSummary[]>((resolve) => { resolveReleaseA = resolve })
    const list = vi.fn((workflowId?: string, environmentId?: string) => {
      if (workflowId === workflowA.id && environmentId === environmentA.id) return staleReleaseA
      if (workflowId === workflowB.id && environmentId === environmentB.id) return Promise.resolve([releaseB])
      return Promise.resolve([])
    })
    const start = vi.fn(async () => ({ id: 'run-b', workflowId: workflowB.id, workflowRevision: 1, releaseId: releaseB.id, environmentId: environmentB.id, status: 'queued' as const, input: {}, allowShellFile: false, nodeStates: [], events: [] }))
    const previousGlobals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent, KeyboardEvent: globalThis.KeyboardEvent, CustomEvent: globalThis.CustomEvent, getComputedStyle: globalThis.getComputedStyle, EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH }
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, { window: domWindow, document: domWindow.document, HTMLElement: domWindow.HTMLElement, Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, CustomEvent: domWindow.CustomEvent, getComputedStyle: domWindow.getComputedStyle.bind(domWindow) })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
    const bridge = { workflowEnvironments: { list: vi.fn(async () => [environmentA, environmentB]), upsert: vi.fn() }, workflowReleases: { list, publish: vi.fn(), start, rollback: vi.fn(), listObservations: vi.fn(async () => []), getOperationalHealth: vi.fn(unknownOperationalHealth) } }
    ;(globalThis as { EzDSH?: unknown }).EzDSH = bridge
    ;(domWindow as unknown as { EzDSH?: unknown }).EzDSH = bridge
    const root = createRoot(domWindow.document.getElementById('root')!)
    try {
      await act(async () => { root.render(<workflowPage.WorkflowReleasePanel copy={getAppCopy('zh')} workflows={[workflowA, workflowB]} />); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) })
      const selects = domWindow.document.querySelectorAll('.workflow-release-panel select')
      expect(selects).toHaveLength(2)
      await act(async () => {
        Simulate.change(selects[0]!, { target: { value: workflowB.id } })
        Simulate.change(selects[1]!, { target: { value: environmentB.id } })
        await new Promise((resolve) => setTimeout(resolve, 0))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(domWindow.document.body.textContent).toContain('bbbbbbbbbbbb')

      await act(async () => { resolveReleaseA([releaseA]); await staleReleaseA; await Promise.resolve() })
      expect(domWindow.document.body.textContent).toContain('bbbbbbbbbbbb')
      expect(domWindow.document.body.textContent).not.toContain('aaaaaaaaaaaa')

      const openButton = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '启动发布') as HTMLButtonElement
      await act(async () => { openButton.click() })
      expect(domWindow.document.querySelector('[role="dialog"]')?.textContent).toContain('B 输入')
      await act(async () => { Simulate.change(selects[0]!, { target: { value: workflowA.id } }); await Promise.resolve() })
      expect(domWindow.document.querySelector('[role="dialog"]')).toBeFalsy()
      expect(Array.from(domWindow.document.querySelectorAll('button')).some((button) => button.textContent === '启动发布')).toBe(false)
    } finally {
      resolveReleaseA([])
      await act(async () => { root.unmount() })
      delete (globalThis as { EzDSH?: unknown }).EzDSH
      const { navigator: previousNavigator, ...rest } = previousGlobals
      Object.assign(globalThis, rest)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    }
  })

  it('does not let pending publish or rollback refresh an obsolete release target', async () => {
    const workflowA = createDefaultWorkflow('变更工作流 A')
    const workflowB = createDefaultWorkflow('变更工作流 B')
    const environmentA: WorkflowCustomerEnvironment = { id: 'mutation-environment-a', customerName: 'Acme', name: 'A', kind: 'production', status: 'active', connectorIds: [], allowShellFile: false, allowCode: false, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' }
    const environmentB: WorkflowCustomerEnvironment = { ...environmentA, id: 'mutation-environment-b', name: 'B' }
    const releaseA: WorkflowReleaseSummary = { id: 'mutation-release-a', environmentId: environmentA.id, workflowId: workflowA.id, workflowRevision: 1, contentSha256: 'a'.repeat(64), status: 'published', createdAt: environmentA.createdAt, publishedAt: environmentA.createdAt, launchFields: [] }
    const releaseB: WorkflowReleaseSummary = { ...releaseA, id: 'mutation-release-b', environmentId: environmentB.id, workflowId: workflowB.id, contentSha256: 'b'.repeat(64) }
    const releasesFor = (workflowId?: string, environmentId?: string): WorkflowReleaseSummary[] => {
      if (workflowId === workflowA.id && environmentId === environmentA.id) return [releaseA, { ...releaseA, id: 'mutation-release-a-old', status: 'superseded' }]
      if (workflowId === workflowB.id && environmentId === environmentB.id) return [releaseB, { ...releaseB, id: 'mutation-release-b-old', status: 'superseded' }]
      return []
    }
    let resolvePublish!: () => void
    let rejectPublish!: (reason: Error) => void
    let resolveRollback!: () => void
    const pendingPublish = new Promise<void>((resolve) => { resolvePublish = resolve })
    const rejectedPublish = new Promise<void>((_resolve, reject) => { rejectPublish = reject })
    const pendingRollback = new Promise<void>((resolve) => { resolveRollback = resolve })
    let publishCalls = 0
    const previousGlobals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent, KeyboardEvent: globalThis.KeyboardEvent, CustomEvent: globalThis.CustomEvent, getComputedStyle: globalThis.getComputedStyle, EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH }
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, { window: domWindow, document: domWindow.document, HTMLElement: domWindow.HTMLElement, Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, CustomEvent: domWindow.CustomEvent, getComputedStyle: domWindow.getComputedStyle.bind(domWindow) })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
    const bridge = {
      workflowEnvironments: { list: vi.fn(async () => [environmentA, environmentB]), upsert: vi.fn() },
      workflowReleases: {
        list: vi.fn(async (workflowId?: string, environmentId?: string) => releasesFor(workflowId, environmentId)),
        publish: vi.fn(() => { publishCalls += 1; return publishCalls === 1 ? pendingPublish : rejectedPublish }), start: vi.fn(), rollback: vi.fn(() => pendingRollback),
        listObservations: vi.fn(async () => []), getOperationalHealth: vi.fn(unknownOperationalHealth),
      },
    }
    ;(globalThis as { EzDSH?: unknown }).EzDSH = bridge
    ;(domWindow as unknown as { EzDSH?: unknown }).EzDSH = bridge
    const root = createRoot(domWindow.document.getElementById('root')!)
    const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) }
    try {
      await act(async () => { root.render(<workflowPage.WorkflowReleasePanel copy={getAppCopy('zh')} workflows={[workflowA, workflowB]} />); await settle() })
      const selects = domWindow.document.querySelectorAll('.workflow-release-panel select')
      const publishButton = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '发布到客户环境') as HTMLButtonElement
      await act(async () => { publishButton.click(); await Promise.resolve() })
      await act(async () => { Simulate.change(selects[0]!, { target: { value: workflowB.id } }); Simulate.change(selects[1]!, { target: { value: environmentB.id } }); await settle() })
      expect(domWindow.document.body.textContent).toContain('bbbbbbbbbbbb')
      await act(async () => { resolvePublish(); await pendingPublish; await settle() })
      expect(domWindow.document.body.textContent).toContain('bbbbbbbbbbbb')
      expect(domWindow.document.body.textContent).not.toContain('aaaaaaaaaaaa')

      await act(async () => { Simulate.change(selects[0]!, { target: { value: workflowA.id } }); Simulate.change(selects[1]!, { target: { value: environmentA.id } }); await settle() })
      await act(async () => { publishButton.click(); await Promise.resolve() })
      await act(async () => { Simulate.change(selects[0]!, { target: { value: workflowB.id } }); Simulate.change(selects[1]!, { target: { value: environmentB.id } }); await settle() })
      await act(async () => { rejectPublish(new Error('A 发布失败')); await rejectedPublish.catch(() => undefined); await settle() })
      expect(domWindow.document.body.textContent).toContain('bbbbbbbbbbbb')
      expect(domWindow.document.body.textContent).not.toContain('A 发布失败')

      const rollbackButton = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '回滚') as HTMLButtonElement
      await act(async () => { rollbackButton.click(); await Promise.resolve() })
      await act(async () => { Simulate.change(selects[0]!, { target: { value: workflowA.id } }); Simulate.change(selects[1]!, { target: { value: environmentA.id } }); await settle() })
      expect(domWindow.document.body.textContent).toContain('aaaaaaaaaaaa')
      await act(async () => { resolveRollback(); await pendingRollback; await settle() })
      expect(domWindow.document.body.textContent).toContain('aaaaaaaaaaaa')
      expect(domWindow.document.body.textContent).not.toContain('bbbbbbbbbbbb')
    } finally {
      resolvePublish(); rejectPublish(new Error('cleanup')); resolveRollback()
      await act(async () => { root.unmount() })
      delete (globalThis as { EzDSH?: unknown }).EzDSH
      const { navigator: previousNavigator, ...rest } = previousGlobals
      Object.assign(globalThis, rest)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    }
  })

  it('opens the exact released run and does not let a stale listRuns response replace it', async () => {
    const workflow = createDefaultWorkflow('发布源工作流')
    const environment: WorkflowCustomerEnvironment = { id: 'customer-acme-prod', customerName: 'Acme', name: 'Production', kind: 'production', status: 'active', connectorIds: [], allowShellFile: false, allowCode: false, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' }
    const release: WorkflowReleaseSummary = { id: 'release-direct-run', environmentId: environment.id, workflowId: workflow.id, workflowRevision: workflow.revision, contentSha256: 'a'.repeat(64), status: 'published', createdAt: environment.createdAt, publishedAt: environment.createdAt, launchFields: [] }
    const record: WorkflowRunRecord = { id: 'run-returned-exactly', workflowId: workflow.id, workflowRevision: workflow.revision, releaseId: release.id, environmentId: environment.id, status: 'queued', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    const completedRecord: WorkflowRunRecord = { ...record, status: 'completed', startedAt: '2026-09-12T01:00:00.000Z', completedAt: '2026-09-12T01:00:03.000Z', events: [{ id: 'run-completed', time: '2026-09-12T01:00:03.000Z', type: 'run-completed' }] }
    const runningEventRecord: WorkflowRunRecord = { ...record, status: 'running', startedAt: '2026-09-12T01:00:01.000Z', events: [{ id: 'run-started', time: '2026-09-12T01:00:01.000Z', type: 'run-started' }] }
    let emitRunState!: (next: WorkflowRunRecord) => void
    let resolveStaleRuns!: (runs: WorkflowRunRecord[]) => void
    const staleRuns = new Promise<WorkflowRunRecord[]>((resolve) => { resolveStaleRuns = resolve })
    let listRunsCalls = 0
    const listRuns = vi.fn(() => {
      listRunsCalls += 1
      if (listRunsCalls === 1) return Promise.resolve([])
      if (listRunsCalls === 2) return staleRuns
      return Promise.resolve([])
    })
    const previousGlobals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent, KeyboardEvent: globalThis.KeyboardEvent, CustomEvent: globalThis.CustomEvent, getComputedStyle: globalThis.getComputedStyle, ResizeObserver: globalThis.ResizeObserver, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH }
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
    const requestAnimationFrame = (_callback: FrameRequestCallback): number => 0
    const cancelAnimationFrame = (_id: number): void => {}
    Object.defineProperty(domWindow.HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 960, bottom: 640, width: 960, height: 640, toJSON: () => ({}) }) })
    Object.assign(globalThis, { window: domWindow, document: domWindow.document, HTMLElement: domWindow.HTMLElement, Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, CustomEvent: domWindow.CustomEvent, getComputedStyle: domWindow.getComputedStyle.bind(domWindow), ResizeObserver: TestResizeObserver, requestAnimationFrame, cancelAnimationFrame })
    Object.assign(domWindow as unknown as Record<string, unknown>, { ResizeObserver: TestResizeObserver, requestAnimationFrame, cancelAnimationFrame })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
    const bridge = {
      workflows: { list: vi.fn(async () => [workflow]), listRuns, getRunDefinition: vi.fn(async () => workflow), onStateChange: vi.fn((listener: (next: WorkflowRunRecord) => void) => { emitRunState = listener; return () => {} }), listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}) },
      employees: { list: vi.fn(async () => []), onStateChange: vi.fn(() => () => {}) },
      workflowCredentials: { list: vi.fn(async () => []) },
      workflowConnectors: { list: vi.fn(async () => []) },
      workflowEnvironments: { list: vi.fn(async () => [environment]), upsert: vi.fn() },
      workflowReleases: { list: vi.fn(async () => [release]), publish: vi.fn(), start: vi.fn(async () => record), rollback: vi.fn(), listObservations: vi.fn(async () => []), getOperationalHealth: vi.fn(unknownOperationalHealth) },
    }
    ;(globalThis as { EzDSH?: unknown }).EzDSH = bridge
    ;(domWindow as unknown as { EzDSH?: unknown }).EzDSH = bridge
    const root = createRoot(domWindow.document.getElementById('root')!)
    try {
      await act(async () => { root.render(<workflowPage.WorkflowPage copy={getAppCopy('zh')} locale="zh" />); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) })
      const releaseButton = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '启动发布') as HTMLButtonElement
      await act(async () => { releaseButton.click() })
      const dialog = domWindow.document.querySelector('[role="dialog"]') as HTMLElement
      const submit = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowStartRun) as HTMLButtonElement
      await act(async () => { submit.click(); await Promise.resolve(); await Promise.resolve() })

      expect(domWindow.document.querySelector('.workflow-workspace-title-row')?.textContent).toContain(workflow.name)
      expect(domWindow.document.querySelector('button[role="tab"][aria-selected="true"]')?.textContent).toBe(getAppCopy('zh').workflowExecutions)
      expect(domWindow.document.body.textContent).toContain(record.id)

      await act(async () => { emitRunState(runningEventRecord); await Promise.resolve() })
      expect(domWindow.document.querySelector('.workflow-run-item-active strong')?.textContent).toBe(getAppCopy('zh').workflowRunning)

      await act(async () => { resolveStaleRuns([completedRecord]); await staleRuns; await Promise.resolve() })
      expect(domWindow.document.body.textContent).toContain(record.id)
      expect(domWindow.document.querySelector('.workflow-run-item-active')?.textContent).toContain(record.id.slice(-12))
      expect(domWindow.document.querySelector('.workflow-run-item-active strong')?.textContent).toBe(getAppCopy('zh').workflowRunCompleted)
    } finally {
      resolveStaleRuns([])
      await act(async () => { root.unmount() })
      delete (globalThis as { EzDSH?: unknown }).EzDSH
      const { navigator: previousNavigator, ...rest } = previousGlobals
      Object.assign(globalThis, rest)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    }
  })

  it('does not let a late workflow-open response pollute a subsequently opened workflow', async () => {
    const workflowA = createDefaultWorkflow('切换工作流 A')
    const workflowB = createDefaultWorkflow('切换工作流 B')
    const runA: WorkflowRunRecord = { id: 'run-workflow-a', workflowId: workflowA.id, workflowRevision: workflowA.revision, status: 'completed', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    const runB: WorkflowRunRecord = { id: 'run-workflow-b', workflowId: workflowB.id, workflowRevision: workflowB.revision, status: 'completed', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    const secondRunB: WorkflowRunRecord = { ...runB, id: 'run-workflow-b-second', status: 'failed', events: [{ id: 'run-b-second-failed', time: '2026-09-12T05:00:00.000Z', type: 'run-failed' }] }
    let emitRunState!: (next: WorkflowRunRecord) => void
    let resolveRunA!: (runs: WorkflowRunRecord[]) => void
    const lateRunA = new Promise<WorkflowRunRecord[]>((resolve) => { resolveRunA = resolve })
    const runCalls = new Map<string, number>()
    const listRuns = vi.fn((workflowId: string) => {
      const count = (runCalls.get(workflowId) ?? 0) + 1
      runCalls.set(workflowId, count)
      if (count === 1) return Promise.resolve(workflowId === workflowB.id ? [runB] : [])
      if (workflowId === workflowA.id) return lateRunA
      if (count === 2) return Promise.resolve([runB])
      return Promise.reject(new Error('B run list unavailable'))
    })
    const previousGlobals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent, KeyboardEvent: globalThis.KeyboardEvent, CustomEvent: globalThis.CustomEvent, getComputedStyle: globalThis.getComputedStyle, ResizeObserver: globalThis.ResizeObserver, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH }
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
    const requestAnimationFrame = (_callback: FrameRequestCallback): number => 0
    const cancelAnimationFrame = (_id: number): void => {}
    Object.defineProperty(domWindow.HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 960, bottom: 640, width: 960, height: 640, toJSON: () => ({}) }) })
    Object.assign(globalThis, { window: domWindow, document: domWindow.document, HTMLElement: domWindow.HTMLElement, Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, CustomEvent: domWindow.CustomEvent, getComputedStyle: domWindow.getComputedStyle.bind(domWindow), ResizeObserver: TestResizeObserver, requestAnimationFrame, cancelAnimationFrame })
    Object.assign(domWindow as unknown as Record<string, unknown>, { ResizeObserver: TestResizeObserver, requestAnimationFrame, cancelAnimationFrame })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
    const bridge = {
      workflows: { list: vi.fn(async () => [workflowA, workflowB]), listRuns, onStateChange: vi.fn((listener: (next: WorkflowRunRecord) => void) => { emitRunState = listener; return () => {} }), listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}) },
      employees: { list: vi.fn(async () => []), onStateChange: vi.fn(() => () => {}) },
      workflowCredentials: { list: vi.fn(async () => []) }, workflowConnectors: { list: vi.fn(async () => []) },
      workflowEnvironments: { list: vi.fn(async () => []), upsert: vi.fn() },
      workflowReleases: { list: vi.fn(async () => []), publish: vi.fn(), start: vi.fn(), rollback: vi.fn(), listObservations: vi.fn(async () => []), getOperationalHealth: vi.fn(unknownOperationalHealth) },
    }
    ;(globalThis as { EzDSH?: unknown }).EzDSH = bridge
    ;(domWindow as unknown as { EzDSH?: unknown }).EzDSH = bridge
    const root = createRoot(domWindow.document.getElementById('root')!)
    try {
      await act(async () => { root.render(<workflowPage.WorkflowPage copy={getAppCopy('zh')} locale="zh" />); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) })
      const cards = domWindow.document.querySelectorAll('.workflow-file-card-main')
      await act(async () => { (cards[0] as HTMLButtonElement).click(); await Promise.resolve() })
      await act(async () => { (domWindow.document.querySelector('.workflow-back-button') as HTMLButtonElement).click(); await Promise.resolve() })
      const nextCards = domWindow.document.querySelectorAll('.workflow-file-card-main')
      await act(async () => { (nextCards[1] as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve() })
      await act(async () => { resolveRunA([runA]); await lateRunA; await Promise.resolve() })

      expect(domWindow.document.querySelector('.workflow-workspace-title-row')?.textContent).toContain(workflowB.name)
      const executions = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { executions.click(); await Promise.resolve() })
      await act(async () => { emitRunState(runA); await Promise.resolve(); await Promise.resolve() })
      expect(domWindow.document.body.textContent).toContain(runB.id.slice(-12))
      expect(domWindow.document.body.textContent).not.toContain(runA.id.slice(-12))

      await act(async () => { (domWindow.document.querySelector('.workflow-back-button') as HTMLButtonElement).click(); await Promise.resolve() })
      const finalCards = domWindow.document.querySelectorAll('.workflow-file-card-main')
      await act(async () => { (finalCards[0] as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve() })
      const finalExecutions = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { finalExecutions.click(); await Promise.resolve() })
      await act(async () => { emitRunState(secondRunB); await Promise.resolve(); await Promise.resolve() })
      expect(domWindow.document.body.textContent).toContain(runA.id.slice(-12))
      expect(domWindow.document.body.textContent).not.toContain(secondRunB.id.slice(-12))
      await act(async () => { (domWindow.document.querySelector('.workflow-back-button') as HTMLButtonElement).click(); await Promise.resolve() })
      const workflowBCard = Array.from(domWindow.document.querySelectorAll('.workflow-file-card-main')).find((card) => card.textContent?.includes(workflowB.name))
      expect(workflowBCard?.textContent).toContain('2 条历史记录')
    } finally {
      resolveRunA([])
      await act(async () => { root.unmount() })
      delete (globalThis as { EzDSH?: unknown }).EzDSH
      const { navigator: previousNavigator, ...rest } = previousGlobals
      Object.assign(globalThis, rest)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    }
  })

  it('replaces old runs with an authoritative empty snapshot while preserving events observed during a later request', async () => {
    const workflow = createDefaultWorkflow('权威运行快照')
    const oldRun: WorkflowRunRecord = { id: 'run-authoritative-old', workflowId: workflow.id, workflowRevision: 1, status: 'completed', input: {}, allowShellFile: false, nodeStates: [], events: [{ id: 'old-completed', time: '2026-09-12T01:00:00.000Z', type: 'run-completed' }] }
    const liveRun: WorkflowRunRecord = { id: 'run-authoritative-live', workflowId: workflow.id, workflowRevision: 1, status: 'running', input: {}, allowShellFile: false, nodeStates: [], events: [{ id: 'live-started', time: '2026-09-12T02:00:00.000Z', type: 'run-started' }] }
    let emitRunState!: (record: WorkflowRunRecord) => void
    let resolveOpenSnapshot!: (records: WorkflowRunRecord[]) => void
    const openSnapshot = new Promise<WorkflowRunRecord[]>((resolve) => { resolveOpenSnapshot = resolve })
    let listRunsCalls = 0
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [workflow]),
      listRuns: vi.fn(() => {
        listRunsCalls += 1
        if (listRunsCalls === 1) return Promise.resolve([oldRun])
        if (listRunsCalls === 2) return Promise.resolve([])
        return openSnapshot
      }),
      onStateChange: vi.fn((listener: (record: WorkflowRunRecord) => void) => { emitRunState = listener; return () => {} }),
      listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      const initialCard = mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement
      expect(initialCard.textContent).toContain('1 条历史记录')
      const refresh = mounted.domWindow.document.querySelector('.workflow-browser-heading button') as HTMLButtonElement
      await act(async () => { refresh.click(); await mounted.settle() })
      const refreshedCardText = mounted.domWindow.document.querySelector('.workflow-file-card-main')?.textContent

      const open = mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement
      await act(async () => { open.click(); await Promise.resolve() })
      await act(async () => { emitRunState(liveRun); await Promise.resolve() })
      await act(async () => { resolveOpenSnapshot([]); await openSnapshot; await mounted.settle() })
      const executions = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { executions.click(); await Promise.resolve() })

      expect(refreshedCardText).toContain('0 条历史记录')
      expect(mounted.domWindow.document.body.textContent).toContain(liveRun.id.slice(-12))
      expect(mounted.domWindow.document.body.textContent).not.toContain(oldRun.id.slice(-12))
    } finally {
      resolveOpenSnapshot([])
      await mounted.cleanup()
    }
  })

  it('keeps the freshest same-run live record in a request-period snapshot overlay', async () => {
    const workflow = createDefaultWorkflow('运行事件新鲜度')
    const running: WorkflowRunRecord = {
      id: 'run-live-overlay-freshness', workflowId: workflow.id, workflowRevision: 1, status: 'running', input: {}, allowShellFile: false, nodeStates: [],
      startedAt: '2026-09-12T02:00:00.000Z', events: [{ id: 'overlay-started', time: '2026-09-12T02:00:00.000Z', type: 'run-started' }],
    }
    const completed: WorkflowRunRecord = {
      ...running, status: 'completed', completedAt: '2026-09-12T02:01:00.000Z',
      events: [...running.events, { id: 'overlay-completed', time: '2026-09-12T02:01:00.000Z', type: 'run-completed' }],
    }
    let emitRunState!: (record: WorkflowRunRecord) => void
    let resolveOpenSnapshot!: (records: WorkflowRunRecord[]) => void
    const openSnapshot = new Promise<WorkflowRunRecord[]>((resolve) => { resolveOpenSnapshot = resolve })
    let listRunsCalls = 0
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [workflow]),
      listRuns: vi.fn(() => {
        listRunsCalls += 1
        if (listRunsCalls === 1 || listRunsCalls > 2) return Promise.resolve([])
        return openSnapshot
      }),
      onStateChange: vi.fn((listener: (record: WorkflowRunRecord) => void) => { emitRunState = listener; return () => {} }),
      listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement).click(); await Promise.resolve() })
      const executions = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { executions.click(); emitRunState(completed); emitRunState(running); await Promise.resolve() })
      await act(async () => { resolveOpenSnapshot([]); await openSnapshot; await mounted.settle() })

      expect(mounted.domWindow.document.querySelector('.workflow-run-item-main strong')?.textContent).toBe(getAppCopy('zh').workflowRunCompleted)

      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-back-button') as HTMLButtonElement).click(); await Promise.resolve() })
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-unviewed-run-button') as HTMLButtonElement).click(); await mounted.settle() })
      expect(mounted.domWindow.document.querySelector('.workflow-execution-run-identity .workflow-status-pill')?.textContent).toBe(getAppCopy('zh').workflowRunCompleted)
    } finally {
      resolveOpenSnapshot([])
      await mounted.cleanup()
    }
  })

  it('clears workflow run state before restoring the same workflow id and ignores its pending old response', async () => {
    const workflow = createDefaultWorkflow('删除后恢复工作流')
    const oldRun: WorkflowRunRecord = { id: 'run-before-workflow-delete', workflowId: workflow.id, workflowRevision: 1, status: 'completed', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    let resolveOpenSnapshot!: (records: WorkflowRunRecord[]) => void
    const openSnapshot = new Promise<WorkflowRunRecord[]>((resolve) => { resolveOpenSnapshot = resolve })
    let listRunsCalls = 0
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [workflow]),
      listRuns: vi.fn(() => { listRunsCalls += 1; return listRunsCalls === 1 ? Promise.resolve([oldRun]) : openSnapshot }),
      remove: vi.fn(async () => undefined), create: vi.fn(async () => workflow),
      onStateChange: vi.fn(() => () => {}), listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement).click(); await Promise.resolve() })
      const deleteWorkflow = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowDelete) as HTMLButtonElement
      await act(async () => { deleteWorkflow.click(); await mounted.settle() })
      await act(async () => { resolveOpenSnapshot([oldRun]); await openSnapshot; await mounted.settle() })
      const restore = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowUndoDelete) as HTMLButtonElement
      await act(async () => { restore.click(); await mounted.settle() })

      const restoredCard = mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement
      expect(restoredCard.textContent).toContain('0 条历史记录')
      expect(restoredCard.textContent).not.toContain(oldRun.id.slice(-12))
    } finally {
      resolveOpenSnapshot([])
      await mounted.cleanup()
    }
  })

  it('does not resurrect a removed run when an older open snapshot resolves', async () => {
    const workflow = createDefaultWorkflow('删除运行快照')
    const run: WorkflowRunRecord = { id: 'run-removed-before-snapshot', workflowId: workflow.id, workflowRevision: 1, status: 'completed', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    let emitRunState!: (record: WorkflowRunRecord) => void
    let resolveOpenSnapshot!: (records: WorkflowRunRecord[]) => void
    const openSnapshot = new Promise<WorkflowRunRecord[]>((resolve) => { resolveOpenSnapshot = resolve })
    let listRunsCalls = 0
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [workflow]),
      listRuns: vi.fn(() => { listRunsCalls += 1; return listRunsCalls === 1 ? Promise.resolve([run]) : openSnapshot }),
      removeRun: vi.fn(async () => undefined), onStateChange: vi.fn((listener: (record: WorkflowRunRecord) => void) => { emitRunState = listener; return () => {} }),
      listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement).click(); await Promise.resolve() })
      const executions = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { executions.click(); await Promise.resolve() })
      const deleteRun = mounted.domWindow.document.querySelector('.workflow-run-item-actions button') as HTMLButtonElement
      await act(async () => { deleteRun.click(); await mounted.settle() })
      await act(async () => { resolveOpenSnapshot([run]); await openSnapshot; await mounted.settle() })
      await act(async () => { emitRunState(run); await Promise.resolve() })

      expect(mounted.domWindow.document.body.textContent).toContain(getAppCopy('zh').workflowNoRuns)
      expect(mounted.domWindow.document.body.textContent).not.toContain(run.id.slice(-12))
    } finally {
      resolveOpenSnapshot([])
      await mounted.cleanup()
    }
  })

  it('keeps the returned run identity visible when its source workflow is unavailable', async () => {
    const sourceWorkflow = { ...createDefaultWorkflow('即将删除的源工作流'), id: 'deleted-source' }
    const environment: WorkflowCustomerEnvironment = { id: 'customer-acme-prod', customerName: 'Acme', name: 'Production', kind: 'production', status: 'active', connectorIds: [], allowShellFile: false, allowCode: false, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' }
    const release: WorkflowReleaseSummary = { id: 'release-deleted-source', environmentId: environment.id, workflowId: 'deleted-source', workflowRevision: 1, contentSha256: 'a'.repeat(64), status: 'published', createdAt: environment.createdAt, publishedAt: environment.createdAt, launchFields: [] }
    const record: WorkflowRunRecord = { id: 'run-deleted-source', workflowId: release.workflowId, workflowRevision: 1, releaseId: release.id, environmentId: environment.id, status: 'queued', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    const previousGlobals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent, KeyboardEvent: globalThis.KeyboardEvent, CustomEvent: globalThis.CustomEvent, getComputedStyle: globalThis.getComputedStyle, ResizeObserver: globalThis.ResizeObserver, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH }
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
    const requestAnimationFrame = (_callback: FrameRequestCallback): number => 0
    const cancelAnimationFrame = (_id: number): void => {}
    Object.defineProperty(domWindow.HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 960, bottom: 640, width: 960, height: 640, toJSON: () => ({}) }) })
    Object.assign(globalThis, { window: domWindow, document: domWindow.document, HTMLElement: domWindow.HTMLElement, Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, CustomEvent: domWindow.CustomEvent, getComputedStyle: domWindow.getComputedStyle.bind(domWindow), ResizeObserver: TestResizeObserver, requestAnimationFrame, cancelAnimationFrame })
    Object.assign(domWindow as unknown as Record<string, unknown>, { ResizeObserver: TestResizeObserver, requestAnimationFrame, cancelAnimationFrame })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
    let workflowListCalls = 0
    let resolveStart!: (record: WorkflowRunRecord) => void
    const pendingStart = new Promise<WorkflowRunRecord>((resolve) => { resolveStart = resolve })
    const bridge = {
      workflows: { list: vi.fn(async () => { workflowListCalls += 1; return workflowListCalls === 1 ? [sourceWorkflow] : [] }), listRuns: vi.fn(async () => []), getRunDefinition: vi.fn(async () => sourceWorkflow), onStateChange: vi.fn(() => () => {}), listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}) },
      employees: { list: vi.fn(async () => []), onStateChange: vi.fn(() => () => {}) },
      workflowCredentials: { list: vi.fn(async () => []) },
      workflowConnectors: { list: vi.fn(async () => []) },
      workflowEnvironments: { list: vi.fn(async () => [environment]), upsert: vi.fn() },
      workflowReleases: { list: vi.fn(async () => [release]), publish: vi.fn(), start: vi.fn(() => pendingStart), rollback: vi.fn(), listObservations: vi.fn(async () => []), getOperationalHealth: vi.fn(unknownOperationalHealth) },
    }
    ;(globalThis as { EzDSH?: unknown }).EzDSH = bridge
    ;(domWindow as unknown as { EzDSH?: unknown }).EzDSH = bridge
    const root = createRoot(domWindow.document.getElementById('root')!)
    try {
      await act(async () => { root.render(<workflowPage.WorkflowPage copy={getAppCopy('zh')} locale="zh" />); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) })
      const releaseButton = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '启动发布') as HTMLButtonElement
      await act(async () => { releaseButton.click() })
      const dialog = domWindow.document.querySelector('[role="dialog"]') as HTMLElement
      const submit = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowStartRun) as HTMLButtonElement
      await act(async () => { submit.click(); await Promise.resolve() })
      const refresh = domWindow.document.querySelector('.workflow-browser-heading button') as HTMLButtonElement
      await act(async () => { refresh.click(); await Promise.resolve(); await Promise.resolve() })
      await act(async () => { resolveStart(record); await pendingStart; await Promise.resolve() })
      expect(domWindow.document.body.textContent).toContain(record.id)
      expect(domWindow.document.body.textContent).toContain(sourceWorkflow.nodes[0]!.label)
      expect(Array.from(domWindow.document.querySelectorAll('button')).some((button) => button.textContent === getAppCopy('zh').workflowEditor)).toBe(false)
    } finally {
      resolveStart(record)
      await act(async () => { root.unmount() })
      delete (globalThis as { EzDSH?: unknown }).EzDSH
      const { navigator: previousNavigator, ...rest } = previousGlobals
      Object.assign(globalThis, rest)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    }
  })

  it('renders an old run from its immutable definition without replacing the editable current version', async () => {
    const editable = { ...createDefaultWorkflow('Current V2'), revision: 2 }
    const historicalSource = createDefaultWorkflow('Historic V1')
    const historical = {
      ...historicalSource,
      id: editable.id,
      revision: 1,
      nodes: historicalSource.nodes.map((node, index) => ({ ...node, label: `Historic V1 Node ${index + 1}` })),
    }
    const run: WorkflowRunRecord = { id: 'run-historic-v1', workflowId: editable.id, workflowRevision: 1, status: 'completed', input: {}, allowShellFile: false, nodeStates: historical.nodes.map((node, index) => ({ nodeId: node.id, status: 'completed' as const, elapsedMs: 1, ...(index === 1 ? { input: { historical: true } } : {}) })), events: [] }
    const getRunDefinition = vi.fn(async () => historical)
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [editable]), listRuns: vi.fn(async () => [run]), getRunDefinition,
      onStateChange: vi.fn(() => () => {}), listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement).click(); await mounted.settle() })
      const executions = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { executions.click(); await Promise.resolve() })
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-run-item-main') as HTMLButtonElement).click(); await mounted.settle() })
      expect(mounted.domWindow.document.body.textContent).toContain('Historic V1 Node 1')
      expect(mounted.domWindow.document.querySelector('.workflow-workspace-title-row')?.textContent).toContain('Historic V1')
      expect(mounted.domWindow.document.querySelector('.workflow-workspace-identity')?.textContent).toContain('v1')
      expect(mounted.domWindow.document.body.textContent).not.toContain('该次运行的工作流定义不可用')
      const historicalTaskNode = Array.from(mounted.domWindow.document.querySelectorAll('.react-flow__node')).find((node) => node.textContent?.includes('Historic V1 Node 2')) as HTMLElement
      await act(async () => { historicalTaskNode.click(); await Promise.resolve() })
      expect(mounted.domWindow.document.querySelector('.workflow-node-result')?.textContent).toContain('Historic V1 Node 2')
      const upstream = mounted.domWindow.document.querySelector('.workflow-upstream-actions button') as HTMLButtonElement
      await act(async () => { upstream.click(); await Promise.resolve() })
      expect(mounted.domWindow.document.querySelector('.workflow-node-result')?.textContent).toContain('Historic V1 Node 1')
      const editor = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowEditor) as HTMLButtonElement
      await act(async () => { editor.click(); await Promise.resolve() })
      expect(mounted.domWindow.document.querySelector('.workflow-workspace-title-row')?.textContent).toContain('Current V2')
      expect(mounted.domWindow.document.body.textContent).not.toContain('Historic V1 Node 1')
      await act(async () => { executions.click(); await Promise.resolve() })
      expect(mounted.domWindow.document.body.textContent).toContain('Historic V1 Node 1')
      expect(getRunDefinition).toHaveBeenCalledTimes(1)
    } finally { await mounted.cleanup() }
  })

  it.each([
    ['missing', vi.fn(async () => undefined)],
    ['rejected', vi.fn(async () => { throw new Error('definition offline') })],
  ])('shows a persistent unavailable state for a %s run definition without current-version fallback', async (_kind, getRunDefinition) => {
    const editableSource = createDefaultWorkflow('Editable V2 Only')
    const editable = { ...editableSource, revision: 2, nodes: editableSource.nodes.map((node, index) => ({ ...node, label: `V2-only node ${index + 1}` })) }
    const run: WorkflowRunRecord = { id: `run-definition-${_kind}`, workflowId: editable.id, workflowRevision: 1, status: 'completed', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [editable]), listRuns: vi.fn(async () => [run]), getRunDefinition,
      onStateChange: vi.fn(() => () => {}), listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement).click(); await mounted.settle() })
      const executions = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { executions.click(); await Promise.resolve() })
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-run-item-main') as HTMLButtonElement).click(); await mounted.settle() })
      expect(mounted.domWindow.document.querySelector('.workflow-execution-definition-state')?.textContent).toContain('工作流定义不可用')
      expect(mounted.domWindow.document.body.textContent).not.toContain('V2-only node 1')
      expect(mounted.domWindow.document.body.textContent).toContain(run.id)
      expect(mounted.domWindow.document.querySelector('.workflow-workspace-title-row')?.textContent).toContain(editable.id)
      expect(mounted.domWindow.document.querySelector('.workflow-workspace-identity')?.textContent).toContain('v1')
    } finally { await mounted.cleanup() }
  })

  it('ignores an older run-definition response after a newer run is selected', async () => {
    const editable = createDefaultWorkflow('Definition race')
    const sourceA = createDefaultWorkflow('Definition A')
    const sourceB = createDefaultWorkflow('Definition B')
    const definitionA = { ...sourceA, id: editable.id, revision: 1, nodes: sourceA.nodes.map((node) => ({ ...node, label: `Definition A ${node.label}` })) }
    const definitionB = { ...sourceB, id: editable.id, revision: 2, nodes: sourceB.nodes.map((node) => ({ ...node, label: `Definition B ${node.label}` })) }
    const runA: WorkflowRunRecord = { id: 'run-definition-a', workflowId: editable.id, workflowRevision: 1, status: 'completed', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    const runB: WorkflowRunRecord = { id: 'run-definition-b', workflowId: editable.id, workflowRevision: 2, status: 'completed', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    let resolveA!: (definition: WorkflowDefinition) => void
    let resolveB!: (definition: WorkflowDefinition) => void
    const pendingA = new Promise<WorkflowDefinition>((resolve) => { resolveA = resolve })
    const pendingB = new Promise<WorkflowDefinition>((resolve) => { resolveB = resolve })
    const getRunDefinition = vi.fn((runId: string) => runId === runA.id ? pendingA : pendingB)
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [editable]), listRuns: vi.fn(async () => [runA, runB]), getRunDefinition,
      onStateChange: vi.fn(() => () => {}), listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement).click(); await mounted.settle() })
      const executions = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { executions.click(); await Promise.resolve() })
      const buttons = Array.from(mounted.domWindow.document.querySelectorAll('.workflow-run-item-main')) as HTMLButtonElement[]
      const buttonA = buttons.find((button) => button.textContent?.includes(runA.id.slice(-12)))!
      const buttonB = buttons.find((button) => button.textContent?.includes(runB.id.slice(-12)))!
      await act(async () => { buttonA.click(); buttonB.click(); await Promise.resolve() })
      await act(async () => { resolveB(definitionB); await pendingB; await mounted.settle() })
      expect(mounted.domWindow.document.body.textContent).toContain('Definition B')
      await act(async () => { resolveA(definitionA); await pendingA; await mounted.settle() })
      expect(mounted.domWindow.document.body.textContent).toContain('Definition B')
      expect(mounted.domWindow.document.body.textContent).not.toContain('Definition A')
    } finally {
      resolveA(definitionA); resolveB(definitionB)
      await mounted.cleanup()
    }
  })

  it('keeps a later selected run when the preferred-run list refresh resolves late', async () => {
    const workflow = createDefaultWorkflow('Preferred refresh ownership')
    const runA: WorkflowRunRecord = { id: 'run-preferred-refresh-a', workflowId: workflow.id, workflowRevision: 1, status: 'completed', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    const runB: WorkflowRunRecord = { ...runA, id: 'run-preferred-refresh-b' }
    let resolveOpen!: (runs: WorkflowRunRecord[]) => void
    const pendingOpen = new Promise<WorkflowRunRecord[]>((resolve) => { resolveOpen = resolve })
    let calls = 0
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [workflow]),
      listRuns: vi.fn(() => { calls += 1; return calls === 1 ? Promise.resolve([runA, runB]) : pendingOpen }),
      getRunDefinition: vi.fn(async () => workflow), onStateChange: vi.fn(() => () => {}),
      listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      const unread = mounted.domWindow.document.querySelector('.workflow-unviewed-run-button') as HTMLButtonElement
      await act(async () => { unread.click(); await mounted.settle() })
      const runBButton = Array.from(mounted.domWindow.document.querySelectorAll('.workflow-run-item-main')).find((button) => button.textContent?.includes(runB.id.slice(-12))) as HTMLButtonElement
      await act(async () => { runBButton.click(); await mounted.settle() })
      await act(async () => { resolveOpen([runA, runB]); await pendingOpen; await mounted.settle() })
      expect(mounted.domWindow.document.querySelector('.workflow-execution-run-identity')?.textContent).toContain(runB.id)
    } finally { resolveOpen([]); await mounted.cleanup() }
  })

  it('does not reopen an unread run after a newer workflow open owns the workspace', async () => {
    const workflowA = createDefaultWorkflow('Unread A')
    const workflowB = createDefaultWorkflow('Newer B')
    const runA: WorkflowRunRecord = { id: 'run-unread-a-delayed', workflowId: workflowA.id, workflowRevision: 1, status: 'completed', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    let resolveOpenA!: (runs: WorkflowRunRecord[]) => void
    const pendingOpenA = new Promise<WorkflowRunRecord[]>((resolve) => { resolveOpenA = resolve })
    let callsA = 0
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [workflowA, workflowB]),
      listRuns: vi.fn((workflowId: string) => {
        if (workflowId === workflowA.id) { callsA += 1; return callsA === 1 ? Promise.resolve([runA]) : pendingOpenA }
        return Promise.resolve([])
      }),
      getRunDefinition: vi.fn(async () => workflowA), onStateChange: vi.fn(() => () => {}),
      listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      const unread = mounted.domWindow.document.querySelector('.workflow-unviewed-run-button') as HTMLButtonElement
      await act(async () => { unread.click(); await Promise.resolve() })
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-back-button') as HTMLButtonElement).click(); await Promise.resolve() })
      const workflowBCard = Array.from(mounted.domWindow.document.querySelectorAll('.workflow-file-card-main')).find((button) => button.textContent?.includes(workflowB.name)) as HTMLButtonElement
      await act(async () => { workflowBCard.click(); await mounted.settle() })
      await act(async () => { resolveOpenA([runA]); await pendingOpenA; await mounted.settle() })
      expect(mounted.domWindow.document.querySelector('.workflow-workspace-title-row')?.textContent).toContain(workflowB.name)
      expect(mounted.domWindow.document.body.textContent).not.toContain(runA.id)
    } finally { resolveOpenA([]); await mounted.cleanup() }
  })

  it('keeps a later selected run when deleting an earlier run finishes late', async () => {
    const workflow = createDefaultWorkflow('Delete ownership')
    const definitionA = { ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, label: `Delete A ${node.label}` })) }
    const definitionB = { ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, label: `Delete B ${node.label}` })) }
    const runA: WorkflowRunRecord = { id: 'run-delete-pending-a', workflowId: workflow.id, workflowRevision: workflow.revision, status: 'completed', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    const runB: WorkflowRunRecord = { ...runA, id: 'run-delete-selected-b' }
    let resolveDefinitionA!: (definition: WorkflowDefinition) => void
    const pendingDefinitionA = new Promise<WorkflowDefinition>((resolve) => { resolveDefinitionA = resolve })
    let resolveRemove!: () => void
    const pendingRemove = new Promise<void>((resolve) => { resolveRemove = resolve })
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [workflow]), listRuns: vi.fn(async () => [runA, runB]), removeRun: vi.fn(() => pendingRemove),
      getRunDefinition: vi.fn((runId: string) => runId === runA.id ? pendingDefinitionA : Promise.resolve(definitionB)),
      onStateChange: vi.fn(() => () => {}), listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement).click(); await mounted.settle() })
      const executions = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { executions.click(); await Promise.resolve() })
      const runAButton = Array.from(mounted.domWindow.document.querySelectorAll('.workflow-run-item-main')).find((button) => button.textContent?.includes(runA.id.slice(-12))) as HTMLButtonElement
      await act(async () => { runAButton.click(); await Promise.resolve() })
      const deleteA = runAButton.parentElement?.querySelector('.workflow-run-item-actions button') as HTMLButtonElement
      await act(async () => { deleteA.click(); await Promise.resolve() })
      const runBButton = Array.from(mounted.domWindow.document.querySelectorAll('.workflow-run-item-main')).find((button) => button.textContent?.includes(runB.id.slice(-12))) as HTMLButtonElement
      await act(async () => { runBButton.click(); await mounted.settle() })
      await act(async () => { resolveRemove(); await pendingRemove; await mounted.settle() })
      await act(async () => { resolveDefinitionA(definitionA); await pendingDefinitionA; await mounted.settle() })
      expect(mounted.domWindow.document.querySelector('.workflow-execution-run-identity')?.textContent).toContain(runB.id)
      expect(mounted.domWindow.document.body.textContent).toContain('Delete B')
      expect(mounted.domWindow.document.body.textContent).not.toContain('Delete A')
    } finally { resolveDefinitionA(definitionA); resolveRemove(); await mounted.cleanup() }
  })

  it('shows the saved AI generation prompt in workflow metadata', () => {
    const markup = renderToStaticMarkup(<workflowPage.WorkflowMetadataDialog
      copy={getAppCopy('zh')}
      name="生成工作流"
      description=""
      generationPrompt="生成一个处理客户反馈的工作流"
      onChangeName={vi.fn()}
      onChangeDescription={vi.fn()}
      onChangeGenerationPrompt={vi.fn()}
      onClose={vi.fn()}
      onSave={vi.fn()}
    />)

    expect(markup).toContain('AI 生成提示词')
    expect(markup).toContain('生成一个处理客户反馈的工作流')
  })

  it('marks the currently running canvas node for an execution indicator', () => {
    const workflow = createDefaultWorkflow('Execution status')
    const runningNode = workflow.nodes.find((node) => node.type === 'ai-task')!
    const run: WorkflowRunRecord = {
      id: 'run-running', workflowId: workflow.id, workflowRevision: workflow.revision, status: 'running', input: 'brief', events: [],
      nodeStates: workflow.nodes.map((node) => ({ nodeId: node.id, status: node.id === runningNode.id ? 'running' : 'pending', elapsedMs: 0 })),
    }

    const node = workflowPage.workflowFlowNodes(workflow, run).find((candidate) => candidate.id === runningNode.id)

    expect(node).toMatchObject({
      className: 'workflow-flow-node-running',
      data: { status: 'running', isRunning: true },
    })
  })

  it('adds the personal employee name to the canvas node data without replacing its role label', () => {
    const workflow = createDefaultWorkflow('Employee labels')
    const source = workflow.nodes.find((node) => node.type === 'ai-task')!
    const employeeNode = { ...source, type: 'employee', label: '事实核查', config: { employeeId: 'reviewer', instruction: '审核', outputMode: 'text' } } as never
    const next = { ...workflow, nodes: workflow.nodes.map((node) => node.id === source.id ? employeeNode : node) }
    const flowNode = workflowPage.workflowFlowNodes(next, undefined, undefined, [], [{
      schemaVersion: 2, version: 1, id: 'reviewer', displayName: '顾言', name: '审核员', role: '事实核查专员', description: '', businessBoundary: '', systemPrompt: '审核', operatingGuidelines: [], qualityStandards: [], capabilities: [], skillIds: [], enabled: true, builtIn: false, createdAt: '', updatedAt: '',
    }]).find((node) => node.id === source.id)

    expect(flowNode).toMatchObject({ data: { label: '事实核查', employeeName: '顾言' } })
  })

  it('keeps canvas deletions and edge deletions when inspector edits the workflow', () => {
    const workflow = graphWithRemovedNode()
    const agent = workflow.nodes.find((node) => node.type === 'ai-task')!
    const visibleNodes: Node[] = workflow.nodes
      .filter((node) => node.id !== agent.id)
      .map((node) => ({ id: node.id, position: node.position, data: { label: node.label, nodeType: node.type }, type: 'default' }))
    const visibleEdges: Edge[] = []

    const merged = workflowPage.mergeFlowStateIntoWorkflow(workflow, visibleNodes, visibleEdges)
    const edited = {
      ...merged,
      nodes: merged.nodes.map((node) => node.id === workflow.nodes[0]?.id ? { ...node, label: 'Edited input' } : node),
    }

    expect(edited.nodes.some((node) => node.id === agent.id)).toBe(false)
    expect(edited.edges).toEqual([])
  })

  it('removes a selected node together with every connected edge', () => {
    const workflow = graphWithRemovedNode()
    const agent = workflow.nodes.find((node) => node.type === 'ai-task')!
    const next = workflowPage.removeWorkflowNode(workflow, agent.id)

    expect(next.nodes.some((node) => node.id === agent.id)).toBe(false)
    expect(next.edges.some((edge) => edge.source === agent.id || edge.target === agent.id)).toBe(false)
  })

  it('keeps fixed start and end nodes when deleting or duplicating a selection', () => {
    const workflow = createDefaultWorkflow('Fixed terminals')
    const start = workflow.nodes.find((node) => node.type === 'input')!
    const end = workflow.nodes.find((node) => node.type === 'output')!

    const deleted = workflowPage.removeWorkflowSelection(workflow, { nodeIds: [start.id, end.id] })
    const duplicated = workflowPage.duplicateWorkflowNodes([start, end], (node) => `${node.id}-copy`)

    expect(deleted.nodes).toEqual(workflow.nodes)
    expect(deleted.edges).toEqual(workflow.edges)
    expect(duplicated).toEqual([])
    expect(workflowPage.WORKFLOW_ADDABLE_NODE_TYPES).not.toContain('input')
    expect(workflowPage.WORKFLOW_ADDABLE_NODE_TYPES).not.toContain('output')
  })

  it('restores the deleted node and its relationships with undo', () => {
    const workflow = graphWithRemovedNode()
    const node = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const deleted = workflowPage.removeWorkflowSelection(workflow, { nodeId: node.id })
    const history = workflowPage.recordWorkflowHistory(workflowPage.createWorkflowHistory(workflow), deleted)

    const restored = workflowPage.undoWorkflowHistory(history)

    expect(restored.present.nodes).toEqual(workflow.nodes)
    expect(restored.present.edges).toEqual(workflow.edges)
  })

  it('removes only the selected relationship when deleting an edge', () => {
    const workflow = graphWithRemovedNode()
    const edge = workflow.edges[0]
    if (edge === undefined) throw new Error('starter graph should contain an edge')

    const next = workflowPage.removeWorkflowSelection(workflow, { edgeId: edge.id })

    expect(next.nodes).toEqual(workflow.nodes)
    expect(next.edges).toHaveLength(workflow.edges.length - 1)
    expect(next.edges.some((candidate) => candidate.id === edge.id)).toBe(false)
  })

  it('removes selected nodes and relationships together', () => {
    const workflow = graphWithRemovedNode()
    const edge = workflow.edges.find((candidate) => workflow.nodes.find((node) => node.id === candidate.source)?.type === 'ai-task')
    if (edge === undefined) throw new Error('starter graph should contain an edge')

    const next = workflowPage.removeWorkflowSelection(workflow, { edgeId: edge.id, nodeIds: [edge.source] })

    expect(next.nodes.some((node) => node.id === edge.source)).toBe(false)
    expect(next.edges.some((candidate) => candidate.id === edge.id)).toBe(false)
  })

  it('removes every deletable selected node and records the batch as one undoable graph change', () => {
    const workflow = graphWithRemovedNode()
    const selectedNodes = workflow.nodes.filter((node) => node.type === 'ai-task')
    const deleted = workflowPage.removeWorkflowSelection(workflow, { nodeIds: selectedNodes.map((node) => node.id) })
    const history = workflowPage.recordWorkflowHistory(workflowPage.createWorkflowHistory(workflow), deleted)

    expect(deleted.nodes).toHaveLength(workflow.nodes.length - selectedNodes.length)
    expect(deleted.edges.every((edge) => !selectedNodes.some((node) => edge.source === node.id || edge.target === node.id))).toBe(true)
    expect(history.past).toHaveLength(1)
    expect(workflowPage.undoWorkflowHistory(history).present).toEqual(workflow)
  })

  it('aligns all selected nodes without changing their other coordinate', () => {
    const workflow = graphWithRemovedNode()
    const selectedNodes = workflow.nodes.slice(0, 3)
    const positioned = {
      ...workflow,
      nodes: workflow.nodes.map((node, index) => selectedNodes.includes(node)
        ? { ...node, position: [{ x: 80, y: 70 }, { x: 320, y: 180 }, { x: 540, y: 310 }][selectedNodes.indexOf(node)]! }
        : { ...node, position: { x: 900 + index * 20, y: 900 + index * 20 } }),
    }
    const selectedIds = selectedNodes.map((node) => node.id)

    const left = workflowPage.alignWorkflowNodes(positioned, selectedIds, 'left')
    const centered = workflowPage.alignWorkflowNodes(positioned, selectedIds, 'center-horizontal')
    const bottom = workflowPage.alignWorkflowNodes(positioned, selectedIds, 'bottom')

    expect(left.nodes.filter((node) => selectedIds.includes(node.id)).map((node) => node.position)).toEqual([
      { x: 80, y: 70 },
      { x: 80, y: 180 },
      { x: 80, y: 310 },
    ])
    expect(centered.nodes.filter((node) => selectedIds.includes(node.id)).map((node) => node.position)).toEqual([
      { x: 310, y: 70 },
      { x: 310, y: 180 },
      { x: 310, y: 310 },
    ])
    expect(bottom.nodes.filter((node) => selectedIds.includes(node.id)).map((node) => node.position)).toEqual([
      { x: 80, y: 310 },
      { x: 320, y: 310 },
      { x: 540, y: 310 },
    ])
  })

  it('distributes selected nodes evenly along either axis', () => {
    const workflow = graphWithRemovedNode()
    const selectedNodes = workflow.nodes.slice(0, 3)
    const positioned = {
      ...workflow,
      nodes: workflow.nodes.map((node, index) => selectedNodes.includes(node)
        ? { ...node, position: [{ x: 80, y: 70 }, { x: 360, y: 180 }, { x: 540, y: 310 }][selectedNodes.indexOf(node)]! }
        : { ...node, position: { x: 900 + index * 20, y: 900 + index * 20 } }),
    }
    const selectedIds = selectedNodes.map((node) => node.id)

    const horizontal = workflowPage.alignWorkflowNodes(positioned, selectedIds, 'distribute-horizontal')
    const vertical = workflowPage.alignWorkflowNodes(positioned, selectedIds, 'distribute-vertical')

    expect(horizontal.nodes.filter((node) => selectedIds.includes(node.id)).map((node) => node.position)).toEqual([
      { x: 80, y: 70 },
      { x: 310, y: 180 },
      { x: 540, y: 310 },
    ])
    expect(vertical.nodes.filter((node) => selectedIds.includes(node.id)).map((node) => node.position)).toEqual([
      { x: 80, y: 70 },
      { x: 360, y: 190 },
      { x: 540, y: 310 },
    ])
  })

  it('supports undo and redo for workflow edits and clears redo after a new branch', () => {
    const workflow = graphWithRemovedNode()
    const agent = workflow.nodes.find((node) => node.type === 'ai-task')!
    const edited = workflowPage.removeWorkflowNode(workflow, agent.id)
    const history = workflowPage.recordWorkflowHistory(workflowPage.createWorkflowHistory(workflow), edited)

    const undone = workflowPage.undoWorkflowHistory(history)
    expect(undone.present.nodes).toHaveLength(workflow.nodes.length)
    expect(undone.future).toHaveLength(1)

    const redone = workflowPage.redoWorkflowHistory(undone)
    expect(redone.present.nodes).toHaveLength(edited.nodes.length)
    expect(redone.present.nodes.some((node) => node.id === agent.id)).toBe(false)

    const branched = workflowPage.recordWorkflowHistory(redone, { ...redone.present, name: 'New branch' })
    expect(branched.future).toHaveLength(0)
  })

  it('does not treat editing controls as canvas delete targets', () => {
    expect(workflowPage.isWorkflowFormElement({ tagName: 'TEXTAREA', isContentEditable: false } as HTMLElement)).toBe(true)
    expect(workflowPage.isWorkflowFormElement({ tagName: 'INPUT', isContentEditable: false } as HTMLElement)).toBe(true)
    expect(workflowPage.isWorkflowFormElement({ tagName: 'DIV', isContentEditable: false } as HTMLElement)).toBe(false)
    expect(workflowPage.isWorkflowFormElement({ tagName: 'DIV', isContentEditable: true } as HTMLElement)).toBe(true)
  })

  it('recognizes undo and redo shortcuts for both macOS and Windows', () => {
    expect(workflowPage.workflowKeyboardAction({ key: 'z', metaKey: true, ctrlKey: false, shiftKey: false })).toBe('undo')
    expect(workflowPage.workflowKeyboardAction({ key: 'z', metaKey: false, ctrlKey: true, shiftKey: true })).toBe('redo')
    expect(workflowPage.workflowKeyboardAction({ key: 'y', metaKey: false, ctrlKey: true, shiftKey: false })).toBe('redo')
    expect(workflowPage.workflowKeyboardAction({ key: 'z', metaKey: false, ctrlKey: false, shiftKey: false })).toBeUndefined()
  })

  it('recognizes Cmd/Ctrl+A as the canvas select-all shortcut', () => {
    expect(workflowPage.workflowKeyboardAction({ key: 'a', metaKey: true, ctrlKey: false, shiftKey: false })).toBe('select-all')
    expect(workflowPage.workflowKeyboardAction({ key: 'A', metaKey: false, ctrlKey: true, shiftKey: false })).toBe('select-all')
  })

  it('recognizes Cmd/Ctrl+S as the canvas save shortcut', () => {
    expect(workflowPage.workflowKeyboardAction({ key: 's', metaKey: true, ctrlKey: false, shiftKey: false })).toBe('save')
    expect(workflowPage.workflowKeyboardAction({ key: 'S', metaKey: false, ctrlKey: true, shiftKey: false })).toBe('save')
    expect(workflowPage.workflowKeyboardAction({ key: 's', metaKey: true, ctrlKey: false, shiftKey: true })).toBeUndefined()
  })

  it('recognizes Cmd/Ctrl+C and Cmd/Ctrl+V as canvas node copy and paste shortcuts', () => {
    expect(workflowPage.workflowKeyboardAction({ key: 'c', metaKey: true, ctrlKey: false, shiftKey: false })).toBe('copy')
    expect(workflowPage.workflowKeyboardAction({ key: 'V', metaKey: false, ctrlKey: true, shiftKey: false })).toBe('paste')
    expect(workflowPage.workflowKeyboardAction({ key: 'c', metaKey: true, ctrlKey: false, shiftKey: true })).toBeUndefined()
  })

  it('duplicates selected nodes with a fresh id, independent config, and an offset position', () => {
    const workflow = createDefaultWorkflow('Duplicate')
    const source = workflow.nodes.find((node) => node.type === 'ai-task')!

    const duplicate = workflowPage.duplicateWorkflowNodes([source], () => 'ai-task-copy', { x: 48, y: 32 })[0]!

    expect(duplicate).toMatchObject({ id: 'ai-task-copy', type: source.type, label: source.label, position: { x: source.position.x + 48, y: source.position.y + 32 } })
    expect(duplicate.config).toEqual(source.config)
    expect(duplicate.config).not.toBe(source.config)
  })

  it('offers start fields and declared upstream outputs as named node-input variables', () => {
    const workflow = createDefaultWorkflow('Variable options')
    const input = workflow.nodes.find((node) => node.type === 'input')!
    const research = workflow.nodes.find((node) => node.type === 'ai-task')!
    const target = workflow.nodes.find((node) => node.type === 'output')!
    research.outputVariables = [{ name: 'summary', description: '调研结论' }, { name: 'sources' }]

    expect(workflowPage.getWorkflowVariableOptions(workflow, target.id)).toEqual(expect.arrayContaining([
      { sourceNodeId: input.id, sourcePath: undefined, label: '开始 · task' },
      { sourceNodeId: research.id, sourcePath: undefined, label: '智能处理 · result' },
      { sourceNodeId: research.id, sourcePath: 'summary', label: '智能处理 · summary' },
      { sourceNodeId: research.id, sourcePath: 'sources', label: '智能处理 · sources' },
    ]))
  })

  it('does not offer downstream nodes as variable sources', () => {
    const workflow = createDefaultWorkflow('Variable direction')
    const input = workflow.nodes.find((node) => node.type === 'input')!
    const aiTask = workflow.nodes.find((node) => node.type === 'ai-task')!

    const options = workflowPage.getWorkflowVariableOptions(workflow, aiTask.id)

    expect(options.some((option) => option.sourceNodeId === input.id)).toBe(true)
    expect(options.some((option) => option.sourceNodeId === workflow.nodes.find((node) => node.type === 'output')!.id)).toBe(false)
  })

  it('selects every workflow node without changing node data', () => {
    const nodes: Node[] = [
      { id: 'first', position: { x: 20, y: 40 }, data: { label: 'First' }, selected: false },
      { id: 'second', position: { x: 120, y: 140 }, data: { label: 'Second' } },
    ]

    const selected = workflowPage.selectAllWorkflowNodes(nodes)

    expect(selected.map((node) => node.selected)).toEqual([true, true])
    expect(selected.map((node) => ({ id: node.id, position: node.position, data: node.data }))).toEqual(nodes.map((node) => ({ id: node.id, position: node.position, data: node.data })))
  })

  it('preserves selected nodes when canvas data is rebuilt after an operation', () => {
    const nodes: Node[] = [
      { id: 'first', position: { x: 20, y: 40 }, data: { label: 'First' }, selected: false },
      { id: 'second', position: { x: 120, y: 140 }, data: { label: 'Second' }, selected: false },
      { id: 'third', position: { x: 220, y: 240 }, data: { label: 'Third' }, selected: false },
    ]

    const rebuilt = workflowPage.preserveWorkflowNodeSelection(nodes, ['first', 'third'])

    expect(rebuilt.map((node) => node.selected)).toEqual([true, false, true])
  })

  it('uses a left input and right output for every ordinary canvas node', () => {
    expect(workflowPage.workflowNodeHandleLayout('ai-task')).toEqual({ input: 'left', output: 'right' })
    expect(workflowPage.workflowNodeHandleLayout('input')).toEqual({ output: 'right' })
    expect(workflowPage.workflowNodeHandleLayout('output')).toEqual({ input: 'left' })
    expect(workflowPage.workflowNodeHandleLayout('condition')).toEqual({ input: 'left', output: 'right' })
  })

  it('provides a distinct accessible type icon for every workflow node type', () => {
    const types: WorkflowNodeType[] = ['input', 'ai-task', 'employee', 'skill', 'mcp', 'parallel', 'loop', 'sleep', 'condition', 'approval', 'transform', 'text-merge', 'output', 'shell', 'file']

    for (const type of types) {
      const markup = renderToStaticMarkup(<workflowPage.WorkflowNodeTypeIcon type={type} />)
      expect(markup).toContain(`data-node-icon="${type}"`)
      expect(markup).toContain(`workflow-node-type-${type}`)
    }
  })

  it('uses Chinese names for every flow-control node', () => {
    const labelFor = (workflowPage as unknown as { workflowNodeTypeLabel?: (type: WorkflowNodeType) => string }).workflowNodeTypeLabel

    expect((['parallel', 'loop', 'sleep', 'condition', 'approval', 'transform', 'text-merge'] as WorkflowNodeType[]).map((type) => labelFor?.(type))).toEqual([
      '并行处理',
      '循环遍历',
      '等待',
      '条件判断',
      '人工审批',
      '数据转换',
      '文本合并',
    ])
  })

  it('exposes text merge as an addable flow-control node', () => {
    expect(workflowPage.WORKFLOW_ADDABLE_NODE_TYPES).toContain('text-merge' as never)
  })

  it('exposes sleep as an addable flow-control node', () => {
    expect(workflowPage.WORKFLOW_ADDABLE_NODE_TYPES).toContain('sleep' as never)
  })

  it('uses Chinese labels for condition operators and transform modes', () => {
    const conditionLabel = (workflowPage as unknown as { workflowConditionOperatorLabel?: (operator: string) => string }).workflowConditionOperatorLabel
    const transformLabel = (workflowPage as unknown as { workflowTransformTemplateLabel?: (template: string) => string }).workflowTransformTemplateLabel

    expect(['truthy', 'equals', 'not-equals', 'contains', 'greater-than', 'less-than'].map((operator) => conditionLabel?.(operator))).toEqual([
      '为真', '等于', '不等于', '包含', '大于', '小于',
    ])
    expect(['identity', 'json', 'extract-text', 'prepend', 'append', 'replace', 'text'].map((template) => transformLabel?.(template))).toEqual([
      '传递原值', '转为 JSON', '提取文本', '前置文本', '追加文本', '替换文本', '自定义文本',
    ])
  })

  it('inserts a workflow variable token at the editor selection', () => {
    expect(workflowPage.insertWorkflowVariableToken('请结合 继续写作', 'research', 4, 4)).toEqual({
      value: '请结合 {{research}}继续写作',
      cursor: 16,
    })
    expect(workflowPage.insertWorkflowVariableToken('旧变量', 'outline', 0, 3)).toEqual({
      value: '{{outline}}',
      cursor: 11,
    })
  })

  it('summarizes node-local inputs on the canvas card', () => {
    const workflow = createDefaultWorkflow('Variable card')
    const aiTask = workflow.nodes.find((node) => node.type === 'ai-task')!
    aiTask.inputBindings = [
      { id: 'binding-topic', name: 'topic', sourceNodeId: workflow.nodes[0]!.id, required: true },
      { id: 'binding-research', name: 'research', sourceNodeId: workflow.nodes[1]!.id, sourcePath: 'summary', required: true },
    ]

    aiTask.outputVariables = [{ name: 'summary' }, { name: 'sources' }]
    const flowNode = workflowPage.workflowFlowNodes(workflow).find((node) => node.id === aiTask.id)
    expect(flowNode?.data.inputVariables).toEqual(['topic', 'research'])
    expect(flowNode?.data.outputVariables).toEqual(['summary', 'sources'])
    expect(flowNode?.height).toBe(112)
  })

  it('shows non-linear variable dependencies in execution relationships without duplicating flow edges', () => {
    const workflow = createDefaultWorkflow('Variable relationships')
    const inputNode = workflow.nodes.find((node) => node.type === 'input')!
    const aiTask = workflow.nodes.find((node) => node.type === 'ai-task')!
    const outputNode = workflow.nodes.find((node) => node.type === 'output')!
    const variableOnlyWorkflow = {
      ...workflow,
      edges: workflow.edges.filter((edge) => edge.target !== outputNode.id),
      nodes: workflow.nodes.map((node) => node.id === outputNode.id ? { ...node, inputBindings: [{ id: 'output-result', name: 'result', sourceNodeId: aiTask.id, required: true }] } : node),
    }

    const executionEdges = workflowPage.workflowExecutionEdges(variableOnlyWorkflow)

    expect(executionEdges).toHaveLength(variableOnlyWorkflow.edges.length + 1)
    expect(executionEdges.at(-1)).toMatchObject({ source: aiTask.id, target: outputNode.id, className: 'workflow-variable-dependency-edge' })
    expect(executionEdges.filter((edge) => edge.source === inputNode.id && edge.target === aiTask.id)).toHaveLength(1)
  })

  it('maps the persisted default output port to the custom node default handle', () => {
    const workflow = createDefaultWorkflow('Default port')
    const edge = workflow.edges[0]!
    const input = workflow.nodes[0]!
    const target = workflow.nodes[1]!
    const persistedDefaultPortWorkflow = {
      ...workflow,
      edges: [{ ...edge, source: input.id, target: target.id, sourcePort: 'default' as const }],
    }

    expect(workflowPage.workflowFlowEdges(persistedDefaultPortWorkflow)[0]?.sourceHandle).toBeUndefined()
  })

  it('renders loop body and continuation ports on their distinct handles', () => {
    const workflow = createDefaultWorkflow('Loop ports')
    const loop = workflow.nodes.find((node) => node.type === 'ai-task')!
    const output = workflow.nodes.find((node) => node.type === 'output')!
    const body = workflow.nodes.find((node) => node.type === 'input')!
    const withLoopPorts = {
      ...workflow,
      edges: [
        { id: 'loop-body', source: loop.id, target: body.id, sourcePort: 'loop-body' as const },
        { id: 'loop-next', source: loop.id, target: output.id, sourcePort: 'loop-next' as const },
      ],
    }

    expect(workflowPage.workflowFlowEdges(withLoopPorts).map((edge) => edge.sourceHandle)).toEqual(['loop-body', 'loop-next'])
  })

  it('maps switch case and default ports to their visible handles', () => {
    const workflow = createDefaultWorkflow('Switch ports')
    const route = { id: 'route', type: 'switch' as const, label: '路由', config: { cases: [{ id: 'urgent', label: '紧急', value: 'urgent' }] }, position: { x: 220, y: 0 } }
    const output = { ...workflow.nodes.find((node) => node.type === 'output')!, inputBindings: [] }
    const withSwitchPorts = { ...workflow, nodes: [...workflow.nodes.filter((node) => node.type !== 'ai-task' && node.type !== 'output'), route, output], edges: [
      { id: 'case', source: route.id, target: output.id, sourcePort: 'switch:urgent' as const },
      { id: 'default', source: route.id, target: output.id, sourcePort: 'default' as const },
    ] }

    expect(workflowPage.workflowFlowEdges(withSwitchPorts).map((edge) => edge.sourceHandle)).toEqual(['switch:urgent', 'default'])
    expect(workflowPage.workflowFlowEdges(withSwitchPorts).map((edge) => edge.label)).toEqual(['紧急', '默认'])
  })

  it('builds editor edges from the persisted workflow graph even when transient edge state is empty', () => {
    const workflow = createDefaultWorkflow('Persisted graph')

    const canvasEdges = workflowPage.workflowCanvasEdges(workflow, [])

    expect(canvasEdges).toHaveLength(workflow.edges.length)
    expect(canvasEdges.map((edge) => [edge.source, edge.target])).toEqual(workflow.edges.map((edge) => [edge.source, edge.target]))
  })

  it('keeps measured node geometry when execution history is opened directly', () => {
    const workflow = createDefaultWorkflow('Direct execution history')

    const executionNodes = workflowPage.workflowExecutionFlowNodes(workflow)

    expect(executionNodes).toHaveLength(workflow.nodes.length)
    expect(executionNodes.every((node) => node.measured?.width === node.width && node.measured?.height === node.height)).toBe(true)
  })

  it('uses an execution-only node position without changing the workflow definition position', () => {
    const workflow = createDefaultWorkflow('Execution layout')
    const input = workflow.nodes.find((node) => node.type === 'input')!
    const originalPosition = { ...input.position }
    const executionNodes = workflowPage.workflowExecutionFlowNodes(workflow, undefined, undefined, [], { [input.id]: { x: 920, y: 140 } })

    expect(executionNodes.find((node) => node.id === input.id)?.position).toEqual({ x: 920, y: 140 })
    expect(workflow.nodes.find((node) => node.id === input.id)?.position).toEqual(originalPosition)
  })

  it('automatically lays out a graph by dependency depth instead of trusting overlapping positions', () => {
    const workflow = createDefaultWorkflow('Automatic layout')
    const overlapping = { ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, position: { x: 0, y: 0 } })) }

    const laidOut = workflowPage.layoutWorkflowNodes(overlapping)

    expect(laidOut.nodes.map((node) => node.position)).toEqual([
      { x: 80, y: 180 },
      { x: 344, y: 180 },
      { x: 608, y: 180 },
    ])
  })

  it('uses drag selection by default and Space to pan the workflow canvas', () => {
    expect(workflowPage.WORKFLOW_CANVAS_INTERACTION_PROPS).toMatchObject({
      selectionOnDrag: true,
      panOnDrag: false,
      panActivationKeyCode: 'Space',
    })
  })

  it('keeps execution topology read-only while allowing node dragging', () => {
    expect(workflowPage.WORKFLOW_EXECUTION_CANVAS_INTERACTION_PROPS).toMatchObject({
      nodesDraggable: true,
      nodesConnectable: false,
      edgesReconnectable: false,
      deleteKeyCode: null,
    })
  })

  it('centers the canvas when the minimap is clicked and lets the minimap pan directly', () => {
    expect(workflowPage.WORKFLOW_MINIMAP_INTERACTION_PROPS).toEqual({ pannable: true })

    const setCenter = vi.fn(async () => true)
    workflowPage.centerWorkflowFromMiniMap(setCenter, { x: 120, y: 80 }, 1.25)

    expect(setCenter).toHaveBeenCalledWith(120, 80, { duration: 180, zoom: 1.25 })
  })

  it('derives named launch fields from input nodes and builds a structured run payload', () => {
    const workflow = createDefaultWorkflow('Run setup')
    const fields = workflowPage.getWorkflowLaunchFields(workflow)

    expect(fields).toEqual([{ id: workflow.nodes[0]?.id, key: 'task', label: '开始', required: false }])
    expect(workflowPage.createWorkflowLaunchValues(fields)).toEqual({})
    expect(workflowPage.buildWorkflowLaunchInput(fields, {})).toEqual({})
    expect(workflowPage.buildWorkflowLaunchInput(fields, { task: '准备今天的选题' })).toEqual({ task: '准备今天的选题' })
  })

  it('adapts structured workflow fields as required by default', () => {
    const workflow = createDefaultWorkflow('Structured required input')
    const input = workflow.nodes[0]
    if (input?.type !== 'input') throw new Error('starter graph should contain an input node')
    input.config.fields = [{ name: 'topic', label: '主题' }]

    expect(workflowPage.getWorkflowLaunchFields(workflow)).toEqual([
      { id: `${input.id}-1`, key: 'topic', label: '主题', required: true },
    ])
  })

  it('starts a legacy workflow with an omitted optional input through the bridge', async () => {
    const workflow = createDefaultWorkflow('Legacy empty launch')
    const record: WorkflowRunRecord = { id: 'legacy-empty-run', workflowId: workflow.id, workflowRevision: workflow.revision, status: 'queued', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    const start = vi.fn(async () => record)
    const previousGlobals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent, KeyboardEvent: globalThis.KeyboardEvent, CustomEvent: globalThis.CustomEvent, getComputedStyle: globalThis.getComputedStyle, ResizeObserver: globalThis.ResizeObserver, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, EzDSH: (globalThis as { EzDSH?: unknown }).EzDSH }
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
    const requestAnimationFrame = (_callback: FrameRequestCallback): number => 0
    const cancelAnimationFrame = (_id: number): void => {}
    Object.defineProperty(domWindow.HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 960, bottom: 640, width: 960, height: 640, toJSON: () => ({}) }) })
    Object.assign(globalThis, { window: domWindow, document: domWindow.document, HTMLElement: domWindow.HTMLElement, Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, CustomEvent: domWindow.CustomEvent, getComputedStyle: domWindow.getComputedStyle.bind(domWindow), ResizeObserver: TestResizeObserver, requestAnimationFrame, cancelAnimationFrame })
    Object.assign(domWindow as unknown as Record<string, unknown>, { ResizeObserver: TestResizeObserver, requestAnimationFrame, cancelAnimationFrame })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
    const bridge = {
      workflows: { list: vi.fn(async () => [workflow]), listRuns: vi.fn(async () => []), update: vi.fn(async () => workflow), start, onStateChange: vi.fn(() => () => {}), listModificationHistory: vi.fn(async () => []), onModificationStateChange: vi.fn(() => () => {}) },
      providers: { listWorkflowModels: vi.fn(async () => []) },
      employees: { list: vi.fn(async () => []), onStateChange: vi.fn(() => () => {}) },
      workflowCredentials: { list: vi.fn(async () => []) },
      workflowConnectors: { list: vi.fn(async () => []) },
      workflowEnvironments: { list: vi.fn(async () => []) },
      workflowReleases: { list: vi.fn(async () => []), listObservations: vi.fn(async () => []), getOperationalHealth: vi.fn(unknownOperationalHealth) },
    }
    ;(globalThis as { EzDSH?: unknown }).EzDSH = bridge
    ;(domWindow as unknown as { EzDSH?: unknown }).EzDSH = bridge
    const root = createRoot(domWindow.document.getElementById('root')!)
    try {
      await act(async () => { root.render(<workflowPage.WorkflowPage copy={getAppCopy('zh')} locale="zh" />); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) })
      const open = domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement
      await act(async () => { open.click(); await Promise.resolve() })
      const run = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowRun) as HTMLButtonElement
      await act(async () => { run.click(); await Promise.resolve(); await Promise.resolve() })
      const dialog = domWindow.document.querySelector('[role="dialog"]') as HTMLElement
      const submit = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowStartRun) as HTMLButtonElement
      await act(async () => { submit.click(); await Promise.resolve(); await Promise.resolve() })

      expect(start).toHaveBeenCalledWith(workflow.id, {}, { allowShellFile: false, allowCode: false, connectorGrants: [], debug: false })
    } finally {
      await act(async () => { root.unmount() })
      delete (globalThis as { EzDSH?: unknown }).EzDSH
      const { navigator: previousNavigator, ...rest } = previousGlobals
      Object.assign(globalThis, rest)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    }
  })

  it('parses typed launch fields before starting the workflow', () => {
    const fields = [
      { id: 'count', key: 'count', label: '数量', type: 'number' as const },
      { id: 'enabled', key: 'enabled', label: '启用', type: 'boolean' as const },
      { id: 'items', key: 'items', label: '项目', type: 'json' as const },
    ]

    expect(workflowPage.buildWorkflowLaunchInput(fields, {
      count: '3',
      enabled: 'false',
      items: '["A", "B"]',
    })).toEqual({ count: 3, enabled: false, items: ['A', 'B'] })
  })

  it('formats JSON launch defaults without changing string value types', () => {
    const fields: workflowPage.WorkflowLaunchField[] = [
      { id: 'json-text', key: 'jsonText', label: 'JSON 文本', type: 'json', defaultValue: 'hello' },
      { id: 'json-false-text', key: 'jsonFalseText', label: 'JSON false 文本', type: 'json', defaultValue: 'false' },
      { id: 'json-number-text', key: 'jsonNumberText', label: 'JSON 数字文本', type: 'json', defaultValue: '42' },
      { id: 'json-null-text', key: 'jsonNullText', label: 'JSON null 文本', type: 'json', defaultValue: 'null' },
      { id: 'json-empty-text', key: 'jsonEmptyText', label: 'JSON 空文本', type: 'json', defaultValue: '' },
      { id: 'json-object', key: 'jsonObject', label: 'JSON 对象', type: 'json', defaultValue: { ok: true } },
      { id: 'json-array', key: 'jsonArray', label: 'JSON 数组', type: 'json', defaultValue: [1, 'two'] },
      { id: 'json-number', key: 'jsonNumber', label: 'JSON 数字', type: 'json', defaultValue: 7 },
      { id: 'json-boolean', key: 'jsonBoolean', label: 'JSON 布尔', type: 'json', defaultValue: false },
      { id: 'json-null', key: 'jsonNull', label: 'JSON null', type: 'json', defaultValue: null },
      { id: 'string', key: 'string', label: '文本', defaultValue: 'plain' },
      { id: 'file', key: 'file', label: '文件', type: 'file', defaultValue: 'docs/a.txt' },
    ]
    const expectedInput = {
      jsonText: 'hello', jsonFalseText: 'false', jsonNumberText: '42', jsonNullText: 'null', jsonEmptyText: '',
      jsonObject: { ok: true }, jsonArray: [1, 'two'], jsonNumber: 7, jsonBoolean: false, jsonNull: null,
      string: 'plain', file: 'docs/a.txt',
    }
    const values = workflowPage.createWorkflowLaunchValues(fields)

    expect(values).toEqual({
      jsonText: '"hello"', jsonFalseText: '"false"', jsonNumberText: '"42"', jsonNullText: '"null"', jsonEmptyText: '""',
      jsonObject: '{"ok":true}', jsonArray: '[1,"two"]', jsonNumber: '7', jsonBoolean: 'false', jsonNull: 'null',
      string: 'plain', file: 'docs/a.txt',
    })
    expect(workflowPage.buildWorkflowLaunchInput(fields, values)).toEqual(expectedInput)
  })

  it('uses the same type-aware JSON formatting when launch values omit configured defaults', () => {
    const fields: workflowPage.WorkflowLaunchField[] = [
      { id: 'text', key: 'text', label: '文本', type: 'json', defaultValue: 'false' },
      { id: 'empty', key: 'empty', label: '空文本', type: 'json', defaultValue: '' },
      { id: 'object', key: 'object', label: '对象', type: 'json', defaultValue: { count: 2 } },
      { id: 'number', key: 'number', label: '数字', type: 'json', defaultValue: 42 },
      { id: 'boolean', key: 'boolean', label: '布尔', type: 'json', defaultValue: true },
      { id: 'null', key: 'null', label: 'null', type: 'json', defaultValue: null },
    ]

    expect(workflowPage.buildWorkflowLaunchInput(fields, {})).toEqual({
      text: 'false', empty: '', object: { count: 2 }, number: 42, boolean: true, null: null,
    })
  })

  it('parses workspace file and file-list launch fields', () => {
    const fields = [
      { id: 'document', key: 'document', label: '文档', type: 'file' as const },
      { id: 'attachments', key: 'attachments', label: '附件', type: 'file-list' as const },
    ]
    expect(workflowPage.buildWorkflowLaunchInput(fields, { document: 'docs/a.txt', attachments: 'docs/a.txt\ndocs/b.txt' })).toEqual({ document: 'docs/a.txt', attachments: ['docs/a.txt', 'docs/b.txt'] })
  })

  it('omits untouched optional launch fields while preserving explicit empty strings and defaults', () => {
    const fields: workflowPage.WorkflowLaunchField[] = [
      { id: 'title', key: 'title', label: '标题', required: false },
      { id: 'count', key: 'count', label: '数量', type: 'number', required: false },
      { id: 'enabled', key: 'enabled', label: '启用', type: 'boolean', required: false },
      { id: 'payload', key: 'payload', label: '参数', type: 'json', required: false },
      { id: 'document', key: 'document', label: '文档', type: 'file', required: false },
      { id: 'attachments', key: 'attachments', label: '附件', type: 'file-list', required: false },
      { id: 'limit', key: 'limit', label: '上限', type: 'number', required: false, defaultValue: 2 },
    ]

    expect(workflowPage.createWorkflowLaunchValues(fields)).toEqual({ limit: '2' })
    expect(workflowPage.buildWorkflowLaunchInput(fields, {})).toEqual({ limit: 2 })
    expect(workflowPage.buildWorkflowLaunchInput(fields, { title: '' })).toEqual({ title: '', limit: 2 })
    expect(workflowPage.buildWorkflowLaunchInput(fields, {
      count: '', enabled: ' ', payload: '', document: '', attachments: '',
    })).toEqual({ limit: 2 })
  })

  it('treats launch fields as required by default and rejects missing or blank string and file values', () => {
    expect(() => workflowPage.buildWorkflowLaunchInput([
      { id: 'title', key: 'title', label: '标题' },
    ], {})).toThrow('“标题”为必填项。')
    expect(() => workflowPage.buildWorkflowLaunchInput([
      { id: 'title', key: 'title', label: '标题' },
    ], { title: '  ' })).toThrow('“标题”为必填项。')
    expect(() => workflowPage.buildWorkflowLaunchInput([
      { id: 'document', key: 'document', label: '文档', type: 'file' },
    ], { document: '' })).toThrow('“文档”为必填项。')
  })

  it('chooses the fresher same-id workflow run instead of preserving a stale queued record', () => {
    const queued: WorkflowRunRecord = { id: 'run-freshness', workflowId: 'workflow-a', workflowRevision: 1, status: 'queued', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    const completed: WorkflowRunRecord = { ...queued, status: 'completed', startedAt: '2026-09-12T01:00:00.000Z', completedAt: '2026-09-12T01:00:03.000Z', events: [{ id: 'event-completed', time: '2026-09-12T01:00:03.000Z', type: 'run-completed' }] }
    const eventBeforeList: WorkflowRunRecord = { ...queued, status: 'running', startedAt: '2026-09-12T01:00:02.000Z', events: [{ id: 'event-running', time: '2026-09-12T01:00:02.000Z', type: 'node-started' }] }

    expect(workflowPage.chooseFresherWorkflowRun(queued, completed)).toBe(completed)
    expect(workflowPage.chooseFresherWorkflowRun(completed, queued)).toBe(completed)
    expect(workflowPage.mergeWorkflowRunRecords([eventBeforeList], [queued])).toEqual([eventBeforeList])
  })

  it('uses causal event extensions for resumable failures without regressing completed or cancelled runs', () => {
    const base: WorkflowRunRecord = {
      id: 'run-causal-freshness', workflowId: 'workflow-a', workflowRevision: 1, status: 'failed', input: {}, allowShellFile: false, nodeStates: [],
      completedAt: '2026-09-12T02:00:00.000Z',
      events: [
        { id: 'created-1', time: '2026-09-12T01:00:00.000Z', type: 'run-created' },
        { id: 'failed-1', time: '2026-09-12T02:00:00.000Z', type: 'run-failed' },
      ],
    }
    const resumed: WorkflowRunRecord = {
      ...base, status: 'queued', completedAt: undefined,
      events: [...base.events, { id: 'resumed-1', time: '2026-09-12T00:30:00.000Z', type: 'run-created', message: '运行已重新排队' }],
    }
    const unexplainedQueued: WorkflowRunRecord = {
      ...base, status: 'queued', completedAt: undefined,
      events: [...base.events, { id: 'node-after-failure', time: '2026-09-12T03:00:00.000Z', type: 'node-started' }],
    }
    const completed: WorkflowRunRecord = { ...base, status: 'completed', completedAt: '2026-09-12T02:00:00.000Z', events: [...base.events, { id: 'completed-1', time: '2026-09-12T02:00:00.000Z', type: 'run-completed' }] }
    const reconciled: WorkflowRunRecord = { ...base, status: 'queued', completedAt: undefined, events: [...base.events, { id: 'effect-reconciled-1', time: '2026-09-12T02:30:00.000Z', type: 'node-effect-reconciled-not-dispatched' }] }
    const runningAfterReconciliation: WorkflowRunRecord = { ...reconciled, status: 'running', events: [...reconciled.events, { id: 'effect-run-started-1', time: '2026-09-12T02:31:00.000Z', type: 'run-started' }] }
    const cancelled: WorkflowRunRecord = { ...base, status: 'cancelled', completedAt: '2026-09-12T02:00:00.000Z', events: [...base.events, { id: 'cancelled-1', time: '2026-09-12T02:00:00.000Z', type: 'run-cancelled' }] }
    const impossibleRunningAfterCompleted: WorkflowRunRecord = { ...completed, status: 'running', completedAt: undefined, events: [...completed.events, { id: 'running-after-complete', time: '2026-09-12T04:00:00.000Z', type: 'run-started' }] }
    const impossibleQueuedAfterCancelled: WorkflowRunRecord = { ...cancelled, status: 'queued', completedAt: undefined, events: [...cancelled.events, { id: 'queued-after-cancel', time: '2026-09-12T04:00:00.000Z', type: 'run-created' }] }
    const waitingApproval: WorkflowRunRecord = { ...base, status: 'waiting-approval', completedAt: undefined, events: [{ id: 'approval-run-created-1', time: '2026-09-12T02:00:00.000Z', type: 'run-created' }, { id: 'approval-requested-1', time: '2026-09-12T02:10:00.000Z', type: 'approval-requested' }] }
    const approved: WorkflowRunRecord = { ...waitingApproval, status: 'queued', events: [...waitingApproval.events, { id: 'approval-approved-1', time: '2026-09-12T02:11:00.000Z', type: 'approval-approved' }] }
    const retrying: WorkflowRunRecord = { ...base, status: 'running', completedAt: undefined, events: [{ id: 'retry-run-created-1', time: '2026-09-12T02:00:00.000Z', type: 'run-created' }, { id: 'run-started-retry-1', time: '2026-09-12T02:20:00.000Z', type: 'run-started' }] }
    const retried: WorkflowRunRecord = { ...retrying, status: 'queued', events: [...retrying.events, { id: 'node-retry-1', time: '2026-09-12T02:21:00.000Z', type: 'node-retry' }] }

    expect(workflowPage.chooseFresherWorkflowRun(base, resumed)).toBe(resumed)
    expect(workflowPage.chooseFresherWorkflowRun(base, reconciled)).toBe(reconciled)
    expect(workflowPage.chooseFresherWorkflowRun(reconciled, runningAfterReconciliation)).toBe(runningAfterReconciliation)
    expect(workflowPage.chooseFresherWorkflowRun(base, unexplainedQueued)).toBe(base)
    expect(workflowPage.chooseFresherWorkflowRun(completed, impossibleRunningAfterCompleted)).toBe(completed)
    expect(workflowPage.chooseFresherWorkflowRun(cancelled, impossibleQueuedAfterCancelled)).toBe(cancelled)
    expect(workflowPage.chooseFresherWorkflowRun(waitingApproval, approved)).toBe(approved)
    expect(workflowPage.chooseFresherWorkflowRun(retrying, retried)).toBe(retried)
  })

  it('ignores invalid run timestamps instead of comparing their raw text', () => {
    const current: WorkflowRunRecord = { id: 'run-invalid-time', workflowId: 'workflow-a', workflowRevision: 1, status: 'running', input: {}, allowShellFile: false, nodeStates: [], events: [{ id: 'valid-event', time: '2026-09-12T02:00:00.000Z', type: 'node-started' }] }
    const incoming: WorkflowRunRecord = { ...current, events: [{ id: 'conflicting-event', time: 'not-a-date', type: 'node-started' }] }
    const cancelled: WorkflowRunRecord = { ...current, status: 'cancelled', completedAt: 'not-a-date', events: [...current.events, { id: 'cancelled-event', time: 'not-a-date', type: 'run-cancelled' }] }
    const impossibleQueued: WorkflowRunRecord = { ...cancelled, status: 'queued', completedAt: undefined, events: [...cancelled.events, { id: 'queued-after-cancel', time: 'also-not-a-date', type: 'run-created' }] }

    expect(workflowPage.chooseFresherWorkflowRun(current, incoming)).toBe(current)
    expect(workflowPage.chooseFresherWorkflowRun(cancelled, impossibleQueued)).toBe(cancelled)
  })

  it('preserves JSON value types entered in a condition setting', () => {
    const parseValue = (workflowPage as unknown as { parseWorkflowConditionValue?: (value: string) => unknown }).parseWorkflowConditionValue

    expect(parseValue?.('3')).toBe(3)
    expect(parseValue?.('false')).toBe(false)
    expect(parseValue?.('["A", "B"]')).toEqual(['A', 'B'])
    expect(parseValue?.('普通文本')).toBe('普通文本')
  })

  it('derives multiple launch fields and field-level variable sources from structured input nodes', () => {
    const workflow = createDefaultWorkflow('Structured run setup')
    const input = workflow.nodes[0]
    if (input?.type !== 'input') throw new Error('starter graph should contain an input node')
    input.config = {
      fields: [
        { name: 'topic', label: '主题', type: 'string', required: true },
        { name: 'audience', label: '受众', type: 'string', required: false, defaultValue: '产品经理' },
      ],
    }
    const target = workflow.nodes.find((node) => node.type === 'output')!

    expect(workflowPage.getWorkflowLaunchFields(workflow)).toEqual([
      { id: `${input.id}-1`, key: 'topic', label: '主题', required: true },
      { id: `${input.id}-2`, key: 'audience', label: '受众', defaultValue: '产品经理', required: false },
    ])
    expect(workflowPage.getWorkflowVariableOptions(workflow, target.id)).toEqual(expect.arrayContaining([
      { sourceNodeId: input.id, sourcePath: 'topic', label: '开始 · 主题' },
      { sourceNodeId: input.id, sourcePath: 'audience', label: '开始 · 受众' },
    ]))
    expect(workflowPage.workflowFlowNodes(workflow)[0]?.data.inputVariables).toEqual(['主题', '受众'])
  })

  it('serializes portable workflow JSON and creates a safe download name', () => {
    const workflow = createDefaultWorkflow('公司/财务分析: 2026')
    const serialized = workflowPage.serializeWorkflowExport(workflow, '2026-08-31T00:00:00.000Z')

    expect(workflowPage.workflowExportFileName(workflow.name)).toBe('公司-财务分析-2026.json')
    expect(JSON.parse(serialized)).toMatchObject({ format: 'ezdsh.workflow', formatVersion: 1, workflow: { id: workflow.id } })
    expect(serialized.endsWith('\n')).toBe(true)
  })

  it('bundles referenced employee profiles in exported workflow JSON', () => {
    const workflow = createDefaultWorkflow('Employee export')
    const employeeNode = workflow.nodes.find((node) => node.type === 'ai-task')!
    const employeeWorkflow = {
      ...workflow,
      nodes: workflow.nodes.map((node) => node.id === employeeNode.id
        ? { ...node, type: 'employee', config: { employeeId: 'finance-analyst', instruction: '分析数据。', outputMode: 'text' } } as never
        : node),
    }
    const employees = [{
      schemaVersion: 2,
      version: 1,
      id: 'finance-analyst',
      name: '财务分析师',
      role: '财务研究专员',
      description: '分析财务数据。',
      businessBoundary: '只做客观分析。',
      systemPrompt: '你是一名财务研究专员。',
      operatingGuidelines: ['核对数据来源。'],
      qualityStandards: ['结论可复核。'],
      capabilities: ['research'] as const,
      skillIds: [],
      enabled: true,
      builtIn: false,
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    }]

    expect(JSON.parse(workflowPage.serializeWorkflowExport(employeeWorkflow, undefined, employees))).toMatchObject({ employees: [{ id: 'finance-analyst', name: '财务分析师' }] })
  })

  it('exposes each persisted node output and error for execution debugging', () => {
    const workflow = createDefaultWorkflow('Debug run')
    const node = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const run: WorkflowRunRecord = {
      id: 'run-debug',
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'failed',
      input: { task: '检查节点输出' },
      output: 'partial output',
      nodeStates: [{ nodeId: node.id, status: 'failed', startedAt: '2026-08-30T00:00:00.000Z', completedAt: '2026-08-30T00:00:01.000Z', output: { draft: 'partial output' }, error: '模型响应超时' }],
      events: [],
      allowShellFile: false,
    }

    const detail = workflowPage.getWorkflowNodeRunDetail(workflow, run, node.id)
    expect(detail).toMatchObject({
      node: { id: node.id, label: node.label },
      state: { status: 'failed', output: { draft: 'partial output' }, error: '模型响应超时' },
    })
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} nodeDetail={detail} statusLabel={() => '运行失败'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )
    expect(markup).toContain('节点结果')
    expect(markup).toContain('partial output')
    expect(markup).toContain('模型响应超时')
  })

  it('shows the final output only without a selected node, and the node output after selection', () => {
    const workflow = createDefaultWorkflow('Output selection')
    const node = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const run: WorkflowRunRecord = {
      id: 'run-output-selection',
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'completed',
      input: { task: '查看结果' },
      output: 'FINAL_OUTPUT_ONLY',
      nodeStates: [{ nodeId: node.id, status: 'completed', output: 'NODE_OUTPUT_ONLY' }],
      events: [],
      allowShellFile: false,
    }

    const finalMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )
    const nodeMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} nodeDetail={workflowPage.getWorkflowNodeRunDetail(workflow, run, node.id)} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )

    expect(finalMarkup).toContain('FINAL')
    expect(finalMarkup).not.toContain('NODE')
    expect(nodeMarkup).toContain('NODE')
    expect(nodeMarkup).not.toContain('FINAL')
  })

  it('shows run input and node input/output, with upstream navigation for derived input', () => {
    const workflow = createDefaultWorkflow('Input output selection')
    const inputNode = workflow.nodes.find((candidate) => candidate.type === 'input')!
    const node = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const run: WorkflowRunRecord = {
      id: 'run-input-output-selection',
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'completed',
      input: { task: '手工输入' },
      output: { final: '最终结果' },
      nodeStates: [
        { nodeId: inputNode.id, status: 'completed', input: { task: '手工输入' }, output: { task: '上游结果' } },
        { nodeId: node.id, status: 'completed', input: { long: '上游节点输出' }, output: { result: '节点结果' } },
      ],
      events: [],
      effectReconciliationTargets: [{ key: 'ordinary-effect', nodeId: node.id, nodeLabel: node.label, input: { recipient: 'Ada', receipt: 'R-42' } }],
      allowShellFile: false,
    }

    const finalMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )
    const nodeMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} nodeDetail={workflowPage.getWorkflowNodeRunDetail(workflow, run, node.id)} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} onSelectNode={vi.fn()} />,
    )

    expect(finalMarkup).toContain('运行输入')
    expect(finalMarkup).toContain('手工输入')
    expect(finalMarkup).toContain('最终结果')
    expect(nodeMarkup).toContain('节点输入')
    expect(nodeMarkup).toContain('节点输出')
    expect(nodeMarkup).toContain(`${node.label} · 节点输出`)
    expect(nodeMarkup).toContain('上游节点输出')
    expect(nodeMarkup).toContain('到上游')
  })

  it('shows the selected node prompt and configuration in a collapsed section', () => {
    const workflow = createDefaultWorkflow('Node configuration history')
    const node = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const run: WorkflowRunRecord = {
      id: 'run-node-configuration',
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'completed',
      input: { task: '对比提示词和结果' },
      output: '最终结果',
      nodeStates: [{ nodeId: node.id, status: 'completed', input: { task: '输入' }, output: '节点结果' }],
      events: [],
      allowShellFile: false,
    }

    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} nodeDetail={workflowPage.getWorkflowNodeRunDetail(workflow, run, node.id)} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )

    expect(markup).toContain('节点提示词与配置')
    expect(markup).toContain('请完成输入任务，并给出清晰、可执行的结果。')
    expect(markup).toMatch(/<details class="workflow-node-configuration"[^>]*>/u)
    expect(markup).not.toMatch(/<details class="workflow-node-configuration"[^>]*\bopen(?:=""|="open")?/u)
  })

  it('provides output copy, floating-window, and font-size controls', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputViewer copy={getAppCopy('zh')} value={{ result: '可复制结果' }} onCopy={vi.fn()} onOpenWindow={vi.fn()} fontScale={1} onIncreaseFont={vi.fn()} onDecreaseFont={vi.fn()} />,
    )

    expect(markup).toContain('复制结果')
    expect(markup).toContain('在浮层中打开')
    expect(markup).toContain('减小字体')
    expect(markup).toContain('增大字体')
  })

  it('clamps the execution detail height while dragging the split line', () => {
    expect(workflowPage.clampWorkflowExecutionDetailHeight(80, 900)).toBe(180)
    expect(workflowPage.clampWorkflowExecutionDetailHeight(420, 900)).toBe(420)
    expect(workflowPage.clampWorkflowExecutionDetailHeight(900, 900)).toBe(660)
  })

  it('keeps floating result windows reachable and constrains all four resize edges', () => {
    expect(workflowPage.clampWorkflowOutputWindowPosition({ x: -40, y: -80 }, { width: 400, height: 300 }, 900, 700)).toEqual({ x: 12, y: 12 })
    expect(workflowPage.clampWorkflowOutputWindowPosition({ x: 800, y: 650 }, { width: 400, height: 300 }, 900, 700)).toEqual({ x: 488, y: 388 })

    const start = { edge: 'left' as const, startX: 100, startY: 100, startLeft: 200, startTop: 80, startWidth: 420, startHeight: 300 }
    expect(workflowPage.resizeWorkflowOutputWindow(start, 400, 100, 900, 700)).toEqual({ position: { x: 300, y: 80 }, size: { width: 320, height: 300 } })

    const right = { ...start, edge: 'right' as const }
    expect(workflowPage.resizeWorkflowOutputWindow(right, 900, 100, 900, 700)).toEqual({ position: { x: 200, y: 80 }, size: { width: 688, height: 300 } })

    const top = { ...start, edge: 'top' as const }
    expect(workflowPage.resizeWorkflowOutputWindow(top, 100, 500, 900, 700)).toEqual({ position: { x: 200, y: 140 }, size: { width: 420, height: 240 } })

    const bottom = { ...start, edge: 'bottom' as const }
    expect(workflowPage.resizeWorkflowOutputWindow(bottom, 100, 900, 900, 700)).toEqual({ position: { x: 200, y: 80 }, size: { width: 420, height: 608 } })
  })

  it('summarizes run history and identifies the first unviewed record', () => {
    const runs: WorkflowRunRecord[] = [
      { id: 'run-new', workflowId: 'workflow-1', workflowRevision: 1, status: 'completed', input: {}, output: 'new', nodeStates: [], events: [], allowShellFile: false },
      { id: 'run-old', workflowId: 'workflow-1', workflowRevision: 1, status: 'failed', input: {}, nodeStates: [], events: [], allowShellFile: false },
    ]

    expect(workflowPage.summarizeWorkflowRuns(runs, new Set(['run-old']))).toEqual({ count: 2, unviewedCount: 1, firstUnviewedRun: runs[0] })
    expect(workflowPage.summarizeWorkflowRuns(runs, new Set(['run-new', 'run-old']))).toEqual({ count: 2, unviewedCount: 0 })
  })

  it('only allows an explicit action on the visible execution page to mark a finished run viewed', () => {
    const completed: WorkflowRunRecord = { id: 'run-viewed', workflowId: 'workflow-1', workflowRevision: 1, status: 'completed', input: {}, nodeStates: [], events: [], allowShellFile: false }

    expect(workflowPage.workflowRunShouldBeMarkedViewed(completed, { pageActive: true, workspaceView: 'executions', userAction: true })).toBe(true)
    expect(workflowPage.workflowRunShouldBeMarkedViewed(completed, { pageActive: false, workspaceView: 'executions', userAction: true })).toBe(false)
    expect(workflowPage.workflowRunShouldBeMarkedViewed(completed, { pageActive: true, workspaceView: 'editor', userAction: true })).toBe(false)
    expect(workflowPage.workflowRunShouldBeMarkedViewed(completed, { pageActive: true, workspaceView: 'executions', userAction: false })).toBe(false)
    expect(workflowPage.workflowRunShouldBeMarkedViewed({ ...completed, status: 'running' }, { pageActive: true, workspaceView: 'executions', userAction: true })).toBe(false)
  })

  it('exposes run history actions and keeps active records protected from deletion', () => {
    const workflow = createDefaultWorkflow('Run actions')
    const run: WorkflowRunRecord = { id: 'run-actions', workflowId: workflow.id, workflowRevision: workflow.revision, status: 'completed', input: {}, nodeStates: [], events: [], allowShellFile: false }
    const markup = renderToStaticMarkup(<workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} onMarkUnread={vi.fn()} onDelete={vi.fn()} canMarkUnread canDelete />)

    expect(markup).toContain('aria-label="标记未读"')
    expect(markup).toContain('title="标记未读"')
    expect(markup).toContain('aria-label="删除记录"')
    expect(markup).toContain('title="删除记录"')
    expect(workflowPage.workflowRunCanDelete('completed')).toBe(true)
    expect(workflowPage.workflowRunCanDelete('running')).toBe(false)
    expect(workflowPage.workflowRunCanDelete('waiting-approval')).toBe(false)
  })

  it('auto-detects structured JSON strings while keeping ordinary text as Markdown', () => {
    expect(workflowPage.detectWorkflowOutputView({ title: '研究报告', items: ['一', '二'] })).toBe('json')
    expect(workflowPage.detectWorkflowOutputView('{"title":"研究报告","items":["一","二"]}')).toBe('json')
    expect(workflowPage.detectWorkflowOutputView('# 研究报告\n\n这是一段普通文本。')).toBe('markdown')
    expect(workflowPage.detectWorkflowOutputView('{这不是 JSON}')).toBe('markdown')
  })

  it('renders readable Markdown and JSON output views with explicit toggles', () => {
    const markdownMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputViewer copy={getAppCopy('zh')} value={'# 研究报告\n\n- 第一项\n- 第二项\n\n**结论**'} />,
    )
    expect(markdownMarkup).toContain('workflow-output-viewer')
    expect(markdownMarkup).toContain('Markdown')
    expect(markdownMarkup).toContain('JSON')
    expect(markdownMarkup).toContain('<h1>研究报告</h1>')
    expect(markdownMarkup).toContain('<li>第一项</li>')
    expect(markdownMarkup).toContain('<strong>结论</strong>')

    const jsonMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputViewer copy={getAppCopy('zh')} value={'{"title":"研究报告","items":["一","二"]}'} />,
    )
    expect(jsonMarkup).toContain('workflow-output-json')
    expect(jsonMarkup).toContain('workflow-json-tree')
    expect(jsonMarkup).toContain('title')
    expect(jsonMarkup).toContain('items')
    expect(jsonMarkup).toContain('<details')
    expect(jsonMarkup).toContain('全部展开')
    expect(jsonMarkup).toContain('全部收起')

    const collapsedTree = renderToStaticMarkup(<workflowPage.WorkflowJsonTree value={{ outer: { inner: 'value' } }} />)
    const expandedTree = renderToStaticMarkup(<workflowPage.WorkflowJsonTree value={{ outer: { inner: 'value' } }} expandAll />)
    expect((collapsedTree.match(/<details/g) ?? []).length).toBe(2)
    expect((collapsedTree.match(/<details[^>]*open(?:="")?/gu) ?? []).length).toBe(1)
    expect((expandedTree.match(/<details[^>]*open(?:="")?/gu) ?? []).length).toBe(2)
  })

  it('preserves real and escaped line breaks in Markdown output', () => {
    const escaped = renderToStaticMarkup(<workflowPage.WorkflowOutputViewer copy={getAppCopy('zh')} value={'第一行\\n第二行'} />)
    const actual = renderToStaticMarkup(<workflowPage.WorkflowOutputViewer copy={getAppCopy('zh')} value={'第一行\n第二行'} />)
    expect(escaped).toContain('<br')
    expect(actual).toContain('<br')
  })

  it('renders Markdown tables in normal and floating result viewers', () => {
    const table = '| 节点 | 耗时 |\n| --- | ---: |\n| 调研 | 1.2 秒 |\n| 审核 | 2.4 秒 |'
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputViewer copy={getAppCopy('zh')} value={table} />,
    )
    const floatingMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputFloatingWindows copy={getAppCopy('zh')} windows={[{ id: 'table', title: '表格结果', value: table }]} fontScale={1} onClose={vi.fn()} onCopy={vi.fn()} onIncreaseFont={vi.fn()} onDecreaseFont={vi.fn()} />,
    )

    expect(markup).toContain('<table')
    expect(markup).toContain('<th>节点</th>')
    expect(markup).toContain('<td>2.4 秒</td>')
    expect(floatingMarkup).toContain('<table')
  })

  it('formats node execution time with millisecond precision and zero for legacy records', () => {
    expect(workflowPage.formatWorkflowNodeDuration()).toBe('0.0秒')
    expect(workflowPage.formatWorkflowNodeDuration(1_234)).toBe('1.2秒')
    expect(workflowPage.formatWorkflowNodeDuration(61_234)).toBe('1分1.2秒')
    expect(workflowPage.formatWorkflowNodeDuration(3_661_234)).toBe('1时1分1.2秒')
  })

  it('renders draggable result windows and a compact execution heading', () => {
    const workflow = createDefaultWorkflow('Compact execution')
    const run: WorkflowRunRecord = {
      id: 'run-compact-heading',
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'completed',
      input: {},
      output: 'done',
      nodeStates: [],
      events: [],
      allowShellFile: false,
      startedAt: '2026-08-30T12:47:45.232Z',
    }
    const reviewMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )
    const windowsMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputFloatingWindows copy={getAppCopy('zh')} windows={[{ id: 'final', title: '最终结果', value: { ok: true } }]} fontScale={1} onClose={vi.fn()} onCopy={vi.fn()} onIncreaseFont={vi.fn()} onDecreaseFont={vi.fn()} />,
    )

    expect(reviewMarkup).toContain('workflow-execution-compact-heading')
    expect(reviewMarkup).toContain('run-compact-heading')
    expect(reviewMarkup).not.toContain('2026-08-30T12:47:45.232Z')
    expect(windowsMarkup).toContain('workflow-output-window-resize-top')
    expect(windowsMarkup).toContain('workflow-output-window-resize-right')
    expect(windowsMarkup).toContain('workflow-output-window-resize-bottom')
    expect(windowsMarkup).toContain('workflow-output-window-resize-left')
    expect(windowsMarkup).toContain('workflow-output-window-drag-handle')
  })

  it('keeps result window coordinates stable and raises the most recently focused window', () => {
    const first = workflowPage.createWorkflowOutputWindowState('first', '第一个', 'first', 0)
    const second = workflowPage.createWorkflowOutputWindowState('second', '第二个', 'second', 1)
    const focused = workflowPage.focusWorkflowOutputWindow([first, second], 'first')

    expect(first.position).toEqual({ x: 18, y: 96 })
    expect(second.position.x).toBeGreaterThan(first.position.x)
    expect(focused.find((window) => window.id === 'first')?.zIndex).toBeGreaterThan(focused.find((window) => window.id === 'second')?.zIndex ?? 0)
  })

  it('opens a new result window above every previously focused window', () => {
    const first = workflowPage.createWorkflowOutputWindowState('first', '第一个', 'first', 0)
    const second = workflowPage.createWorkflowOutputWindowState('second', '第二个', 'second', 1)
    const previouslyFocused = workflowPage.focusWorkflowOutputWindow([first, second], 'first')

    const opened = workflowPage.openWorkflowOutputWindow(previouslyFocused, 'third', '第三个', 'third')

    expect(opened.find((window) => window.id === 'third')?.zIndex).toBeGreaterThan(Math.max(...previouslyFocused.map((window) => window.zIndex ?? 0)))
  })

  it('uses status-specific colors in the minimap and provides a map toggle component', () => {
    expect(workflowPage.workflowMiniMapNodeColor('completed')).toBe('#1f8a5c')
    expect(workflowPage.workflowMiniMapNodeColor('failed')).toBe('#c2453a')
    expect(workflowPage.workflowMiniMapNodeColor('pending')).toBe('#9ca3af')
    expect(workflowPage.WorkflowCanvasTools).toBeTypeOf('function')

    const markup = renderToStaticMarkup(
      <ReactFlow nodes={[]} edges={[]}>
        <workflowPage.WorkflowCanvasTools copy={getAppCopy('zh')} showMiniMap onToggleMiniMap={vi.fn()} />
      </ReactFlow>,
    )
    expect(markup).toContain('workflow-minimap-control-button')
    expect(markup).not.toContain('workflow-minimap-toggle')
  })

  it('renders launch setup separately while run history remains read-only', () => {
    const workflow = createDefaultWorkflow('Run setup')
    const fields = workflowPage.getWorkflowLaunchFields(workflow)
    const launchMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowRunLaunchDialog
        copy={getAppCopy('zh')}
        fields={fields}
        values={{ task: '' }}
        modelOptions={[{ providerId: 'deepseek-official', providerName: 'DeepSeek', modelId: 'deepseek-chat', modelName: 'DeepSeek Chat' }]}
        modelSelection={undefined}
        allowShellFile={false}
        allowCode={false}
        debug={false}
        busy={false}
        modelLoading={false}
        onChangeValue={vi.fn()}
        onChangeModel={vi.fn()}
        onRefreshModels={vi.fn()}
        onChangeAllowShellFile={vi.fn()}
        onChangeAllowCode={vi.fn()}
        onChangeDebug={vi.fn()}
        onClose={vi.fn()}
        onStart={vi.fn()}
      />,
    )
    const historyMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={undefined} statusLabel={() => ''} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )

    expect(launchMarkup).toContain('配置运行')
    expect(launchMarkup).toContain('开始运行')
    expect(launchMarkup).toContain('使用默认模型')
    expect(launchMarkup).toContain('DeepSeek Chat')
    expect(launchMarkup).toContain('刷新模型')
    expect(launchMarkup).toContain('workflow-launch-note')
    expect(launchMarkup).toContain('允许 Shell / 文件节点')
    expect(historyMarkup).not.toContain('运行输入')
    expect(historyMarkup).not.toContain('允许 Shell / 文件节点')
    expect(historyMarkup).not.toContain('调试运行')
  })

  it('offers variable or custom text content for the fixed end node', () => {
    const workflow = createDefaultWorkflow('End output settings')
    const end = workflow.nodes.find((node) => node.type === 'output')!
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputNodeSettings workflow={workflow} node={end} onChange={vi.fn()} />,
    )
    const textMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputNodeSettings workflow={workflow} node={{ ...end, config: { contentMode: 'text', text: '结果：{{result}}' } }} onChange={vi.fn()} />,
    )

    expect(markup).toContain('输出内容来源')
    expect(markup).toContain('变量')
    expect(markup).toContain('自定义文本')
    expect(markup).toContain('如需再次处理')
    expect(markup).toContain('输入变量')
    expect(textMarkup).toContain('插入变量')
    expect(markup).not.toContain('添加输出变量')
    expect(markup.indexOf('输入变量')).toBeLessThan(markup.indexOf('输出内容来源'))
  })

  it('uses a stable row key while an output variable name is edited', () => {
    const rowKey = (workflowPage as unknown as { workflowOutputVariableRowKey?: (index: number) => string }).workflowOutputVariableRowKey

    expect(rowKey?.(0)).toBe('output-variable-0')
    expect(rowKey?.(1)).toBe('output-variable-1')
  })

  it('offers employees and lightweight AI processing without the retired content template entry point', () => {
    const markup = renderToStaticMarkup(<workflowPage.WorkflowPage copy={getAppCopy('zh')} locale="zh" developerMode />)

    expect(markup).toContain('workflow-page-browser')
    expect(markup).toContain('workflow-browser-content')
    expect(markup).toContain('workflow-employee-select')
    expect(markup).toContain('智能处理')
    expect(markup).toContain('专业员工')
    expect(markup).toContain('导入')
    expect(markup).toContain('从剪贴板导入')
    expect(markup).toContain('workflow-import-split')
    expect(markup).not.toContain('导入 JSON')
    expect(markup).not.toContain('短视频内容运营')
    expect(markup).not.toContain('Employee ID')
    expect(markup).not.toContain('Agent')
  })

  it('migrates legacy Agent wording before a workflow enters the editor', () => {
    expect(workflowPage.userFacingWorkflowText('交给 DSH Agent 处理', 'zh')).toContain('智能处理')
    expect(workflowPage.userFacingWorkflowText('交给 DSH Agent 处理', 'zh')).not.toContain('Agent')
    expect(workflowPage.userFacingWorkflowText('Use an Agent', 'en')).toBe('Use an AI Processing')
  })

  it('keeps the workflow browser separate from the full workspace shell', () => {
    const markup = renderToStaticMarkup(<workflowPage.WorkflowPage copy={getAppCopy('zh')} locale="zh" />)

    expect(markup).not.toContain('workflow-layout')
    expect(markup).not.toContain('workflow-inspector')
    expect(markup).toContain('选择一个工作流开始')
  })

  it('renders a dismiss action for workflow status messages', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowToast message="工作流已保存" copy={getAppCopy('zh')} onDismiss={vi.fn()} />,
    )

    expect(markup).toContain('工作流已保存')
    expect(markup).toContain('关闭提示')
  })

  it('renders a dismiss action for workflow errors', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowErrorBanner message="保存失败" copy={getAppCopy('zh')} onDismiss={vi.fn()} />,
    )

    expect(markup).toContain('保存失败')
    expect(markup).toContain('关闭提示')
  })

  it('keeps editor history keyboard-only and uses a green save action', () => {
    const draftMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowEditorActions copy={getAppCopy('zh')} draft busy={false} runDisabled={false} runLabel="运行" onCancel={vi.fn()} onSave={vi.fn()} onExport={vi.fn()} onRun={vi.fn()} />,
    )
    const editMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowEditorActions copy={getAppCopy('zh')} draft={false} busy={false} runDisabled={false} runLabel="运行" onCancel={vi.fn()} onSave={vi.fn()} onExport={vi.fn()} onRun={vi.fn()} />,
    )

    expect(draftMarkup).not.toContain('撤销')
    expect(draftMarkup).not.toContain('重做')
    expect(draftMarkup).toContain('保存')
    expect(draftMarkup).toContain('workflow-save-button')
    expect(editMarkup).toContain('取消编辑')
    expect(editMarkup).toContain('导出')
    expect(editMarkup).toContain('到文件')
    expect(editMarkup).toContain('到剪贴板')
    expect(editMarkup).toContain('workflow-export-menu')
    expect(editMarkup).not.toContain('导出 JSON')
    expect(editMarkup.indexOf('导出')).toBeLessThan(editMarkup.indexOf('保存'))
  })

  it('renders common actions in the workflow canvas context menu', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowContextMenu
        copy={getAppCopy('zh')}
        target="node"
        x={24}
        y={36}
        canUndo
        canRedo
        busy={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onDelete={vi.fn()}
        onFitView={vi.fn()}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(markup).toContain('role="menu"')
    expect(markup).toContain('撤销')
    expect(markup).toContain('重做')
    expect(markup).toContain('删除节点')
    expect(markup).toContain('适配画布')
    expect(markup).toContain('保存')
    expect(markup).toContain('⌘S')
    expect(markup).toContain('运行')
  })

  it('renders alignment actions only for a multi-node context menu', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowContextMenu
        copy={getAppCopy('zh')}
        target="node"
        x={24}
        y={36}
        selectedNodeCount={3}
        canUndo={false}
        canRedo={false}
        busy={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onDelete={vi.fn()}
        onAlign={vi.fn()}
        onFitView={vi.fn()}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(markup).toContain('左对齐')
    expect(markup).toContain('水平居中')
    expect(markup).toContain('右对齐')
    expect(markup).toContain('顶端对齐')
    expect(markup).toContain('垂直居中')
    expect(markup).toContain('底端对齐')
    expect(markup).toContain('水平平均排布')
    expect(markup).toContain('垂直平均排布')
  })

  it('renders selection actions for the multi-node selection context menu', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowContextMenu
        copy={getAppCopy('zh')}
        target="selection"
        x={24}
        y={36}
        selectedNodeCount={3}
        canUndo={false}
        canRedo={false}
        busy={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onDelete={vi.fn()}
        onAlign={vi.fn()}
        onFitView={vi.fn()}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(markup).toContain('删除选中内容')
    expect(markup).toContain('左对齐')
    expect(markup).toContain('底端对齐')
  })

  it('keeps the context menu inside the viewport when opened near an edge', () => {
    expect(workflowPage.clampWorkflowContextMenuPosition(980, 860, 260, 340, 1024, 900)).toEqual({ left: 756, top: 552 })
    expect(workflowPage.clampWorkflowContextMenuPosition(2, 3, 260, 340, 1024, 900)).toEqual({ left: 8, top: 8 })
  })

  it('offers an undo action for a recently deleted workflow toast', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowToast message="工作流已删除" actionLabel="撤销删除" copy={getAppCopy('zh')} onAction={vi.fn()} onDismiss={vi.fn()} />,
    )

    expect(markup).toContain('撤销删除')
  })

  it('shows effect reconciliation only for an unknown ordinary node effect', () => {
    const workflow = createDefaultWorkflow('Effect review')
    const node = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const run: WorkflowRunRecord = {
      id: 'run-unknown-effect',
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'paused',
      input: { task: 'send a receipt' },
      nodeStates: [
        { nodeId: node.id, status: 'cancelled', effectState: 'unknown', input: { recipient: 'Ada', receipt: 'R-42' } },
        { nodeId: workflow.nodes.find((candidate) => candidate.type === 'output')!.id, status: 'cancelled', effectState: 'dispatched' },
      ],
      effectReconciliationTargets: [{ key: 'run-unknown-effect:ordinary', nodeId: node.id, nodeLabel: node.label, input: { recipient: 'Ada', receipt: 'R-42' } }],
      events: [],
      allowShellFile: false,
    }

    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} workflow={workflow} run={run} statusLabel={() => '已暂停'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )

    expect(markup).toContain('副作用人工核对')
    expect(markup).toContain(node.label)
    expect(markup).toContain('R-42')
    expect(markup).toContain('确认未发送并重试')
    expect(markup).toContain('确认已经发送')
    expect(markup).not.toContain('effectState')
  })

  it('keeps an unknown loop effect bound to its saved iteration input', () => {
    const workflow = createDefaultWorkflow('Loop effect review')
    const loop = { ...workflow.nodes.find((candidate) => candidate.type === 'ai-task')!, type: 'loop', label: '逐项发送', config: { maxIterations: 3 } } as never
    const body = workflow.nodes.find((candidate) => candidate.type === 'output')!
    const definition = { ...workflow, nodes: workflow.nodes.map((node) => node.id === loop.id ? loop : node) }
    const run: WorkflowRunRecord = {
      id: 'run-loop-unknown-effect', workflowId: definition.id, workflowRevision: definition.revision, status: 'paused', input: {}, events: [], allowShellFile: false,
      nodeStates: [{ nodeId: loop.id, status: 'cancelled', loopIterations: [{ iterationId: 'iteration-7', iterationIndex: 7, input: { recipient: 'Grace' }, status: 'running', nodeStates: [{ nodeId: body.id, status: 'cancelled', effectState: 'unknown', input: { recipient: 'Grace', receipt: 'R-7' } }] }] }],
      effectReconciliationTargets: [{ key: `run-loop-unknown-effect:iteration-7:${body.id}:0:0:no-effect-event`, nodeId: body.id, nodeLabel: body.label, iterationId: 'iteration-7', iterationIndex: 7, loopNodeLabel: '逐项发送', input: { recipient: 'Grace', receipt: 'R-7' } }],
    }

    expect(workflowPage.workflowUnknownEffectTargets(definition, run)).toEqual([{
      key: `run-loop-unknown-effect:iteration-7:${body.id}:0:0:no-effect-event`,
      nodeId: body.id,
      nodeLabel: body.label,
      iterationId: 'iteration-7',
      iterationIndex: 7,
      loopNodeLabel: '逐项发送',
      input: { recipient: 'Grace', receipt: 'R-7' },
    }])
  })

  it('does not expose an actionable node-effect fallback when Main omitted exact targets', () => {
    const workflow = createDefaultWorkflow('No fallback')
    const node = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const run: WorkflowRunRecord = { id: 'legacy-no-target', workflowId: workflow.id, workflowRevision: 1, status: 'paused', input: null, allowShellFile: false, events: [], nodeStates: [{ nodeId: node.id, status: 'pending', effectState: 'unknown' }] }
    expect(workflowPage.workflowUnknownEffectTargets(workflow, run)).toEqual([])
  })

  it('renders compensation review as a distinct surface with an exact occurrence identity', () => {
    const module = workflowPage as unknown as {
      workflowCompensationUnknownTargets?: (run: WorkflowRunRecord) => Array<{ key: string; occurrenceId: string; sourceNodeId: string }>
      WorkflowCompensationReconciliationPanel?: ComponentType<{ copy: ReturnType<typeof getAppCopy>; targets: Array<{ key: string; occurrenceId: string; sourceNodeId: string }>; onReconcile: (request: unknown) => void }>
    }
    expect(module.workflowCompensationUnknownTargets).toBeTypeOf('function')
    expect(module.WorkflowCompensationReconciliationPanel).toBeTypeOf('function')
    if (module.workflowCompensationUnknownTargets === undefined || module.WorkflowCompensationReconciliationPanel === undefined) return
    const run: WorkflowRunRecord = {
      id: 'comp-review', workflowId: 'workflow', workflowRevision: 1, status: 'failed', input: null, allowShellFile: false, nodeStates: [], events: [],
      compensationStack: [{ sourceNodeId: 'charge', action: { type: 'workflow', workflowId: 'refund' }, status: 'failed', effectState: 'unknown', occurrenceId: 'comp-review:compensation:charge:ordinary' }],
    }
    const Panel = module.WorkflowCompensationReconciliationPanel
    const markup = renderToStaticMarkup(<Panel copy={getAppCopy('zh')} targets={module.workflowCompensationUnknownTargets(run)} onReconcile={vi.fn()} />)
    expect(markup).toContain('补偿副作用人工核对')
    expect(markup).toContain('charge')
    expect(markup).toContain('comp-review:compensation:charge:ordinary')
    expect(markup).toContain('确认补偿未派发并重试')
    expect(markup).toContain('确认补偿已派发')
    expect(markup).not.toContain('确认未发送并重试')
  })

  it('sends the exact compensation occurrence through the WorkflowPage bridge', async () => {
    const reconcileCompensation = vi.fn(async () => {
      const { run } = workflowWithUnknownLoopEffect()
      run.effectReconciliationTargets = []
      run.compensationStack = [{ sourceNodeId: 'charge', action: { type: 'workflow', workflowId: 'refund' }, status: 'pending', effectState: 'none', occurrenceId: 'run-effect-acceptance:compensation:charge:ordinary' }]
      return run
    })
    const page = await mountWorkflowEffectReviewPage('zh', vi.fn(), reconcileCompensation, true)
    try {
      const textarea = page.domWindow.document.querySelector('textarea') as HTMLTextAreaElement
      await act(async () => { Simulate.change(textarea, { target: { value: '  provider confirms absent  ' } }) })
      const action = Array.from(page.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '确认补偿未派发并重试') as HTMLButtonElement
      await act(async () => { action.click(); await Promise.resolve() })
      expect(reconcileCompensation).toHaveBeenCalledWith(page.run.id, {
        occurrenceId: 'run-effect-acceptance:compensation:charge:ordinary', outcome: 'not-dispatched', note: 'provider confirms absent',
      })
      expect(page.compensate).toHaveBeenCalledWith(page.run.id)
    } finally { await page.cleanup() }
  })

  it('continues compensation after a dispatched decision when an earlier entry remains pending', async () => {
    const reconcileCompensation = vi.fn(async () => {
      const { run } = workflowWithUnknownLoopEffect()
      run.effectReconciliationTargets = []
      run.compensationStack = [
        { sourceNodeId: 'earlier', action: { type: 'workflow', workflowId: 'undo' }, status: 'pending', effectState: 'none', occurrenceId: 'earlier-occurrence' },
        { sourceNodeId: 'charge', action: { type: 'workflow', workflowId: 'refund' }, status: 'completed', effectState: 'confirmed', occurrenceId: 'run-effect-acceptance:compensation:charge:ordinary' },
      ]
      return run
    })
    const page = await mountWorkflowEffectReviewPage('zh', vi.fn(), reconcileCompensation, true)
    try {
      const textarea = page.domWindow.document.querySelector('textarea') as HTMLTextAreaElement
      await act(async () => { Simulate.change(textarea, { target: { value: 'provider receipt found' } }) })
      const dispatched = Array.from(page.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '确认补偿已派发') as HTMLButtonElement
      await act(async () => { dispatched.click() })
      const confirm = Array.from(page.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '我确认已经发送，继续') as HTMLButtonElement
      await act(async () => { confirm.click(); await Promise.resolve() })
      expect(page.compensate).toHaveBeenCalledWith(page.run.id)
    } finally { await page.cleanup() }
  })

  it('offers a durable continue-compensation action after automatic continuation fails and the run is reloaded', async () => {
    const pendingStack: NonNullable<WorkflowRunRecord['compensationStack']> = [
      { sourceNodeId: 'earlier', action: { type: 'workflow', workflowId: 'undo-earlier' }, status: 'pending', effectState: 'none', occurrenceId: 'earlier-occurrence' },
      { sourceNodeId: 'charge', action: { type: 'workflow', workflowId: 'refund' }, status: 'completed', effectState: 'confirmed', occurrenceId: 'run-effect-acceptance:compensation:charge:ordinary' },
    ]
    const reconcileCompensation = vi.fn(async () => {
      const { run } = workflowWithUnknownLoopEffect()
      run.effectReconciliationTargets = []
      run.compensationStack = pendingStack
      return run
    })
    const automaticFailure = vi.fn(async (): Promise<WorkflowRunRecord> => { throw new Error('process interrupted before compensation restart') })
    const first = await mountWorkflowEffectReviewPage('zh', vi.fn(), reconcileCompensation, true, { compensate: automaticFailure })
    try {
      const textarea = first.domWindow.document.querySelector('textarea') as HTMLTextAreaElement
      await act(async () => { Simulate.change(textarea, { target: { value: 'provider receipt found' } }) })
      const dispatched = Array.from(first.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '确认补偿已派发') as HTMLButtonElement
      await act(async () => { dispatched.click() })
      const confirm = Array.from(first.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '我确认已经发送，继续') as HTMLButtonElement
      await act(async () => { confirm.click(); await Promise.resolve() })
      expect(reconcileCompensation).toHaveBeenCalledOnce()
      expect(automaticFailure).toHaveBeenCalledWith(first.run.id)
    } finally { await first.cleanup() }

    const continued = vi.fn(async (runId: string) => ({ ...workflowWithUnknownLoopEffect().run, id: runId, compensationStack: pendingStack }))
    const reloaded = await mountWorkflowEffectReviewPage('zh', vi.fn(), undefined, true, { compensationStack: pendingStack, compensate: continued })
    try {
      const continueButton = Array.from(reloaded.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '继续补偿') as HTMLButtonElement | undefined
      expect(continueButton).toBeDefined()
      expect(Array.from(reloaded.domWindow.document.querySelectorAll('button')).some((button) => button.textContent === '恢复运行')).toBe(false)
      await act(async () => { continueButton!.click(); await Promise.resolve() })
      expect(continued).toHaveBeenCalledWith(reloaded.run.id)
    } finally { await reloaded.cleanup() }
  })

  it('requires a note and a second confirmation before reconciling a dispatched effect', async () => {
    const reconcile = vi.fn(async () => undefined)
    const previousGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      navigator: globalThis.navigator,
      HTMLElement: globalThis.HTMLElement,
      Node: globalThis.Node,
      Event: globalThis.Event,
      MouseEvent: globalThis.MouseEvent,
      KeyboardEvent: globalThis.KeyboardEvent,
      CustomEvent: globalThis.CustomEvent,
      getComputedStyle: globalThis.getComputedStyle,
    }
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, {
      window: domWindow,
      document: domWindow.document,
      HTMLElement: domWindow.HTMLElement,
      Node: domWindow.Node,
      Event: domWindow.Event,
      MouseEvent: domWindow.MouseEvent,
      KeyboardEvent: domWindow.KeyboardEvent,
      CustomEvent: domWindow.CustomEvent,
      getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
    })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })

    try {
      const root = createRoot(domWindow.document.getElementById('root')!)
      await act(async () => {
        root.render(<workflowPage.WorkflowEffectReconciliationPanel copy={getAppCopy('zh')} onReconcile={reconcile} targets={[{ key: 'iteration-2:write', nodeId: 'write', nodeLabel: '发送回执', iterationId: 'iteration-2', iterationIndex: 2, loopNodeLabel: '逐项发送', input: { receipt: 'R-2' } }]} />)
      })
      const textarea = domWindow.document.querySelector('textarea') as HTMLTextAreaElement
      const dispatched = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '确认已经发送') as HTMLButtonElement
      expect(dispatched.disabled).toBe(true)
      await act(async () => {
        Simulate.change(textarea, { target: { value: '  核对了发送日志  ' } })
      })
      expect(dispatched.disabled).toBe(false)
      await act(async () => { dispatched.click() })
      expect(reconcile).not.toHaveBeenCalled()
      const confirm = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '我确认已经发送，继续') as HTMLButtonElement
      await act(async () => { confirm.click(); await Promise.resolve() })
      expect(reconcile).toHaveBeenCalledWith({ nodeId: 'write', iterationId: 'iteration-2', outcome: 'dispatched', note: '核对了发送日志' })

      reconcile.mockClear()
      await act(async () => {
        root.render(<workflowPage.WorkflowCompensationReconciliationPanel copy={getAppCopy('zh')} onReconcile={reconcile} targets={[{ key: 'comp-occurrence', occurrenceId: 'comp-occurrence', sourceNodeId: 'write' }]} />)
      })
      const compensationNote = domWindow.document.querySelector('textarea') as HTMLTextAreaElement
      await act(async () => { Simulate.change(compensationNote, { target: { value: '  核对了补偿日志  ' } }) })
      const compensationDispatched = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '确认补偿已派发') as HTMLButtonElement
      await act(async () => { compensationDispatched.click() })
      expect(reconcile).not.toHaveBeenCalled()
      const compensationConfirm = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '我确认已经发送，继续') as HTMLButtonElement
      await act(async () => { compensationConfirm.click(); await Promise.resolve() })
      expect(reconcile).toHaveBeenCalledWith({ occurrenceId: 'comp-occurrence', outcome: 'dispatched', note: '核对了补偿日志' })
    } finally {
      const { navigator: previousNavigator, ...previousGlobalsWithoutNavigator } = previousGlobals
      Object.assign(globalThis, previousGlobalsWithoutNavigator)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
    }
  })

  it('preserves each Main-provided unknown-effect occurrence key', () => {
    const workflow = createDefaultWorkflow('Occurrence keys')
    const node = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const createRun = (id: string, attempt: number): WorkflowRunRecord => ({
      id, workflowId: workflow.id, workflowRevision: workflow.revision, status: 'paused', input: {}, events: [], allowShellFile: false,
      nodeStates: [{ nodeId: node.id, status: 'cancelled', effectState: 'unknown', attempt }],
      effectReconciliationTargets: [{ key: `${id}:${attempt}`, nodeId: node.id, nodeLabel: node.label }],
    })

    const runA = workflowPage.workflowUnknownEffectTargets(workflow, createRun('run-a', 1))[0]!
    const runB = workflowPage.workflowUnknownEffectTargets(workflow, createRun('run-b', 1))[0]!
    const retriedRunA = workflowPage.workflowUnknownEffectTargets(workflow, createRun('run-a', 2))[0]!

    expect(runA.key).not.toBe(runB.key)
    expect(runA.key).not.toBe(retriedRunA.key)
  })

  it('does not expose a top-level loop-body projection as a reconciliation target', () => {
    const workflow = createDefaultWorkflow('Loop projection')
    const originalLoop = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const loop = { ...originalLoop, type: 'loop', label: '逐项发送', config: { maxIterations: 3 } } as never
    const body = workflow.nodes.find((candidate) => candidate.type === 'output')!
    const definition = {
      ...workflow,
      nodes: workflow.nodes.map((node) => node.id === originalLoop.id ? loop : node),
      edges: [{ id: 'loop-body', source: loop.id, target: body.id, sourcePort: 'loop-body' }],
    }
    const run: WorkflowRunRecord = {
      id: 'run-loop-projection', workflowId: definition.id, workflowRevision: definition.revision, status: 'paused', input: {}, events: [], allowShellFile: false,
      nodeStates: [
        { nodeId: body.id, status: 'cancelled', effectState: 'unknown', input: 'projection only' },
        { nodeId: loop.id, status: 'cancelled', loopIterations: [{ iterationId: 'iteration-1', iterationIndex: 1, input: 'durable input', status: 'running', nodeStates: [{ nodeId: body.id, status: 'cancelled', effectState: 'unknown', input: 'durable state' }] }] },
      ],
      effectReconciliationTargets: [{ key: 'nested', nodeId: body.id, nodeLabel: body.label, iterationId: 'iteration-1', iterationIndex: 1, loopNodeLabel: '逐项发送', input: 'durable state' }],
    }

    expect(workflowPage.workflowUnknownEffectTargets(definition, run)).toMatchObject([{ nodeId: body.id, iterationId: 'iteration-1', input: 'durable state' }])
    expect(workflowPage.workflowUnknownEffectTargets(definition, run)).toHaveLength(1)
  })

  it('uses persisted Main reconciliation targets when an ordinary node became a loop body later', () => {
    const workflow = createDefaultWorkflow('Historical ordinary effect')
    const originalLoop = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const loop = { ...originalLoop, type: 'loop', label: 'Current loop', config: { maxIterations: 3 } } as never
    const body = workflow.nodes.find((candidate) => candidate.type === 'output')!
    const current = {
      ...workflow,
      nodes: workflow.nodes.map((node) => node.id === originalLoop.id ? loop : node),
      edges: [{ id: 'loop-body', source: loop.id, target: body.id, sourcePort: 'loop-body' as const }],
    }
    const run = {
      id: 'run-historical-ordinary', workflowId: workflow.id, workflowRevision: 1, status: 'paused' as const,
      input: null, allowShellFile: false, events: [],
      nodeStates: [{ nodeId: body.id, status: 'cancelled' as const, effectState: 'unknown' as const, input: 'ordinary-input' }],
      effectReconciliationTargets: [{ key: 'ordinary-key', nodeId: body.id, nodeLabel: 'Historical ordinary write', input: 'ordinary-input' }],
    } as WorkflowRunRecord

    expect(workflowPage.workflowUnknownEffectTargets(current, run)).toEqual([
      { key: 'ordinary-key', nodeId: body.id, nodeLabel: 'Historical ordinary write', input: 'ordinary-input' },
    ])
    expect(workflowPage.workflowUnknownEffectTargets(undefined, run)).toEqual(run.effectReconciliationTargets)
  })

  it('uses persisted Main reconciliation targets when a loop body became ordinary later', () => {
    const current = createDefaultWorkflow('Historical loop effect')
    const body = current.nodes.find((candidate) => candidate.type === 'output')!
    const run = {
      id: 'run-historical-loop', workflowId: current.id, workflowRevision: 1, status: 'paused' as const,
      input: null, allowShellFile: false, events: [], nodeStates: [],
      effectReconciliationTargets: [{
        key: 'loop-key', nodeId: body.id, nodeLabel: 'Historical loop write', iterationId: 'iteration-4',
        iterationIndex: 4, loopNodeLabel: 'Historical loop', input: 'loop-input',
      }],
    } as WorkflowRunRecord

    expect(workflowPage.workflowUnknownEffectTargets(current, run)).toEqual([{
      key: 'loop-key', nodeId: body.id, nodeLabel: 'Historical loop write', iterationId: 'iteration-4',
      iterationIndex: 4, loopNodeLabel: 'Historical loop', input: 'loop-input',
    }])
  })

  it('keeps the selected run when an earlier reconciliation response resolves', async () => {
    let resolveRecord: ((record: WorkflowRunRecord) => void) | undefined
    const request = new Promise<WorkflowRunRecord>((resolve) => { resolveRecord = resolve })
    let selectedRunId = 'run-a'
    const applied: Array<{ record: WorkflowRunRecord; replaceDetail: boolean }> = []
    const reconcile = (workflowPage as unknown as { reconcileWorkflowEffectRequest?: (runId: string, request: { nodeId: string; outcome: 'not-dispatched'; note: string }, bridge: () => Promise<WorkflowRunRecord>, selectedRunId: () => string | undefined, apply: (record: WorkflowRunRecord, replaceDetail: boolean) => void) => Promise<void> }).reconcileWorkflowEffectRequest
    expect(reconcile).toBeTypeOf('function')
    if (reconcile === undefined) return

    const pending = reconcile('run-a', { nodeId: 'write', outcome: 'not-dispatched', note: 'checked' }, () => request, () => selectedRunId, (record, replaceDetail) => applied.push({ record, replaceDetail }))
    selectedRunId = 'run-b'
    const reconciled = { id: 'run-a', workflowId: 'workflow', workflowRevision: 1, status: 'paused' as const, input: {}, nodeStates: [], events: [], allowShellFile: false }
    resolveRecord?.(reconciled)
    await pending

    expect(applied).toEqual([{ record: reconciled, replaceDetail: false }])
  })

  it.each([
    { name: 'cancel', status: 'running' as const, actionLabel: getAppCopy('zh').workflowCancel, bridgeKey: 'cancel' as const, resultStatus: 'cancelled' as const, resultLabel: getAppCopy('zh').workflowRunCancelled, approved: undefined },
    { name: 'resume', status: 'paused' as const, actionLabel: getAppCopy('zh').workflowResume, bridgeKey: 'resume' as const, resultStatus: 'queued' as const, resultLabel: getAppCopy('zh').workflowNodePending, approved: undefined },
    { name: 'approve', status: 'waiting-approval' as const, actionLabel: getAppCopy('zh').workflowApprove, bridgeKey: 'approve' as const, resultStatus: 'queued' as const, resultLabel: getAppCopy('zh').workflowNodePending, approved: true },
    { name: 'reject', status: 'waiting-approval' as const, actionLabel: getAppCopy('zh').workflowReject, bridgeKey: 'approve' as const, resultStatus: 'failed' as const, resultLabel: getAppCopy('zh').workflowRunFailed, approved: false },
    { name: 'compensation', status: 'failed' as const, actionLabel: getAppCopy('zh').workflowContinueCompensation, bridgeKey: 'compensate' as const, resultStatus: 'failed' as const, resultLabel: getAppCopy('zh').workflowRunFailed, approved: undefined },
  ])('keeps run B selected when a pending $name response for run A resolves', async ({ status, actionLabel, bridgeKey, resultStatus, resultLabel, approved }) => {
    const workflow = createDefaultWorkflow(`异步动作所有权-${bridgeKey}`)
    const compensationStack: WorkflowRunRecord['compensationStack'] = bridgeKey === 'compensate'
      ? [{ sourceNodeId: 'write', action: { type: 'workflow', workflowId: 'rollback' }, status: 'pending', effectState: 'not-dispatched' }]
      : undefined
    const runA: WorkflowRunRecord = {
      id: `run-action-a-${bridgeKey}`,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status,
      input: {},
      allowShellFile: false,
      nodeStates: [],
      events: [],
      ...(compensationStack === undefined ? {} : { compensationStack }),
    }
    const runB: WorkflowRunRecord = {
      id: `run-action-b-${bridgeKey}`,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'completed',
      input: {},
      output: `run B ${bridgeKey}`,
      allowShellFile: false,
      nodeStates: [],
      events: [],
    }
    const updatedRunA: WorkflowRunRecord = {
      ...runA,
      status: resultStatus,
      events: [...runA.events, { id: `action-result-${bridgeKey}`, time: '2026-09-12T08:00:00.000Z', type: resultStatus === 'cancelled' ? 'run-cancelled' : resultStatus === 'queued' ? 'run-created' : 'run-failed' }],
    }
    let resolveAction!: (record: WorkflowRunRecord) => void
    const actionResult = new Promise<WorkflowRunRecord>((resolve) => { resolveAction = resolve })
    const action = vi.fn(() => actionResult)
    const getRunDefinition = vi.fn(async () => workflow)
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [workflow]),
      listRuns: vi.fn(async () => [runA, runB]),
      getRunDefinition,
      [bridgeKey]: action,
      onStateChange: vi.fn(() => () => {}),
      listModificationHistory: vi.fn(async () => []),
      onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement).click(); await mounted.settle() })
      const executions = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { executions.click(); await Promise.resolve() })
      const runAButton = Array.from(mounted.domWindow.document.querySelectorAll('.workflow-run-item-main')).find((button) => button.textContent?.includes(runA.id.slice(-12))) as HTMLButtonElement
      await act(async () => { runAButton.click(); await mounted.settle() })
      const actionButton = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === actionLabel) as HTMLButtonElement
      await act(async () => { actionButton.click(); await Promise.resolve() })
      if (bridgeKey === 'approve') expect(action).toHaveBeenCalledWith(runA.id, approved)
      else expect(action).toHaveBeenCalledWith(runA.id)

      const runBButton = Array.from(mounted.domWindow.document.querySelectorAll('.workflow-run-item-main')).find((button) => button.textContent?.includes(runB.id.slice(-12))) as HTMLButtonElement
      await act(async () => { runBButton.click(); await mounted.settle() })
      await act(async () => { resolveAction(updatedRunA); await actionResult; await mounted.settle() })

      expect(mounted.domWindow.document.querySelector('.workflow-execution-run-identity')?.textContent).toContain(runB.id)
      expect(mounted.domWindow.document.querySelector('.workflow-run-item-active')?.textContent).toContain(runB.id.slice(-12))
      const updatedRunAItem = Array.from(mounted.domWindow.document.querySelectorAll('.workflow-run-item')).find((item) => item.textContent?.includes(runA.id.slice(-12)))
      expect(updatedRunAItem?.querySelector('strong')?.textContent).toBe(resultLabel)
      expect(getRunDefinition.mock.calls.map(([runId]) => runId)).toEqual([runA.id, runB.id])
    } finally {
      resolveAction(updatedRunA)
      await mounted.cleanup()
    }
  })

  it('does not attach a late run A action error to the newly selected run B', async () => {
    const workflow = createDefaultWorkflow('异步动作错误所有权')
    const runA: WorkflowRunRecord = { id: 'run-late-error-a', workflowId: workflow.id, workflowRevision: workflow.revision, status: 'running', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    const runB: WorkflowRunRecord = { id: 'run-late-error-b', workflowId: workflow.id, workflowRevision: workflow.revision, status: 'completed', input: {}, output: 'run B remains selected', allowShellFile: false, nodeStates: [], events: [] }
    let rejectCancel!: (reason: Error) => void
    const cancelResult = new Promise<WorkflowRunRecord>((_resolve, reject) => { rejectCancel = reject })
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [workflow]),
      listRuns: vi.fn(async () => [runA, runB]),
      getRunDefinition: vi.fn(async () => workflow),
      cancel: vi.fn(() => cancelResult),
      onStateChange: vi.fn(() => () => {}),
      listModificationHistory: vi.fn(async () => []),
      onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement).click(); await mounted.settle() })
      const executions = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { executions.click(); await Promise.resolve() })
      const runButton = (runId: string): HTMLButtonElement => Array.from(mounted.domWindow.document.querySelectorAll('.workflow-run-item-main')).find((button) => button.textContent?.includes(runId.slice(-12))) as HTMLButtonElement
      await act(async () => { runButton(runA.id).click(); await mounted.settle() })
      const cancelButton = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowCancel) as HTMLButtonElement
      await act(async () => { cancelButton.click(); await Promise.resolve() })
      await act(async () => { runButton(runB.id).click(); await mounted.settle() })
      await act(async () => { rejectCancel(new Error('late run A failure')); await mounted.settle() })

      expect(mounted.domWindow.document.querySelector('.workflow-execution-run-identity')?.textContent).toContain(runB.id)
      expect(mounted.domWindow.document.body.textContent).not.toContain('late run A failure')
    } finally {
      rejectCancel(new Error('cleanup'))
      await mounted.cleanup()
    }
  })

  it('keeps a fresher live terminal run when an older action response arrives', async () => {
    const workflow = createDefaultWorkflow('异步动作新鲜度')
    const startedEvent = { id: 'fresh-action-started', time: '2026-09-12T08:00:00.000Z', type: 'run-started' as const }
    const run: WorkflowRunRecord = { id: 'run-action-freshness', workflowId: workflow.id, workflowRevision: workflow.revision, status: 'running', input: {}, allowShellFile: false, nodeStates: [], events: [startedEvent] }
    const liveCompleted: WorkflowRunRecord = { ...run, status: 'completed', output: 'fresh live output', completedAt: '2026-09-12T08:01:00.000Z', events: [...run.events, { id: 'fresh-action-completed', time: '2026-09-12T08:01:00.000Z', type: 'run-completed' }] }
    const staleActionResponse: WorkflowRunRecord = { ...run, status: 'queued' }
    let emitRunState!: (record: WorkflowRunRecord) => void
    let resolveCancel!: (record: WorkflowRunRecord) => void
    const cancelResult = new Promise<WorkflowRunRecord>((resolve) => { resolveCancel = resolve })
    const getRunDefinition = vi.fn(async () => workflow)
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [workflow]),
      listRuns: vi.fn(async () => [run]),
      getRunDefinition,
      cancel: vi.fn(() => cancelResult),
      onStateChange: vi.fn((listener: (record: WorkflowRunRecord) => void) => { emitRunState = listener; return () => {} }),
      listModificationHistory: vi.fn(async () => []),
      onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement).click(); await mounted.settle() })
      const executions = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { executions.click(); await Promise.resolve() })
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-run-item-main') as HTMLButtonElement).click(); await mounted.settle() })
      const cancelButton = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowCancel) as HTMLButtonElement
      await act(async () => { cancelButton.click(); await Promise.resolve() })
      await act(async () => { emitRunState(liveCompleted); await mounted.settle() })
      await act(async () => { resolveCancel(staleActionResponse); await cancelResult; await mounted.settle() })

      expect(mounted.domWindow.document.querySelector('.workflow-execution-run-identity .workflow-status-pill')?.textContent).toBe(getAppCopy('zh').workflowRunCompleted)
      expect(mounted.domWindow.document.querySelector('.workflow-execution-detail')?.textContent).toContain('fresh live output')
      expect(mounted.domWindow.document.querySelector('.workflow-run-item strong')?.textContent).toBe(getAppCopy('zh').workflowRunCompleted)
      expect(getRunDefinition.mock.calls.map(([runId]) => runId)).toEqual([run.id])
    } finally {
      resolveCancel(staleActionResponse)
      await mounted.cleanup()
    }
  })

  it('keeps a deferred run A response out of workflow B and retains it when workflow A is reopened', async () => {
    const workflowA = createDefaultWorkflow('异步动作跨工作流 A')
    const workflowB = createDefaultWorkflow('异步动作跨工作流 B')
    const runA: WorkflowRunRecord = { id: 'run-cross-workflow-action-a', workflowId: workflowA.id, workflowRevision: workflowA.revision, status: 'running', input: {}, allowShellFile: false, nodeStates: [], events: [] }
    const updatedRunA: WorkflowRunRecord = { ...runA, status: 'cancelled', completedAt: '2026-09-12T08:03:00.000Z', events: [{ id: 'cross-a-cancelled', time: '2026-09-12T08:03:00.000Z', type: 'run-cancelled' }] }
    const runB: WorkflowRunRecord = { id: 'run-cross-workflow-action-b', workflowId: workflowB.id, workflowRevision: workflowB.revision, status: 'completed', input: {}, output: 'workflow B output', allowShellFile: false, nodeStates: [], events: [] }
    let resolveCancel!: (record: WorkflowRunRecord) => void
    const cancelResult = new Promise<WorkflowRunRecord>((resolve) => { resolveCancel = resolve })
    const never = new Promise<WorkflowRunRecord[]>(() => {})
    const calls = new Map<string, number>()
    const getRunDefinition = vi.fn(async (runId: string) => runId === runA.id ? workflowA : workflowB)
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [workflowA, workflowB]),
      listRuns: vi.fn((workflowId: string) => {
        const count = (calls.get(workflowId) ?? 0) + 1
        calls.set(workflowId, count)
        if (workflowId === workflowA.id) return count >= 3 ? never : Promise.resolve([runA])
        return Promise.resolve([runB])
      }),
      getRunDefinition,
      cancel: vi.fn(() => cancelResult),
      onStateChange: vi.fn(() => () => {}),
      listModificationHistory: vi.fn(async () => []),
      onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      const workflowCard = (name: string): HTMLButtonElement => Array.from(mounted.domWindow.document.querySelectorAll('.workflow-file-card-main')).find((card) => card.textContent?.includes(name)) as HTMLButtonElement
      const executionsButton = (): HTMLButtonElement => Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { workflowCard(workflowA.name).click(); await mounted.settle() })
      await act(async () => { executionsButton().click(); await Promise.resolve() })
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-run-item-main') as HTMLButtonElement).click(); await mounted.settle() })
      const cancelButton = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowCancel) as HTMLButtonElement
      await act(async () => { cancelButton.click(); await Promise.resolve() })

      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-back-button') as HTMLButtonElement).click(); await Promise.resolve() })
      await act(async () => { workflowCard(workflowB.name).click(); await mounted.settle() })
      await act(async () => { executionsButton().click(); await Promise.resolve() })
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-run-item-main') as HTMLButtonElement).click(); await mounted.settle() })
      await act(async () => { resolveCancel(updatedRunA); await cancelResult; await mounted.settle() })

      expect(mounted.domWindow.document.querySelector('.workflow-execution-run-identity')?.textContent).toContain(runB.id)
      expect(mounted.domWindow.document.body.textContent).not.toContain(runA.id.slice(-12))
      expect(getRunDefinition.mock.calls.map(([runId]) => runId)).toEqual([runA.id, runB.id])

      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-back-button') as HTMLButtonElement).click(); await Promise.resolve() })
      await act(async () => { workflowCard(workflowA.name).click(); await mounted.settle() })
      await act(async () => { executionsButton().click(); await Promise.resolve() })
      const reopenedRunA = Array.from(mounted.domWindow.document.querySelectorAll('.workflow-run-item')).find((item) => item.textContent?.includes(runA.id.slice(-12)))
      expect(reopenedRunA?.querySelector('strong')?.textContent).toBe(getAppCopy('zh').workflowRunCancelled)
      expect(mounted.domWindow.document.body.textContent).not.toContain(runB.id.slice(-12))
    } finally {
      resolveCancel(updatedRunA)
      await mounted.cleanup()
    }
  })

  it('keeps both deferred compensation reconciliation responses owned by run A after selecting run B', async () => {
    const workflow = createDefaultWorkflow('补偿核对异步所有权')
    const occurrenceId = 'run-compensation-owner-a:compensation:write:ordinary'
    const runA: WorkflowRunRecord = {
      id: 'run-compensation-owner-a', workflowId: workflow.id, workflowRevision: workflow.revision, status: 'failed', input: {}, allowShellFile: false, nodeStates: [], events: [],
      compensationStack: [{ sourceNodeId: 'write', action: { type: 'workflow', workflowId: 'rollback' }, status: 'failed', effectState: 'unknown', occurrenceId }],
    }
    const runB: WorkflowRunRecord = { id: 'run-compensation-owner-b', workflowId: workflow.id, workflowRevision: workflow.revision, status: 'completed', input: {}, output: 'run B compensation-safe', allowShellFile: false, nodeStates: [], events: [] }
    const reconciledRunA: WorkflowRunRecord = {
      ...runA,
      compensationStack: [{ sourceNodeId: 'write', action: { type: 'workflow', workflowId: 'rollback' }, status: 'pending', effectState: 'none', occurrenceId }],
    }
    const compensatedRunA: WorkflowRunRecord = {
      ...runA,
      compensationStack: [{ sourceNodeId: 'write', action: { type: 'workflow', workflowId: 'rollback' }, status: 'completed', effectState: 'none', occurrenceId }],
    }
    let resolveReconciliation!: (record: WorkflowRunRecord) => void
    let resolveCompensation!: (record: WorkflowRunRecord) => void
    const reconciliationResult = new Promise<WorkflowRunRecord>((resolve) => { resolveReconciliation = resolve })
    const compensationResult = new Promise<WorkflowRunRecord>((resolve) => { resolveCompensation = resolve })
    const compensate = vi.fn(() => compensationResult)
    const getRunDefinition = vi.fn(async () => workflow)
    const mounted = await mountWorkflowRunCachePage({
      list: vi.fn(async () => [workflow]),
      listRuns: vi.fn(async () => [runA, runB]),
      getRunDefinition,
      reconcileCompensation: vi.fn(() => reconciliationResult),
      compensate,
      onStateChange: vi.fn(() => () => {}),
      listModificationHistory: vi.fn(async () => []),
      onModificationStateChange: vi.fn(() => () => {}),
    })
    try {
      await act(async () => { (mounted.domWindow.document.querySelector('.workflow-file-card-main') as HTMLButtonElement).click(); await mounted.settle() })
      const executions = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowExecutions) as HTMLButtonElement
      await act(async () => { executions.click(); await Promise.resolve() })
      const runButton = (runId: string): HTMLButtonElement => Array.from(mounted.domWindow.document.querySelectorAll('.workflow-run-item-main')).find((button) => button.textContent?.includes(runId.slice(-12))) as HTMLButtonElement
      await act(async () => { runButton(runA.id).click(); await mounted.settle() })
      const textarea = mounted.domWindow.document.querySelector('.workflow-compensation-effect-review textarea') as HTMLTextAreaElement
      await act(async () => { Simulate.change(textarea, { target: { value: 'provider confirms absent' } }) })
      const reconcileButton = Array.from(mounted.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === getAppCopy('zh').workflowCompensationEffectNotDispatched) as HTMLButtonElement
      await act(async () => { reconcileButton.click(); await Promise.resolve() })
      await act(async () => { runButton(runB.id).click(); await mounted.settle() })

      await act(async () => { resolveReconciliation(reconciledRunA); await reconciliationResult; await mounted.settle() })
      expect(compensate).toHaveBeenCalledWith(runA.id)
      expect(mounted.domWindow.document.querySelector('.workflow-execution-run-identity')?.textContent).toContain(runB.id)

      await act(async () => { resolveCompensation(compensatedRunA); await compensationResult; await mounted.settle() })
      expect(mounted.domWindow.document.querySelector('.workflow-execution-run-identity')?.textContent).toContain(runB.id)
      expect(mounted.domWindow.document.querySelector('.workflow-run-item-active')?.textContent).toContain(runB.id.slice(-12))
      expect(getRunDefinition.mock.calls.map(([runId]) => runId)).toEqual([runA.id, runB.id])
    } finally {
      resolveReconciliation(reconciledRunA)
      resolveCompensation(compensatedRunA)
      await mounted.cleanup()
    }
  })

  it('rejects a run action response whose identity differs from the submitted run', async () => {
    const apply = vi.fn()
    const mismatched: WorkflowRunRecord = { id: 'run-response-b', workflowId: 'workflow', workflowRevision: 1, status: 'failed', input: {}, allowShellFile: false, nodeStates: [], events: [] }

    await expect(workflowPage.applyWorkflowRunActionRequest('run-submitted-a', async () => mismatched, () => 'run-submitted-a', apply)).rejects.toThrow(/identity mismatch/u)
    expect(apply).not.toHaveBeenCalled()
  })

  it('labels reconciliation controls with the node and loop iteration identity', () => {
    const markup = renderToStaticMarkup(<workflowPage.WorkflowEffectReconciliationPanel copy={getAppCopy('zh')} targets={[{ key: 'run-a:iteration-2:write', nodeId: 'write', nodeLabel: '发送回执', iterationId: 'iteration-2', iterationIndex: 2, loopNodeLabel: '逐项发送', input: 'R-2' }]} onReconcile={vi.fn()} />)

    expect(markup).toContain('aria-label="核对说明: 发送回执 · 逐项发送: 循环第 3 项 · iteration-2"')
    expect(markup).toContain('aria-label="确认未发送并重试: 发送回执 · 逐项发送: 循环第 3 项 · iteration-2"')
    expect(markup).toContain('aria-label="确认已经发送: 发送回执 · 逐项发送: 循环第 3 项 · iteration-2"')
  })

  it('uses localized reconciliation errors in English', () => {
    const errorMessage = (workflowPage as unknown as { workflowReconciliationErrorMessage?: (copy: ReturnType<typeof getAppCopy>) => string }).workflowReconciliationErrorMessage
    expect(errorMessage).toBeTypeOf('function')
    if (errorMessage === undefined) return
    expect(errorMessage(getAppCopy('en'))).toBe('Unable to reconcile this effect. Try again or check the run state.')
  })

  it('sends the current loop target and refreshes both workflow-page run surfaces after reconciliation', async () => {
    const reconciled: WorkflowRunRecord = { ...workflowWithUnknownLoopEffect().run, status: 'failed', output: 'reconciled result', error: 'reviewed', nodeStates: [] }
    const reconcileEffect = vi.fn(async () => reconciled)
    const page = await mountWorkflowEffectReviewPage('zh', reconcileEffect)
    try {
      const textarea = page.domWindow.document.querySelector('textarea') as HTMLTextAreaElement
      await act(async () => { Simulate.change(textarea, { target: { value: '  checked delivery log  ' } }) })
      const action = Array.from(page.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '确认未发送并重试') as HTMLButtonElement
      await act(async () => { action.click(); await Promise.resolve() })

      expect(reconcileEffect).toHaveBeenCalledWith(page.run.id, { nodeId: page.bodyNodeId, iterationId: 'iteration-0', outcome: 'not-dispatched', note: 'checked delivery log' })
      expect(page.domWindow.document.querySelector('.workflow-execution-detail')?.textContent).toContain('reconciled result')
      expect(page.domWindow.document.querySelector('.workflow-run-item strong')?.textContent).toContain('运行失败')
    } finally {
      await page.cleanup()
    }
  })

  it('keeps the dispatched confirmation and note when the WorkflowPage bridge rejects', async () => {
    const reconcileEffect = vi.fn(async () => { throw new Error('后端失败') })
    const page = await mountWorkflowEffectReviewPage('en', reconcileEffect)
    try {
      const textarea = page.domWindow.document.querySelector('textarea') as HTMLTextAreaElement
      await act(async () => { Simulate.change(textarea, { target: { value: '  checked delivery log  ' } }) })
      const dispatched = Array.from(page.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === 'Confirm already sent') as HTMLButtonElement
      await act(async () => { dispatched.click() })
      const confirm = Array.from(page.domWindow.document.querySelectorAll('button')).find((button) => button.textContent === 'I confirm it was sent, continue') as HTMLButtonElement
      await act(async () => { confirm.click(); await Promise.resolve() })

      expect(reconcileEffect).toHaveBeenCalledOnce()
      expect(page.domWindow.document.body.textContent).toContain('Unable to reconcile this effect. Try again or check the run state.')
      expect((page.domWindow.document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('  checked delivery log  ')
      expect(Array.from(page.domWindow.document.querySelectorAll('button')).some((button) => button.textContent === 'I confirm it was sent, continue')).toBe(true)
    } finally {
      await page.cleanup()
    }
  })
})
