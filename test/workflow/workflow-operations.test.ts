import { describe, expect, it } from 'vitest'
import { normalizeWorkflowCustomerEnvironment } from '../../src/shared/workflow-operations.js'

describe('workflow operations contracts', () => {
  it('normalizes a customer environment without secrets and rejects invalid production policy', () => {
    expect(normalizeWorkflowCustomerEnvironment({
      id: 'customer-acme-prod', customerName: 'Acme', name: '生产', kind: 'production',
      status: 'active', connectorIds: ['crm'], allowShellFile: true,
    })).toBeUndefined()
  })
})
