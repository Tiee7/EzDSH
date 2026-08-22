import { useEffect, useState } from 'react'
import type { AppCopy, AppLocale } from '../../shared/locale.js'
import type { DeepLinkInstallTarget } from '../../shared/contracts.js'
import type { StoreKind } from '../../shared/store.js'
import { StoreBrowser } from './StoreBrowser.js'

interface StorePageProps {
  copy: AppCopy
  locale: AppLocale
  deepLinkTarget?: DeepLinkInstallTarget
}

/** The store tab page: skill bundles and MCP tool extensions side by side. */
export function StorePage({ copy, locale, deepLinkTarget }: StorePageProps): JSX.Element {
  const [surface, setSurface] = useState<StoreKind>('skill')
  useEffect(() => {
    if (deepLinkTarget !== undefined) {
      setSurface(deepLinkTarget.kind)
    }
  }, [deepLinkTarget])
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
          aria-selected={surface === 'mcp'}
          className={`surface-tab ${surface === 'mcp' ? 'surface-tab-active' : ''}`}
          onClick={() => { setSurface('mcp') }}
        >
          {copy.storeSurfaceMcp}
        </button>
      </div>
      <StoreBrowser key={surface} kind={surface} copy={copy} locale={locale} deepLinkTarget={deepLinkTarget} />
    </div>
  )
}
