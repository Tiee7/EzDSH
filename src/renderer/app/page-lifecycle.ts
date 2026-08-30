import type { NavigationTarget } from '../../shared/navigation.js'

/** Pages whose local UI state should survive navigation away and back. */
const PERSISTENT_TABS: readonly NavigationTarget[] = ['employees', 'workflow']

export function shouldKeepTabMounted(tab: NavigationTarget): boolean {
  return PERSISTENT_TABS.includes(tab)
}
