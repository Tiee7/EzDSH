export const SETTINGS_TAB_IDS = ['general', 'notifications', 'recovery', 'sessions', 'remote-control', 'navigation', 'proxy', 'external-services'] as const
export type SettingsTab = (typeof SETTINGS_TAB_IDS)[number]
