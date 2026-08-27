import { describe, expect, it } from 'vitest'
import { assessPluginCompatibility, compareDshVersions } from '../../src/main/store/compatibility'

describe('DSH plugin compatibility', () => {
  it.each([
    ['0.6.0', { minDshVersion: '0.5.0', maxDshVersion: '0.6.9' }, 'compatible'],
    ['0.4.9', { minDshVersion: '0.5.0' }, 'incompatible'],
    ['0.7.0-rc.1', { maxDshVersion: '0.6.9' }, 'incompatible'],
    ['0.6.0', undefined, 'unknown'],
  ] as const)('assesses runtime %s', (runtime, limits, status) => {
    expect(assessPluginCompatibility(runtime, limits).status).toBe(status)
  })

  it('orders a stable release after its same-number prerelease', () => {
    expect(compareDshVersions('0.6.0', '0.6.0-rc.2')).toBeGreaterThan(0)
    expect(compareDshVersions('0.6.0-rc.2', '0.6.0-rc.10')).toBeLessThan(0)
  })
})
