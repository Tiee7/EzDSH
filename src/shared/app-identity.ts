import packageJson from '../../package.json' with { type: 'json' }

export const APP_NAME = 'EzDSH' as const
export const APP_VERSION = packageJson.version
