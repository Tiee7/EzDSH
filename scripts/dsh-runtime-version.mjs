import { execFileSync } from 'node:child_process'

// The packaged Runtime is built from the vendored upstream workspace. The
// same release is also pinned in the root npm dependencies for development
// and source-build prerequisites.
export const PINNED_DSH_RUNTIME_VERSION = '0.1.5-alpha.1'
export const PINNED_DSH_SOURCE_COMMIT = '5dda764ed3aa172535a7967b06ff95d9cbfe536a'
export const PUBLISHED_DSH_PACKAGE_VERSION = '0.1.5-alpha.1'

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
