import { useEffect, useState } from 'react'
import type { AppCopy, AppLocale } from '../../shared/locale.js'
import type { DeepLinkInstallTarget } from '../../shared/contracts.js'
import type { StoreKind } from '../../shared/store.js'
import { StoreBrowser } from './StoreBrowser.js'

type StoreSurface = 'skill' | 'plugin' | 'mcp'

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
  const kind: StoreKind = surface === 'plugin' ? 'skill' : surface
  const fixedCategory = surface === 'plugin' ? 'plugin' : undefined
  return (
    <div className="store-page">
      <div className="store-surfaces" role="tablist">
        <button
          role="tab"
          aria-selected={surface === 'skill'}
          className={`surface-tab ${surface === 'skill' ? 'surface-tab-active' : ''}`}
          onClick={() => { setSurface('skill') }}
        >
          {copy.storeSurfaceSkills}
        </button>
        <button
          role="tab"
          aria-selected={surface === 'plugin'}
          className={`surface-tab ${surface === 'plugin' ? 'surface-tab-active' : ''}`}
          onClick={() => { setSurface('plugin') }}
        >
          {copy.storeSurfacePlugins}
        </button>
        <button
          role="tab"
          aria-selected={surface === 'mcp'}
          className={`surface-tab ${surface === 'mcp' ? 'surface-tab-active' : ''}`}
          onClick={() => { setSurface('mcp') }}
        >
          {copy.storeSurfaceMcp}
        </button>
      </div>
      <StoreBrowser key={surface} kind={kind} fixedCategory={fixedCategory} copy={copy} locale={locale} deepLinkTarget={deepLinkTarget} />
    </div>
  )
}
