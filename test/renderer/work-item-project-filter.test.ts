import { describe, expect, it } from 'vitest'
import type { WorkTaskSnapshot } from '../../src/shared/work-items.js'
import { filterWorkItemsByProject, workItemProjectOptions } from '../../src/renderer/work-items/work-item-project-filter.js'

function snapshot(id: string, projectId?: string): WorkTaskSnapshot {
  return {
    task: {
      id,
      revision: 1,
      title: id,
      scope: { ...(projectId === undefined ? {} : { projectId }), resourceRefs: [] },
      requirements: [{ version: 1, goal: id, acceptance: '完成', createdAt: '2026-09-15T09:00:00.000Z' }],
      currentRequirementVersion: 1,
      status: 'open',
      acceptedArtifactIds: [],
      createdAt: '2026-09-15T09:00:00.000Z',
      updatedAt: '2026-09-15T10:00:00.000Z',
    },
    attempts: [],
    runs: [],
    artifacts: [],
    actions: [],
  }
}

describe('work-item project filter model', () => {
  const assigned = snapshot('assigned', 'project-1')
  const other = snapshot('other', 'project-2')
  const unassigned = snapshot('unassigned')

  it('includes assigned and unassigned work items in the all filter', () => {
    expect(filterWorkItemsByProject([assigned, unassigned], { kind: 'all' })).toEqual([assigned, unassigned])
  })

  it('selects only work items without a project in the unassigned filter', () => {
    expect(filterWorkItemsByProject([assigned, unassigned], { kind: 'unassigned' })).toEqual([unassigned])
  })

  it('selects only the requested project', () => {
    expect(filterWorkItemsByProject([assigned, other, unassigned], { kind: 'project', projectId: 'project-2' })).toEqual([other])
  })

  it('enriches observed projects from the directory and retains disappeared projects as orphan options', () => {
    expect(workItemProjectOptions(
      [assigned, other],
      [{ projectId: 'project-1', title: '项目一', path: '/work/project-1' }],
    )).toEqual([
      { projectId: 'project-1', title: '项目一', path: '/work/project-1', orphaned: false },
      { projectId: 'project-2', title: 'project-2', orphaned: true },
    ])
  })

  it('keeps duplicate directory titles distinguishable by project id data', () => {
    expect(workItemProjectOptions(
      [assigned, other],
      [
        { projectId: 'project-1', title: '同名项目' },
        { projectId: 'project-2', title: '同名项目' },
      ],
    )).toEqual([
      { projectId: 'project-1', title: '同名项目', orphaned: false },
      { projectId: 'project-2', title: '同名项目', orphaned: false },
    ])
  })
})
