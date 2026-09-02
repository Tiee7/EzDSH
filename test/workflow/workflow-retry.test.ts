import { describe, expect, it } from 'vitest'
import { planWorkflowRetry } from '../../src/main/workflow/workflow-retry.js'
import type { WorkflowNode, WorkflowNodeRunState } from '../../src/shared/workflow.js'

function node(type: WorkflowNode['type'], retryPolicy: NonNullable<WorkflowNode['retryPolicy']>): WorkflowNode {
  return { id: type, type, label: type, config: type === 'transform' ? { template: 'identity' } : type === 'http' ? { method: 'GET', url: 'https://example.com', headers: {}, responseMode: 'text' } : {}, position: { x: 0, y: 0 }, retryPolicy } as WorkflowNode
}

function state(attempt = 1): WorkflowNodeRunState {
  return { nodeId: 'node', status: 'running', attempt }
}

describe('workflow retry policy', () => {
  it('plans exponential retry only for deterministic nodes', () => {
    const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0 }
    const plan = planWorkflowRetry(node('transform', policy), state(1), new Error('temporary local failure'))

    expect(plan).toEqual({ decision: 'retry', nextAttempt: 2, delayMs: 100, classification: 'transient' })
  })

  it('stops on permanent errors and never replays an external effect', () => {
    const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0 }
    const invalid = planWorkflowRetry(node('transform', policy), state(1), Object.assign(new Error('权限不足'), { name: 'PermissionError' }))
    const http = planWorkflowRetry(node('http', policy), state(1), new Error('temporary network failure'))

    expect(invalid.decision).toBe('fail')
    expect(invalid.classification).toBe('permanent')
    expect(http.decision).toBe('pause')
    expect(http.classification).toBe('ambiguous')
  })

  it('allows bounded retry only for a managed HTTP node with idempotent mode', () => {
    const policy = { mode: 'idempotent' as const, maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0 }
    const managed = {
      id: 'http', type: 'http', label: 'http',
      config: { method: 'POST', connectorId: 'api', connectorPath: '/items', url: '', headers: {}, responseMode: 'json' },
      position: { x: 0, y: 0 }, retryPolicy: policy,
    } as WorkflowNode
    expect(planWorkflowRetry(managed, state(1), new Error('连接器请求失败'))).toMatchObject({ decision: 'retry', nextAttempt: 2, delayMs: 100 })
  })

  it('caps attempts and applies exponential backoff ceiling', () => {
    const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 150, jitterRatio: 0 }
    const second = planWorkflowRetry(node('transform', policy), state(2), new Error('temporary'))
    const exhausted = planWorkflowRetry(node('transform', policy), state(3), new Error('temporary'))

    expect(second).toMatchObject({ decision: 'retry', nextAttempt: 3, delayMs: 150 })
    expect(exhausted.decision).toBe('fail')
  })
})
