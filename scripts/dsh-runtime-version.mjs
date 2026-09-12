import { execFileSync } from 'node:child_process'

// The packaged Runtime is built from the vendored upstream workspace. The
// same release is also pinned in the root npm dependencies for development
// and source-build prerequisites.
export const PINNED_DSH_RUNTIME_VERSION = '0.1.5-rc.2'
export const PINNED_DSH_SOURCE_COMMIT = 'fb2c4b9e698e30edb738bca4cf0618587db7d203'
export const PUBLISHED_DSH_PACKAGE_VERSION = '0.1.5-rc.2'

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
