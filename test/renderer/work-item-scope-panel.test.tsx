import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkItemScopePanel } from '../../src/renderer/work-items/WorkItemScopePanel.js'

describe('WorkItemScopePanel', () => {
  it('shows the resolved project title, stable id, persisted cwd, and references', () => {
    const markup = renderToStaticMarkup(<WorkItemScopePanel
      scope={{ projectId: 'project-42', cwd: '/workspace/ezdsh', resourceRefs: ['docs/brief.md', 'https://example.test/source'] }}
      project={{ projectId: 'project-42', title: 'EzDSH', path: '/workspace/other' }}
      locale="en"
    />)

    expect(markup).toContain('Task scope')
    expect(markup).toContain('EzDSH')
    expect(markup).toContain('project-42')
    expect(markup).toContain('/workspace/ezdsh')
    expect(markup).toContain('docs/brief.md')
    expect(markup).toContain('https://example.test/source')
    expect(markup).toContain('Recorded references do not prove that content was read, verified, or authorized for an executor.')
  })

  it('shows the raw project id and an unavailable note when the directory entry is absent', () => {
    const markup = renderToStaticMarkup(<WorkItemScopePanel
      scope={{ projectId: 'deleted-project', resourceRefs: [] }}
      locale="en"
    />)

    expect(markup).toContain('deleted-project')
    expect(markup).toContain('Project directory unavailable')
  })

  it('keeps an empty scope explicit and does not infer cwd from the project directory', () => {
    const markup = renderToStaticMarkup(<WorkItemScopePanel
      scope={{ resourceRefs: [] }}
      project={{ projectId: 'project-42', title: 'EzDSH', path: '/workspace/ezdsh' }}
      locale="en"
    />)

    expect(markup).toContain('Unassigned project')
    expect(markup).toContain('No fixed working directory')
    expect(markup).toContain('No recorded references')
    expect(markup).not.toContain('/workspace/ezdsh')
  })

  it('renders hostile-looking references as inert escaped text', () => {
    const reference = '<script>alert("read")</script><a href="https://evil.test">open</a>'
    const markup = renderToStaticMarkup(<WorkItemScopePanel
      scope={{ resourceRefs: [reference] }}
      locale="en"
    />)

    expect(markup).toContain('&lt;script&gt;alert(&quot;read&quot;)&lt;/script&gt;&lt;a href=&quot;https://evil.test&quot;&gt;open&lt;/a&gt;')
    expect(markup).not.toContain('<script>')
    expect(markup).not.toContain('<a ')
    expect(markup).not.toContain('<button')
  })
})
