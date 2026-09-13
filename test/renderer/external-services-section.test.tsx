import { createWindow } from '@mixmark-io/domino'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { ExternalServicesSection } from '../../src/renderer/settings/ExternalServicesSection'
import { getAppCopy } from '../../src/shared/locale'
import type { ExternalServiceSnapshot } from '../../src/shared/external-services'

const failedService = {
  id: 'dev', name: 'Dev server', command: 'npm', args: ['run', 'dev'], cwd: '/missing/project', env: {}, autoStart: false,
  state: 'failed', error: 'spawn npm ENOENT\nraw process detail', startupIssue: { code: 'cwd-missing', path: '/missing/project' },
} as ExternalServiceSnapshot

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function withSection(run: (h: Awaited<ReturnType<typeof mount>>) => Promise<void>, options: Parameters<typeof mount>[0] = {}) {
  const h = await mount(options)
  try { await run(h) } finally { await h.cleanup() }
}

async function mount({ locale = 'en', services = [failedService] }: { locale?: 'en' | 'zh'; services?: ExternalServiceSnapshot[] } = {}) {
  const globals = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent }
  const previousNavigator = globalThis.navigator
  const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  const dom = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.navigator })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let publish!: (items: ExternalServiceSnapshot[]) => void
  const api = {
    list: vi.fn(async () => services),
    watch: vi.fn((listener: typeof publish) => { publish = listener; return () => {} }),
    selectDirectory: vi.fn(async (): Promise<string | undefined> => undefined),
    update: vi.fn(async (_id: string, input: object) => ({ ...failedService, ...input })),
    create: vi.fn(async (input: object) => ({ ...failedService, ...input })),
    start: vi.fn(async () => ({ ...failedService, state: 'running' as const, error: undefined, startupIssue: undefined })),
    stop: vi.fn(), restart: vi.fn(), remove: vi.fn(),
  }
  Object.assign(dom, { EzDSH: { externalServices: api } })
  const root = createRoot(dom.document.getElementById('root')!)
  await act(async () => { root.render(<ExternalServicesSection copy={getAppCopy(locale)} />) })
  const buttons = () => Array.from(dom.document.querySelectorAll('button')) as HTMLButtonElement[]
  const button = (label: string) => { const found = buttons().find((item) => item.textContent?.trim() === label); if (!found) throw new Error(`Missing button: ${label}`); return found }
  const input = (label: string) => { const found = dom.document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null; if (!found) throw new Error(`Missing input: ${label}`); return found }
  return {
    dom, api, button, input, publish: (items: ExternalServiceSnapshot[]) => act(async () => { publish(items) }),
    click: (label: string) => act(async () => { button(label).click() }),
    change: (label: string, value: string) => act(async () => { Simulate.change(input(label), { target: { value } } as never) }),
    cleanup: async () => {
      await act(async () => { root.unmount() })
      Object.assign(globalThis, globals)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
      if (previousAct === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
      else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct
    },
  }
}

describe('ExternalServicesSection repair flow', () => {
  it.each([
    ['en', 'The working directory does not exist.', 'Change working directory', 'Failure details'],
    ['zh', '工作目录不存在。', '修改工作目录', '失败详情'],
  ] as const)('shows an evidence-based %s summary and keeps original error collapsed', async (locale, summary, action, detailsLabel) => {
    await withSection(async (h) => {
      expect(h.dom.document.body.textContent).toContain(summary)
      expect(h.button(action)).toBeTruthy()
      const details = h.dom.document.querySelector('details')!
      expect(details.hasAttribute('open')).toBe(false)
      expect(details.textContent).toContain(detailsLabel)
      expect(details.textContent).toContain(failedService.error)
      expect(h.dom.document.querySelectorAll('.settings-error:not(details *)').length).toBeLessThanOrEqual(1)
    }, { locale })
  })

  it('saves an explicitly cleared working directory before retrying', async () => {
    await withSection(async (h) => {
      await h.click('Change working directory')
      await h.change('Working directory (optional)', '')
      const update = deferred<ExternalServiceSnapshot>()
      h.api.update.mockImplementationOnce(() => update.promise)
      await h.click('Save and retry')
      expect(h.api.update).toHaveBeenCalledWith('dev', expect.objectContaining({ cwd: '' }))
      expect(h.api.start).not.toHaveBeenCalled()
      expect(h.input('Working directory (optional)').disabled).toBe(true)
      expect(h.button('Cancel').disabled).toBe(true)
      await act(async () => { update.resolve({ ...failedService, cwd: undefined }) })
      expect(h.api.start).toHaveBeenCalledWith('dev')
      expect(h.dom.document.querySelector('.external-service-form')).toBeFalsy()
    })
  })

  it('keeps the draft and diagnosis after saving fails, without starting', async () => {
    await withSection(async (h) => {
      await h.click('Change working directory')
      await h.change('Working directory (optional)', '/fixed/project')
      h.api.update.mockRejectedValueOnce(new Error('write failed'))
      await h.click('Save and retry')
      expect(h.api.start).not.toHaveBeenCalled()
      expect(h.input('Working directory (optional)').value).toBe('/fixed/project')
      expect(h.dom.document.body.textContent).toContain('The working directory does not exist.')
      expect(h.dom.document.body.textContent).toContain('Could not save the service. Your changes are still here.')
    })
  })

  it('uses a short retry error while preserving new snapshot details and draft', async () => {
    await withSection(async (h) => {
      await h.click('Change working directory')
      await h.change('Working directory (optional)', '/fixed/project')
      h.api.start.mockRejectedValueOnce(new Error('huge launch error'))
      await h.click('Save and retry')
      await h.publish([{ ...failedService, error: 'latest raw error' }])
      expect(h.input('Working directory (optional)').value).toBe('/fixed/project')
      expect(h.dom.document.body.textContent).toContain('The service could not start. Review the failure details below.')
      expect(h.dom.document.body.textContent).not.toContain('huge launch error')
      expect(h.dom.document.querySelector('details')!.textContent).toContain('latest raw error')
    })
  })

  it('canceling directory selection leaves the draft unchanged and never saves or starts', async () => {
    await withSection(async (h) => {
      await h.click('Change working directory')
      await h.click('Choose folder')
      expect(h.api.selectDirectory).toHaveBeenCalledOnce()
      expect(h.input('Working directory (optional)').value).toBe('/missing/project')
      expect(h.api.update).not.toHaveBeenCalled()
      expect(h.api.start).not.toHaveBeenCalled()
      await h.click('Cancel')
      expect(h.dom.document.querySelector('.external-service-form')).toBeFalsy()
    })
  })

  it('selecting a directory changes only the draft and blocks switching service while pending', async () => {
    await withSection(async (h) => {
      await h.click('Change working directory')
      const selection = deferred<string | undefined>()
      h.api.selectDirectory.mockImplementationOnce(() => selection.promise)
      await h.click('Choose folder')
      expect(h.button('Edit').disabled).toBe(true)
      expect(h.button('Save and retry').disabled).toBe(true)
      expect(h.input('Working directory (optional)').disabled).toBe(true)
      await act(async () => { selection.resolve('/selected/project') })
      expect(h.input('Working directory (optional)').value).toBe('/selected/project')
      expect(h.api.update).not.toHaveBeenCalled()
      expect(h.api.start).not.toHaveBeenCalled()
    })
  })

  it('ordinary editing saves without starting', async () => {
    await withSection(async (h) => {
      await h.click('Edit')
      await h.change('Working directory (optional)', '')
      await h.click('Save')
      expect(h.api.update).toHaveBeenCalledWith('dev', expect.objectContaining({ cwd: '' }))
      expect(h.api.start).not.toHaveBeenCalled()
    })
  })

  it('ordinary creation saves without starting', async () => {
    await withSection(async (h) => {
      await h.click('Add service')
      await h.change('Name', 'New service')
      await h.change('Command', 'node')
      await h.click('Save')
      expect(h.api.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'New service', command: 'node' }))
      expect(h.api.start).not.toHaveBeenCalled()
    })
  })

  it('opens command repair and retries with the revised command', async () => {
    await withSection(async (h) => {
      await h.click('Change start command')
      await h.change('Command', '/opt/node/bin/npm')
      await h.click('Save and retry')
      expect(h.api.update).toHaveBeenCalledWith('dev', expect.objectContaining({ command: '/opt/node/bin/npm' }))
      expect(h.api.start).toHaveBeenCalledWith('dev')
    }, { services: [{ ...failedService, startupIssue: { code: 'command-not-found' } }] })
  })

  it('keeps the editor when a retry returns a failed snapshot', async () => {
    await withSection(async (h) => {
      await h.click('Change working directory')
      h.api.start.mockResolvedValueOnce(failedService as never)
      await h.click('Save and retry')
      expect(h.input('Working directory (optional)').value).toBe('/missing/project')
      expect(h.dom.document.body.textContent).toContain('The service could not start. Review the failure details below.')
      expect(h.dom.document.querySelector('details')!.textContent).toContain(failedService.error)
    })
  })

  it('keeps manual directory editing available after a picker error', async () => {
    await withSection(async (h) => {
      await h.click('Change working directory')
      h.api.selectDirectory.mockRejectedValueOnce(new Error('dialog failed'))
      await h.click('Choose folder')
      expect(h.dom.document.body.textContent).toContain('Could not open the folder picker. Enter the path manually.')
      expect(h.input('Working directory (optional)').disabled).toBe(false)
      expect(h.api.update).not.toHaveBeenCalled()
      expect(h.api.start).not.toHaveBeenCalled()
    })
  })

  it('shows a generic failure summary for a failed exit without a startup diagnosis', async () => {
    await withSection(async (h) => {
      const alert = h.dom.document.querySelector('[role="alert"]')
      expect(alert?.textContent).toBe('The service could not start. Review the failure details.')
      expect(h.dom.document.body.textContent).not.toContain('Change working directory')
      expect(h.dom.document.body.textContent).not.toContain('Change start command')
      const details = h.dom.document.querySelector('details')!
      expect(details.hasAttribute('open')).toBe(false)
      expect(details.textContent).toContain('Process exited with code 1')
    }, { services: [{ ...failedService, startupIssue: undefined, error: 'Process exited with code 1' }] })
  })

  it('does not attribute an ordinary failed exit or stale running issue to a missing command', async () => {
    for (const service of [{ ...failedService, startupIssue: undefined }, { ...failedService, state: 'running' as const }]) {
      await withSection(async (h) => {
        expect(h.dom.document.body.textContent).not.toContain('The working directory does not exist.')
        expect(h.dom.document.querySelector('details')!.textContent).toContain(failedService.error)
      }, { services: [service] })
    }
  })
})
