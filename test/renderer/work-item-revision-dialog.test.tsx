import { createWindow } from '@mixmark-io/domino'
import { act, type ReactElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkItemRevisionDialog } from '../../src/renderer/work-items/WorkItemRevisionDialog.js'
import type { WorkTaskSnapshot } from '../../src/shared/work-items.js'
import { workTaskFixture } from '../work-items/fixtures.js'

function snapshot(revision = 2, requirementVersion = 1): WorkTaskSnapshot {
  const task = workTaskFixture()
  return {
    task: {
      ...task,
      revision,
      currentRequirementVersion: requirementVersion,
      requirements: [{ version: requirementVersion, goal: '旧目标', acceptance: '旧验收', createdAt: '2026-09-16T00:00:00.000Z' }],
    },
    attempts: [], runs: [], artifacts: [], actions: [],
  }
}

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.useRealTimers() })

async function mount(element: ReactElement) {
  const dom = createWindow('<html><body><div id="root"></div></body></html>')
  const keys = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(dom.document.getElementById('root')!)
  cleanup = async () => {
    await act(async () => root.unmount())
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key)
  }
  await act(async () => root.render(element))
  return Object.assign(dom, {
    rerender: async (next: ReactElement) => { await act(async () => root.render(next)) },
  })
}

function control(dom: ReturnType<typeof createWindow>, label: string): HTMLTextAreaElement {
  const result = dom.document.querySelector(`[aria-label="${label}"]`)
  if (!result) throw new Error(`Missing control ${label}`)
  return result as HTMLTextAreaElement
}

function button(dom: ReturnType<typeof createWindow>, label: string): HTMLButtonElement {
  const result = Array.from(dom.document.querySelectorAll('button')).find((node) => node.textContent?.trim() === label)
  if (!result) throw new Error(`Missing button ${label}`)
  return result as HTMLButtonElement
}

async function change(element: Element, value: string): Promise<void> {
  await act(async () => { Simulate.change(element, { target: { value } } as never) })
}

describe('WorkItemRevisionDialog', () => {
  it('prefills the current requirement and saves a new durable version', async () => {
    const revised = snapshot(3, 2)
    const revise = vi.fn(async () => revised)
    const onRevised = vi.fn()
    const close = vi.fn()
    const dom = await mount(<WorkItemRevisionDialog snapshot={snapshot()} onRevise={revise} onReload={async () => snapshot()} onRevised={onRevised} onClose={close} />)

    expect(control(dom, '新目标').value).toBe('旧目标')
    expect(control(dom, '新验收标准').value).toBe('旧验收')
    await change(control(dom, '新目标'), ' 新目标 ')
    await change(control(dom, '新验收标准'), ' 新验收 ')
    await act(async () => { button(dom, '仅保存新要求').click(); await Promise.resolve(); await Promise.resolve() })

    expect(revise).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^work-item-revise-/),
      taskId: 'task-1', expectedRevision: 2, goal: '新目标', acceptance: '新验收',
    })
    expect(onRevised).toHaveBeenCalledWith(revised, 'none')
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([
    ['修订后重做', 'redo'],
    ['修订后交接', 'handoff'],
  ] as const)('returns the explicit %s follow-up only after revision succeeds', async (label, followUp) => {
    const revised = snapshot(3, 2)
    const onRevised = vi.fn()
    const dom = await mount(<WorkItemRevisionDialog snapshot={snapshot()} onRevise={async () => revised} onReload={async () => snapshot()} onRevised={onRevised} onClose={() => {}} />)
    await act(async () => { button(dom, label).click(); await Promise.resolve(); await Promise.resolve() })
    expect(onRevised).toHaveBeenCalledWith(revised, followUp)
  })

  it('keeps the dialog open on a transient failure and retries the same revision request', async () => {
    const revised = snapshot(3, 2)
    const revise = vi.fn().mockRejectedValueOnce(new Error('Revision conflict')).mockResolvedValueOnce(revised)
    const reload = vi.fn(async () => snapshot())
    const close = vi.fn()
    const dom = await mount(<WorkItemRevisionDialog snapshot={snapshot()} onRevise={revise} onReload={reload} onRevised={() => {}} onClose={close} />)

    await act(async () => { button(dom, '仅保存新要求').click(); await Promise.resolve(); await Promise.resolve() })
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toContain('Revision conflict')
    expect(close).not.toHaveBeenCalled()
    await act(async () => { button(dom, '仅保存新要求').click(); await Promise.resolve(); await Promise.resolve() })
    expect(revise).toHaveBeenCalledTimes(2)
    expect(revise.mock.calls[1]?.[0]).toEqual(revise.mock.calls[0]?.[0])
    expect(reload).not.toHaveBeenCalled()
  })

  it('replays the original request when Main may have committed before the response was lost', async () => {
    const applied = snapshot(3, 2)
    const failure = Object.assign(new Error('Connection closed'), { code: 'IPC_CONNECTION_LOST' })
    const revise = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(applied)
    const reload = vi.fn(async () => applied)
    const onRevised = vi.fn()
    const dom = await mount(<WorkItemRevisionDialog snapshot={snapshot()} onRevise={revise} onReload={reload} onRevised={onRevised} onClose={() => {}} />)

    await change(control(dom, '新目标'), '只创建一个版本')
    await act(async () => { button(dom, '仅保存新要求').click(); await Promise.resolve(); await Promise.resolve() })
    await act(async () => { button(dom, '仅保存新要求').click(); await Promise.resolve(); await Promise.resolve() })

    expect(reload).not.toHaveBeenCalled()
    expect(revise).toHaveBeenCalledTimes(2)
    expect(revise.mock.calls[1]?.[0]).toEqual(revise.mock.calls[0]?.[0])
    expect(onRevised).toHaveBeenCalledWith(applied, 'none')
  })

  it('keeps the original request when its changed event arrives before a lost IPC response', async () => {
    const applied = snapshot(3, 2)
    let rejectFirst!: (reason: Error) => void
    const first = new Promise<WorkTaskSnapshot>((_resolve, reject) => { rejectFirst = reject })
    const revise = vi.fn().mockImplementationOnce(() => first).mockResolvedValueOnce(applied)
    const reload = vi.fn(async () => applied)
    const onRevised = vi.fn()
    const onClose = vi.fn()
    const props = (current: WorkTaskSnapshot) => <WorkItemRevisionDialog snapshot={current} onRevise={revise} onReload={reload} onRevised={onRevised} onClose={onClose} />
    const dom = await mount(props(snapshot()))

    await change(control(dom, '新目标'), '响应丢失时仍只创建一个版本')
    await act(async () => { button(dom, '仅保存新要求').click(); await Promise.resolve() })
    await dom.rerender(props(applied))
    await act(async () => { rejectFirst(Object.assign(new Error('Connection closed'), { code: 'IPC_CONNECTION_LOST' })); await Promise.resolve(); await Promise.resolve() })
    await act(async () => { button(dom, '仅保存新要求').click(); await Promise.resolve(); await Promise.resolve() })

    expect(reload).not.toHaveBeenCalled()
    expect(revise).toHaveBeenCalledTimes(2)
    expect(revise.mock.calls[1]?.[0]).toEqual(revise.mock.calls[0]?.[0])
    expect(revise.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 2, goal: '响应丢失时仍只创建一个版本' })
    expect(onRevised).toHaveBeenCalledWith(applied, 'none')
  })

  it('reloads a conflicting task, preserves the draft and retries from the latest revision', async () => {
    const revised = snapshot(4, 2)
    const revise = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Revision conflict'), { code: 'REVISION_CONFLICT' })).mockResolvedValueOnce(revised)
    const reload = vi.fn(async () => snapshot(3, 1))
    const dom = await mount(<WorkItemRevisionDialog snapshot={snapshot()} onRevise={revise} onReload={reload} onRevised={() => {}} onClose={() => {}} />)

    await change(control(dom, '新目标'), '保留的草稿')
    await act(async () => { button(dom, '仅保存新要求').click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(reload).toHaveBeenCalledWith('task-1')
    expect(control(dom, '新目标').value).toBe('保留的草稿')
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toContain('revision 3')
    await act(async () => { button(dom, '仅保存新要求').click(); await Promise.resolve(); await Promise.resolve() })

    expect(revise).toHaveBeenCalledTimes(2)
    expect(revise.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 2, goal: '保留的草稿' })
    expect(revise.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 3, goal: '保留的草稿' })
    expect(revise.mock.calls[1]?.[0].requestId).not.toBe(revise.mock.calls[0]?.[0].requestId)
  })

  it('traps focus, ignores composing Escape and restores focus after closing', async () => {
    function Harness(): JSX.Element {
      const [open, setOpen] = useState(false)
      return <>
        <button type="button" onClick={() => setOpen(true)}>打开修改要求</button>
        {open ? <WorkItemRevisionDialog snapshot={snapshot()} onRevise={async () => snapshot(3, 2)} onReload={async () => snapshot()} onRevised={() => {}} onClose={() => setOpen(false)} /> : null}
      </>
    }
    const dom = await mount(<Harness />)
    vi.useFakeTimers()
    let focused: HTMLElement | null = null
    Object.defineProperty(dom.document, 'activeElement', { configurable: true, get: () => focused })
    const trackFocus = (element: HTMLElement): void => {
      Object.defineProperty(element, 'focus', { configurable: true, value: () => { focused = element } })
    }
    const trigger = button(dom, '打开修改要求')
    trackFocus(trigger)
    trigger.focus()
    await act(async () => { trigger.click() })
    const goal = control(dom, '新目标')
    const close = button(dom, '关闭')
    for (const element of Array.from(dom.document.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="dialog"] textarea'))) trackFocus(element)
    await act(async () => { vi.runOnlyPendingTimers() })
    expect(dom.document.activeElement).toBe(goal)

    close.focus()
    await act(async () => {
      const tab = new dom.Event('keydown', { bubbles: true, cancelable: true }) as KeyboardEvent
      Object.defineProperty(tab, 'key', { value: 'Tab' })
      dom.document.dispatchEvent(tab)
    })
    expect(dom.document.activeElement).toBe(goal)
    await act(async () => {
      Simulate.compositionStart(goal)
      const escape = new dom.Event('keydown', { bubbles: true, cancelable: true }) as KeyboardEvent
      Object.defineProperty(escape, 'key', { value: 'Escape' })
      Object.defineProperty(escape, 'isComposing', { value: true })
      dom.document.dispatchEvent(escape)
    })
    expect(dom.document.querySelector('[role="dialog"]')).toBeTruthy()
    await act(async () => {
      Simulate.compositionEnd(goal)
      const escape = new dom.Event('keydown', { bubbles: true, cancelable: true }) as KeyboardEvent
      Object.defineProperty(escape, 'key', { value: 'Escape' })
      dom.document.dispatchEvent(escape)
    })
    expect(dom.document.querySelector('[role="dialog"]')).toBeFalsy()
    expect(dom.document.activeElement).toBe(trigger)
    vi.useRealTimers()
  })

  it('requires both fields and never calls Main for an incomplete revision', async () => {
    const revise = vi.fn(async () => snapshot(3, 2))
    const dom = await mount(<WorkItemRevisionDialog snapshot={snapshot()} onRevise={revise} onReload={async () => snapshot()} onRevised={() => {}} onClose={() => {}} />)
    await change(control(dom, '新目标'), '   ')
    await act(async () => { button(dom, '仅保存新要求').click() })
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toContain('必填')
    expect(revise).not.toHaveBeenCalled()
  })
})
