import type { ProviderStatus } from '../../shared/providers.js'
import type { UpdatePhase } from '../../shared/update.js'

/** Badge level for a provider row in settings. */
export type ProviderBadge = 'usable' | 'configured' | 'empty'

/** Map an optional provider status to its badge level. */
export function providerBadge(status?: ProviderStatus): ProviderBadge {
  if (status === undefined) return 'empty'
  if (status.usable) return 'usable'
  if (status.routeConfigured) return 'configured'
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
    case 'preparing':
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

/** Badge category for a discovered DSH Runtime process. */
export function runtimeProcessBadge(current: boolean, ownedByEzDSH: boolean): 'current' | 'owned' | 'external' {
  if (current) return 'current'
  return ownedByEzDSH ? 'owned' : 'external'
}

/** The active Runtime can only be restarted; other discovered processes can be stopped. */
export function runtimeProcessAction(current: boolean): 'restart' | 'stop' {
  return current ? 'restart' : 'stop'
}

/** Render a discovered port without hiding that the socket lookup was inconclusive. */
export function runtimeProcessPort(port: number | undefined, unavailable: string): string {
  return port === undefined ? unavailable : String(port)
}
