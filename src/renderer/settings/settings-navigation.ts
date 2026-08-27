export const SETTINGS_TAB_IDS = ['general', 'notifications', 'remote-control', 'navigation', 'external-services'] as const
export type SettingsTab = (typeof SETTINGS_TAB_IDS)[number]
