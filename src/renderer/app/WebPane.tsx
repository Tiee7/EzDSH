import type { CustomNavItem } from '../../shared/navigation.js'
import { RUNTIME_IFRAME_ALLOW, RUNTIME_IFRAME_SANDBOX } from './runtime-frame.js'

interface WebPaneProps {
  item: CustomNavItem
  active: boolean
}

/** Embedded web page for a custom navigation tab; stays mounted across tab switches. */
export function WebPane({ item, active }: WebPaneProps): JSX.Element {
  return (
    <div className={`workspace-pane ${active ? 'workspace-pane-active' : ''}`}>
      <div className="web-pane">
        <iframe
          title={item.label}
          src={item.url}
          allow={RUNTIME_IFRAME_ALLOW}
          sandbox={RUNTIME_IFRAME_SANDBOX}
        />
      </div>
    </div>
  )
}