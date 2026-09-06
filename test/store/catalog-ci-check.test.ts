import { describe, expect, it } from 'vitest'
import { checkCatalogPayload } from '../../scripts/check-store-catalog.mjs'

const verified = {
  status: 'passed',
  checkedAt: '2026-09-05T00:00:00.000Z',
  source: 'npm:example-plugin@1.0.0',
  dshVersion: '0.1.2-rc.1',
  pnpmVersion: '11.7.0',
  packageName: 'example-plugin'
}

describe('checkCatalogPayload', () => {
  it('accepts a plugin with passed install verification', () => {
    expect(checkCatalogPayload([{
      id: 'example-plugin', kind: 'skill', category: 'plugin',
      plugin: { source: 'npm:example-plugin@1.0.0', packageName: 'example-plugin', verification: verified }
    }])).toEqual([])
  })

  it('does not require Hub-side install verification for third-party plugins', () => {
    const errors = checkCatalogPayload([{
      id: 'example-plugin', kind: 'skill', category: 'plugin',
      plugin: { source: 'npm:example-plugin@1.0.0', packageName: 'example-plugin' }
    }])

    expect(errors).toEqual([])
  })
})
