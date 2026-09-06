import { execFileSync } from 'node:child_process'

// The runtime shipped by EzDSH is built from the vendored upstream workspace.
// 0.1.3-alpha.1 is currently available from upstream master but is not yet
// published to npm, so it must not be used as a registry dependency.
export const PINNED_DSH_RUNTIME_VERSION = '0.1.3-alpha.1'
export const PINNED_DSH_SOURCE_COMMIT = 'd347e703908d0406b7a7ef80e3a0e594d86b2215'
export const PUBLISHED_DSH_PACKAGE_VERSION = '0.1.2-rc.1'

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
