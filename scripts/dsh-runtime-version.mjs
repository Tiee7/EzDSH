import { execFileSync } from 'node:child_process'

// The runtime shipped by EzDSH is built from the vendored upstream workspace.
// The packaged Runtime is built from the vendored upstream workspace. The
// same release is also pinned in the root npm dependencies for development
// and source-build prerequisites.
export const PINNED_DSH_RUNTIME_VERSION = '0.1.3-alpha.2'
export const PINNED_DSH_SOURCE_COMMIT = '82a5fd61a7cf5c293cec4bdff68f455398d685e9'
export const PUBLISHED_DSH_PACKAGE_VERSION = '0.1.3-alpha.2'

export function assertPinnedDshRuntimeVersion(label, actualVersion) {
  if (actualVersion !== PINNED_DSH_RUNTIME_VERSION) {
    throw new Error(
      `${label} must use @deepseek-ai/dsh@${PINNED_DSH_RUNTIME_VERSION}; found ${String(actualVersion)}`
    )
  }
}

export function assertPinnedDshSourceCommit(label, actualCommit) {
  if (actualCommit !== PINNED_DSH_SOURCE_COMMIT) {
    throw new Error(
      `${label} must use DeepSeek Harness commit ${PINNED_DSH_SOURCE_COMMIT}; found ${String(actualCommit)}`
    )
  }
}

export function assertPinnedDshSourceCheckout(sourceRoot) {
  const actualCommit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assertPinnedDshSourceCommit(`vendored DeepSeek Harness checkout at ${sourceRoot}`, actualCommit)
  return actualCommit
}
