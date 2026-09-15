import type { WorkArtifact, WorkTask } from '../../src/shared/work-items'

export const workTaskFixture = (overrides: Partial<WorkTask> = {}): WorkTask => ({
  id: 'task-1',
  revision: 2,
  title: 'Prepare release notes',
  scope: { resourceRefs: [] },
  requirements: [{
    version: 2,
    goal: 'Prepare the release notes',
    acceptance: 'The changes are accurately summarized',
    createdAt: '2026-09-15T00:00:00.000Z'
  }],
  currentRequirementVersion: 2,
  status: 'review',
  acceptedArtifactIds: [],
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  ...overrides
})

export const workArtifactFixture = (overrides: Partial<WorkArtifact> = {}): WorkArtifact => ({
  id: 'artifact-1',
  taskId: 'task-1',
  attemptId: 'attempt-1',
  runId: 'run-1',
  requirementVersion: 2,
  contentVersion: 1,
  contentHash: 'synthetic-hash',
  kind: 'text',
  name: 'release-notes.md',
  storedPath: '/tmp/ezdsh-work-items/release-notes.md',
  createdAt: '2026-09-15T00:01:00.000Z',
  ...overrides
})
