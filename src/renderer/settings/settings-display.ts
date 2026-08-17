import type { ProviderStatus } from '../../shared/providers.js'
import type { UpdatePhase } from '../../shared/update.js'

/** Badge level for a provider row in settings. */
export type ProviderBadge = 'usable' | 'configured' | 'empty'

/** Map an optional provider status to its badge level. */
export function providerBadge(status?: ProviderStatus): ProviderBadge {
  if (status === undefined) return 'empty'
  if (status.usable) return 'usable'
  if (status.hasCredential || status.routeConfigured) return 'configured'
  return 'empty'
}

/** Primary action button for each update phase. */
export type UpdateAction = 'check' | 'download' | 'install' | 'retry' | 'none'

/** Map an update phase to the action the settings page should offer. */
export function updateAction(phase: UpdatePhase): UpdateAction {
  switch (phase) {
    case 'available':
      return 'download'
    case 'checking':
    case 'downloading':
    case 'installing':
      return 'none'
    case 'downloaded':
      return 'install'
    case 'failed':
      return 'retry'
    case 'idle':
    case 'up-to-date':
      return 'check'
  }
}
