import { describe, expect, it } from 'vitest'
import { attentionGroup } from '../../src/renderer/work-items/work-item-attention-model.js'
import type { WorkAction, WorkArtifact, WorkRunRef, WorkTaskSnapshot } from '../../src/shared/work-items.js'

function snapshot(overrides: Partial<WorkTaskSnapshot> = {}): WorkTaskSnapshot {
  return {
    task: {
      id: 'task-1',
      revision: 4,
      title: 'Prepare release notes',
      scope: { resourceRefs: [] },
      requirements: [{ version: 2, goal: 'Prepare notes', acceptance: 'Accurate', createdAt: '2026-09-15T09:00:00.000Z' }],
      currentRequirementVersion: 2,
      status: 'active',
      acceptedArtifactIds: [],
      createdAt: '2026-09-15T09:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
    },
    attempts: [],
    runs: [],
    artifacts: [],
    actions: [],
    ...overrides,
  }
}

function run(status: WorkRunRef['status'], observedAt: string, overrides: Partial<WorkRunRef> = {}): WorkRunRef {
  return {
    taskId: 'task-1',
    attemptId: 'attempt-1',
    runId: `run-${status}-${observedAt}`,
    executor: { kind: 'workflow', workflowId: 'release' },
    commandId: 'command-1',
    requirementVersion: 2,
    status,
    rawStatus: status,
    observedAt,
    capabilities: { cancel: false, resume: false, append: false },
    ...overrides,
  }
}

function artifact(id: string, requirementVersion = 2): WorkArtifact {
  return {
    id,
    taskId: 'task-1',
    attemptId: 'attempt-1',
    runId: 'run-1',
    requirementVersion,
    contentVersion: 1,
    contentHash: 'hash',
    kind: 'text',
    name: `${id}.md`,
    storedPath: `/${id}.md`,
    createdAt: '2026-09-15T10:00:00.000Z',
  }
}

function action(overrides: Partial<WorkAction> = {}): WorkAction {
  return {
    id: 'action-1',
    taskId: 'task-1',
    runId: 'run-1',
    sourceEventId: 'event-1',
    requirementVersion: 2,
    kind: 'approval',
    status: 'open',
    ...overrides,
  }
}

describe('attentionGroup', () => {
  it('gives an open action priority over review, running, failure, and completion evidence', () => {
    const currentArtifact = artifact('draft')
    const value = snapshot({
      task: { ...snapshot().task, status: 'completed', acceptedArtifactIds: [currentArtifact.id] },
      actions: [action()],
      artifacts: [currentArtifact, artifact('candidate')],
      runs: [run('running', '2026-09-15T12:00:00.000Z'), run('failed', '2026-09-15T13:00:00.000Z')],
    })

    expect(attentionGroup(value)).toBe('needs-action')
  })

  it('puts any unaccepted current-requirement candidate in review before run state', () => {
    const accepted = artifact('accepted')
    const candidate = artifact('candidate')
    const value = snapshot({
      task: { ...snapshot().task, status: 'completed', acceptedArtifactIds: [accepted.id] },
      artifacts: [accepted, candidate, artifact('old-draft', 1)],
      runs: [run('running', '2026-09-15T12:00:00.000Z')],
    })

    expect(attentionGroup(value)).toBe('review')
  })

  it.each(['queued', 'running', 'waiting', 'paused', 'cancelling'] as const)(
    'treats a %s run as in progress even when an older run failed',
    (status) => {
      const accepted = artifact('accepted')
      expect(attentionGroup(snapshot({
        task: { ...snapshot().task, status: 'completed', acceptedArtifactIds: [accepted.id] },
        artifacts: [accepted],
        runs: [run('failed', '2026-09-15T10:00:00.000Z'), run(status, '2026-09-15T11:00:00.000Z')],
      }))).toBe('in-progress')
    },
  )

  it.each(['failed', 'interrupted'] as const)(
    'reports %s when the newest failure has no later successful run',
    (status) => {
      const accepted = artifact('accepted')
      expect(attentionGroup(snapshot({
        task: { ...snapshot().task, status: 'completed', acceptedArtifactIds: [accepted.id] },
        artifacts: [accepted],
        runs: [run('completed', '2026-09-15T10:00:00.000Z'), run(status, '2026-09-15T11:00:00.000Z')],
      }))).toBe('failed')
    },
  )

  it('does not keep a recovered failure in failed after a later completed run', () => {
    const accepted = artifact('accepted')
    expect(attentionGroup(snapshot({
      task: { ...snapshot().task, status: 'completed', acceptedArtifactIds: [accepted.id] },
      artifacts: [accepted],
      runs: [run('interrupted', '2026-09-15T10:00:00.000Z'), run('completed', '2026-09-15T11:00:00.000Z')],
    }))).toBe('completed')
  })

  it('requires an accepted artifact to belong to the current requirement, while explicit task completion is sufficient', () => {
    const oldAccepted = artifact('old-accepted', 1)
    expect(attentionGroup(snapshot({
      task: { ...snapshot().task, acceptedArtifactIds: [oldAccepted.id] },
      artifacts: [oldAccepted],
    }))).toBe('needs-action')

    expect(attentionGroup(snapshot({
      task: { ...snapshot().task, status: 'completed' },
    }))).toBe('completed')
  })

  it('does not mirror a coarse review or active task status without current evidence', () => {
    expect(attentionGroup(snapshot({ task: { ...snapshot().task, status: 'review' } }))).toBe('needs-action')
    expect(attentionGroup(snapshot({ task: { ...snapshot().task, status: 'active' } }))).toBe('needs-action')
  })
})
