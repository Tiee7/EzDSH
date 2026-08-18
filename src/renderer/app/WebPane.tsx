import { useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type { CustomNavItem } from '../../shared/navigation.js'
import { RUNTIME_IFRAME_ALLOW, RUNTIME_IFRAME_SANDBOX } from './runtime-frame.js'

interface WebPaneProps {
  item: CustomNavItem
  active: boolean
  copy: AppCopy
}

/** Embedded web page for a custom navigation tab; stays mounted across tab switches. */
export function WebPane({ item, active, copy }: WebPaneProps): JSX.Element {
  const [nonce, setNonce] = useState(0)
  return (
    <div className={`workspace-pane ${active ? 'workspace-pane-active' : ''}`}>
      <div className="web-pane">
        <div className="web-pane-toolbar">
          <button type="button" className="web-pane-reload" onClick={() => setNonce((n) => n + 1)}>
            {copy.navReload}
          </button>
        </div>
        <iframe
          key={`${item.id}:${nonce}`}
          title={item.label}
          src={item.url}
          allow={RUNTIME_IFRAME_ALLOW}
          sandbox={RUNTIME_IFRAME_SANDBOX}
        />
      </div>
    </div>
  )
}