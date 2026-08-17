import { describe, expect, it } from 'vitest'
import { providerBadge, updateAction } from '../../src/renderer/settings/settings-display.js'
import type { ProviderStatus } from '../../src/shared/providers.js'

const status = (overrides: Partial<ProviderStatus> = {}): ProviderStatus => ({
  providerId: 'deepseek',
  hasCredential: false,
  routeConfigured: false,
  usable: false,
  ...overrides
})

describe('providerBadge', () => {
  it('returns empty for missing status', () => {
    expect(providerBadge(undefined)).toBe('empty')
  })

  it('returns empty when nothing is configured', () => {
    expect(providerBadge(status())).toBe('empty')
  })

  it('returns configured only when a route is configured', () => {
    expect(providerBadge(status({ hasCredential: true }))).toBe('empty')
    expect(providerBadge(status({ routeConfigured: true }))).toBe('configured')
  })

  it('returns usable when usable', () => {
    expect(providerBadge(status({ hasCredential: true, usable: true }))).toBe('usable')
  })
})

describe('updateAction', () => {
  it('maps idle and up-to-date to check', () => {
    expect(updateAction('idle')).toBe('check')
    expect(updateAction('up-to-date')).toBe('check')
  })

  it('maps available to download', () => {
    expect(updateAction('available')).toBe('download')
  })

  it('maps busy phases to none', () => {
    expect(updateAction('checking')).toBe('none')
    expect(updateAction('downloading')).toBe('none')
    expect(updateAction('installing')).toBe('none')
  })

  it('maps downloaded to install and failed to retry', () => {
    expect(updateAction('downloaded')).toBe('install')
    expect(updateAction('failed')).toBe('retry')
  })
})
