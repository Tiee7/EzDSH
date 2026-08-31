import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EmployeeExecutionTarget, EmployeesPage, reloadPage } from '../../src/renderer/employees/EmployeesPage.js'
import { getAppCopy } from '../../src/shared/locale.js'

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
})
