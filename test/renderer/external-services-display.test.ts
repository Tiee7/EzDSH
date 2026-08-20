import { describe, expect, it } from 'vitest'
import { normalizeExternalServiceCommand } from '../../src/renderer/settings/external-services-display.js'

describe('normalizeExternalServiceCommand', () => {
  it('accepts a common one-line npm command', () => {
    expect(normalizeExternalServiceCommand('npm run dev', [])).toEqual({
      command: 'npm',
      args: ['run', 'dev'],
    })
  })

  it('preserves quoted executable paths and explicit arguments', () => {
    expect(normalizeExternalServiceCommand('"/Applications/My App/bin/tool"', ['--watch'])).toEqual({
      command: '/Applications/My App/bin/tool',
      args: ['--watch'],
    })
  })
})
