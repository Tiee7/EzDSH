import { navigationShortcutItems, type NavConfig, type NavigationTarget } from '../../shared/navigation.js'

export interface NavigationShortcutInput {
  type: string
  key: string
  code: string
  isAutoRepeat: boolean
  isComposing: boolean
  shift: boolean
  control: boolean
  alt: boolean
  meta: boolean
}

export type NavigationShortcutPlatform = NodeJS.Platform

export function getNavigationTargetForInput(
  input: NavigationShortcutInput,
  config: NavConfig,
  platform: NavigationShortcutPlatform
): NavigationTarget | undefined {
  if (input.type !== 'keyDown' || input.isComposing || input.isAutoRepeat || input.shift || input.alt) {
    return undefined
  }

  const isMac = platform === 'darwin'
  const modifierPressed = isMac ? input.meta : input.control
  const unexpectedModifierPressed = isMac ? input.control : input.meta
  if (!modifierPressed || unexpectedModifierPressed) return undefined

  const keyMatch = /^[0-9]$/.exec(input.key) ?? /^Digit([0-9])$/.exec(input.code)
  if (keyMatch === null) return undefined
  const digit = Number(keyMatch[1] ?? keyMatch[0])
  if (digit === 0) return 'settings'
  return navigationShortcutItems(config)[digit - 1]?.id
}
