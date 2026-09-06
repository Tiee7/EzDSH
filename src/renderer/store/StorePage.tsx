import { useEffect, useState } from 'react'
import type { AppCopy, AppLocale } from '../../shared/locale.js'
import type { DeepLinkInstallTarget } from '../../shared/contracts.js'
import type { StoreKind } from '../../shared/store.js'
import { InstalledStoreBrowser } from './InstalledStoreBrowser.js'
import { StoreBrowser } from './StoreBrowser.js'

type StoreSurface = 'skill' | 'plugin' | 'mcp' | 'installed'

interface StorePageProps {
  copy: AppCopy
  locale: AppLocale
  deepLinkTarget?: DeepLinkInstallTarget
}

/** The store tab page: skills, DSH plugins, and MCP tool extensions. */
export function StorePage({ copy, locale, deepLinkTarget }: StorePageProps): JSX.Element {
  const [surface, setSurface] = useState<StoreSurface>('skill')
  useEffect(() => {
    if (deepLinkTarget !== undefined) {
      setSurface(deepLinkTarget.kind === 'mcp' ? 'mcp' : 'skill')
    }
  }, [deepLinkTarget])
  const kind: StoreKind = surface === 'plugin' ? 'skill' : surface === 'installed' ? 'skill' : surface
  const fixedCategory = surface === 'plugin' ? 'plugin' : undefined
  return (
    <div className="store-page">
      <div className="store-surfaces" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={surface === 'installed'}
          className={`surface-tab surface-tab-installed ${surface === 'installed' ? 'surface-tab-active' : ''}`}
          onClick={() => { setSurface('installed') }}
        >
          <svg className="surface-tab-icon" viewBox="0 0 24 24" aria-hidden="true" data-icon="installed" focusable="false">
            <path d="M5 4.5h9l5 5v10H5z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
            <path d="m8.5 14 2.2 2.2 4.8-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
          </svg>
          <span>{copy.storeManageInstalled}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={surface === 'skill'}
          className={`surface-tab ${surface === 'skill' ? 'surface-tab-active' : ''}`}
          onClick={() => { setSurface('skill') }}
        >
          {copy.storeSurfaceSkills}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={surface === 'plugin'}
          className={`surface-tab ${surface === 'plugin' ? 'surface-tab-active' : ''}`}
          onClick={() => { setSurface('plugin') }}
        >
          {copy.storeSurfacePlugins}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={surface === 'mcp'}
          className={`surface-tab ${surface === 'mcp' ? 'surface-tab-active' : ''}`}
          onClick={() => { setSurface('mcp') }}
        >
          {copy.storeSurfaceMcp}
        </button>
      </div>
      {surface === 'installed'
        ? <InstalledStoreBrowser copy={copy} onBack={() => { setSurface('skill') }} />
        : <StoreBrowser key={surface} kind={kind} fixedCategory={fixedCategory} copy={copy} locale={locale} deepLinkTarget={deepLinkTarget} />}
    </div>
  )
}
