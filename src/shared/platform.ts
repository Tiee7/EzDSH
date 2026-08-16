/** Runtime platforms EzDSH cares about for UI layout decisions. */
export type AppPlatform = 'darwin' | 'win32' | 'linux'

/** Return whether `value` is a supported platform string. */
export function isAppPlatform(value: unknown): value is AppPlatform {
  return value === 'darwin' || value === 'win32' || value === 'linux'
}
