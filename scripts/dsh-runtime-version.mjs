export const PINNED_DSH_RUNTIME_VERSION = '0.1.2-rc.1'

export function assertPinnedDshRuntimeVersion(label, actualVersion) {
  if (actualVersion !== PINNED_DSH_RUNTIME_VERSION) {
    throw new Error(
      `${label} must use @deepseek-ai/dsh@${PINNED_DSH_RUNTIME_VERSION}; found ${String(actualVersion)}`
    )
  }
}
