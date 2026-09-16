import { createWindow } from '@mixmark-io/domino'
import { act, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkItemProjectFilter, type WorkItemProjectOption, type WorkItemProjectFilterValue } from '../../src/renderer/work-items/WorkItemProjectFilter.js'

const options: WorkItemProjectOption[] = [
  { projectId: 'project-1', title: '同名项目', path: '/work/project-1', orphaned: false },
  { projectId: 'project-2', title: '同名项目', path: '/work/project-2', orphaned: false },
  { projectId: 'missing-project', title: 'missing-project', orphaned: true },
]

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })

async function mount(element: ReactElement) {
  const dom = createWindow('<html><body><div id="root"></div></body></html>')
  const keys = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.HTMLElement, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(dom.document.getElementById('root')!)
  cleanup = async () => { await act(async () => root.unmount()); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } }
  await act(async () => root.render(element))
  return { dom, root }
}

describe('WorkItemProjectFilter', () => {
  it('localizes labels, exposes the project option count, and distinguishes duplicate titles', () => {
    const onChange = vi.fn()
    const markup = renderToStaticMarkup(<WorkItemProjectFilter value={{ kind: 'all' }} options={options} onChange={onChange} locale="zh" />)

    expect(markup).toContain('全部')
    expect(markup).toContain('未归项目')
    expect(markup).toContain('3')
    expect(markup).toContain('同名项目 (project-1)')
    expect(markup).toContain('同名项目 (project-2)')
    expect(markup).toContain('missing-project')
  })

  it('uses localized English labels', () => {
    const markup = renderToStaticMarkup(<WorkItemProjectFilter value={{ kind: 'unassigned' }} options={options} onChange={() => {}} locale="en" />)

    expect(markup).toContain('All')
    expect(markup).toContain('Unassigned')
    expect(markup).toContain('Available projects: 3')
  })

  it('emits a typed project selection and remains controlled after the parent updates it', async () => {
    let value: WorkItemProjectFilterValue = { kind: 'all' }
    const onChange = vi.fn((next: WorkItemProjectFilterValue) => { value = next })
    const mounted = await mount(<WorkItemProjectFilter value={value} options={options} onChange={onChange} locale="en" />)
    const select = mounted.dom.document.querySelector('select') as HTMLSelectElement

    select.value = 'project:project-2'
    await act(async () => select.dispatchEvent(new mounted.dom.Event('change', { bubbles: true })))
    expect(onChange).toHaveBeenCalledWith({ kind: 'project', projectId: 'project-2' })

    await act(async () => mounted.root.render(<WorkItemProjectFilter value={value} options={options} onChange={onChange} locale="en" />))
    expect(select.value).toBe('project:project-2')
  })

  it('falls back to all for an unknown serialized project selection', () => {
    const markup = renderToStaticMarkup(<WorkItemProjectFilter value={{ kind: 'project', projectId: 'not-observed' }} options={options} onChange={() => {}} locale="en" />)

    expect(markup).toContain('<select')
    expect(markup).toContain('value="all"')
    expect(markup).not.toContain('value="project:not-observed"')
  })
})
