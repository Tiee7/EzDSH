import { createWindow } from '@mixmark-io/domino'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmployeeExecutionTarget, EmployeeMethodsPanel, EmployeesPage, reloadPage } from '../../src/renderer/employees/EmployeesPage.js'
import { getAppCopy } from '../../src/shared/locale.js'
import type { EmployeeWorkMethod } from '../../src/shared/employee-methods.js'

const method: EmployeeWorkMethod = {
  schemaVersion: 1,
  id: 'method-1',
  employeeId: 'researcher',
  name: '公开研究',
  description: '核对公开来源',
  workflowId: 'research-workflow',
  workflowRevision: 4,
  version: 3,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
}

let methodCleanup: (() => Promise<void>) | undefined

afterEach(async () => { await methodCleanup?.(); methodCleanup = undefined })

async function mountMethodsPanel(options: { methods?: EmployeeWorkMethod[], update?: () => Promise<EmployeeWorkMethod> } = {}) {
  const dom = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  const keys = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const previousEzDSH = (globalThis as { EzDSH?: unknown }).EzDSH
  const records = options.methods ?? [method]
  const bridge = {
    list: vi.fn(async () => records),
    create: vi.fn(async (_employeeId: string, input: Pick<EmployeeWorkMethod, 'name' | 'description' | 'workflowId' | 'workflowRevision'>) => ({ ...method, ...input, id: 'method-new', version: 1 })),
    update: vi.fn(options.update ?? (async () => method)),
    remove: vi.fn(async () => {}),
  }
  Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })
  const ezdsh = { employees: { methods: bridge } }
  Object.assign(dom as unknown as Record<string, unknown>, { EzDSH: ezdsh })
  ;(globalThis as { EzDSH?: unknown }).EzDSH = ezdsh
  const root = createRoot(dom.document.getElementById('root')!)
  methodCleanup = async () => {
    await act(async () => { root.unmount() })
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    ;(globalThis as { EzDSH?: unknown }).EzDSH = previousEzDSH
  }
  await act(async () => {
    root.render(<EmployeeMethodsPanel employeeId="researcher" developerMode />)
    await Promise.resolve()
    await Promise.resolve()
  })
  const button = (label: string): HTMLButtonElement => {
    const result = Array.from(dom.document.querySelectorAll('button')).find((node) => node.textContent === label)
    if (!result) throw new Error(`Missing button: ${label}`)
    return result as HTMLButtonElement
  }
  return { bridge, dom, button }
}

describe('EmployeesPage', () => {
  it('renders the employee management surface instead of the old placeholder', () => {
    const markup = renderToStaticMarkup(<EmployeesPage copy={getAppCopy('zh')} />)
    const header = markup.slice(markup.indexOf('<header'), markup.indexOf('</header>'))
    const listPanel = markup.slice(markup.indexOf('<aside'), markup.indexOf('</aside>'))

    expect(markup).toContain('员工列表')
    expect(markup).toContain('新增员工')
    expect(markup).toContain('刷新页面')
    expect(header).toContain('employees-reload-button')
    expect(listPanel).not.toContain('employees-reload-button')
    expect(markup).not.toContain('员工控制台正在构建中')
    expect(markup).not.toContain('交给员工的任务')
  })

  it('presents employees as reusable professional profiles without internal workflow steps', () => {
    const markup = renderToStaticMarkup(<EmployeesPage copy={getAppCopy('zh')} />)

    expect(markup).toContain('业务边界')
    expect(markup).toContain('执行规范')
    expect(markup).toContain('质量标准')
    expect(markup).toContain('技能 ID')
    expect(markup).not.toContain('工作流步骤')
    expect(markup).not.toContain('新增步骤')
  })

  it('requests a local employee-page refresh without reloading the app', () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })

    reloadPage()

    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'ezdsh:refresh-employees' }))
    vi.unstubAllGlobals()
  })

  it('renders project and Session selectors with a new-session action', () => {
    const markup = renderToStaticMarkup(
      <EmployeeExecutionTarget
        copy={getAppCopy('zh')}
        projects={[{ projectId: 'project-1', path: '/work/content', title: '内容项目', sessionIds: ['session-1'] }]}
        projectSessions={[{ sessionId: 'session-1', updatedAt: 1, running: false, title: '已有会话' }]}
        selectedProjectId="project-1"
        selectedSessionId="session-1"
        contextLoading={false}
        creatingSession={false}
        busy={false}
        sessionLocks={[]}
        onProjectChange={() => {}}
        onSessionChange={() => {}}
        onCreateSession={() => {}}
        onRefresh={() => {}}
        onForceUnlock={() => {}}
      />,
    )

    expect(markup).toContain('项目')
    expect(markup).toContain('会话')
    expect(markup).toContain('内容项目')
    expect(markup).toContain('已有会话')
    expect(markup).toContain('新建会话')
    expect(markup).toContain('employees-icon-button')
    expect(markup).toContain('刷新项目和会话')
  })

  it('shows the current Session lock and force-unlock action', () => {
    const markup = renderToStaticMarkup(
      <EmployeeExecutionTarget
        copy={getAppCopy('zh')}
        projects={[{ projectId: 'project-1', path: '/work/content', title: '内容项目', sessionIds: ['session-1'] }]}
        projectSessions={[{ sessionId: 'session-1', updatedAt: 1, running: false, title: '已有会话' }]}
        selectedProjectId="project-1"
        selectedSessionId="session-1"
        contextLoading={false}
        creatingSession={false}
        busy={false}
        sessionLocks={[{ sessionId: 'session-1', employeeId: 'researcher', runId: 'run-1', startedAt: '2026-08-29T00:00:00.000Z' }]}
        onProjectChange={() => {}}
        onSessionChange={() => {}}
        onCreateSession={() => {}}
        onRefresh={() => {}}
        onForceUnlock={() => {}}
      />,
    )

    expect(markup).toContain('会话已锁定')
    expect(markup).toContain('强制解锁')
  })

  it('keeps employee methods behind the developer-mode surface', () => {
    const markup = renderToStaticMarkup(<EmployeeMethodsPanel employeeId="researcher" developerMode={false} />)

    expect(markup).toBe('')
  })

  it('shows the owner and fixed workflow revision, and saves only method metadata with the expected version', async () => {
    const panel = await mountMethodsPanel()
    try {
      expect(panel.dom.document.body.textContent).toContain('所有者：researcher · 方法版本 v3')
      expect(panel.dom.document.body.textContent).toContain('工作流：research-workflow · 固定修订 v4')
      await act(async () => { panel.button('编辑').click() })
      const inputs = panel.dom.document.querySelectorAll('input')
      await act(async () => { Simulate.change(inputs[0], { target: { value: '来源研究' } } as never) })
      await act(async () => { panel.button('保存方法').click(); await Promise.resolve(); await Promise.resolve() })
      expect(panel.bridge.update).toHaveBeenCalledWith('researcher', 'method-1', {
        name: '来源研究',
        description: '核对公开来源',
        workflowId: 'research-workflow',
        workflowRevision: 4,
        expectedVersion: 3,
      })
      expect(Object.keys(panel.bridge.update.mock.calls[0]?.[2] ?? [])).toEqual(['name', 'description', 'workflowId', 'workflowRevision', 'expectedVersion'])
      expect(panel.bridge.list).toHaveBeenCalledTimes(2)
    } finally {
      await methodCleanup?.()
      methodCleanup = undefined
    }
  })

  it('surfaces an optimistic-version conflict instead of pretending the method was saved', async () => {
    const panel = await mountMethodsPanel({ update: async () => { throw new Error('METHOD_VERSION_CONFLICT') } })
    try {
      await act(async () => { panel.button('编辑').click() })
      await act(async () => { panel.button('保存方法').click(); await Promise.resolve(); await Promise.resolve() })
      expect(panel.dom.document.body.textContent).toContain('METHOD_VERSION_CONFLICT')
      expect(panel.bridge.list).toHaveBeenCalledOnce()
    } finally {
      await methodCleanup?.()
      methodCleanup = undefined
    }
  })
})
