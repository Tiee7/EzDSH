/** Top-level tabs shared by the renderer tab bar, the preload bridge, and the native application menu. */
export const APP_TABS = ['harness', 'store', 'presets', 'settings'] as const

/** One top-level navigation target. */
export type AppTab = (typeof APP_TABS)[number]

/** Return whether `value` is a valid {@link AppTab}. */
export function isAppTab(value: unknown): value is AppTab {
  return (APP_TABS as readonly unknown[]).includes(value)
}
