import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowInternalSessionStore } from '../../src/main/workflow/workflow-internal-session-store.js'

describe('workflow internal session store', () => {
  it('tracks only archived expired workflow sessions as safe cleanup candidates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-internal-sessions-'))
    const store = new WorkflowInternalSessionStore(dir)
    await store.register({ sessionId: 'employee-session', runId: 'run-1', workflowId: 'workflow-1', kind: 'employee', employeeId: 'reviewer', createdAt: '2026-08-01T00:00:00.000Z' })
    await store.register({ sessionId: 'live-session', runId: 'run-2', workflowId: 'workflow-1', kind: 'employee', employeeId: 'writer', createdAt: '2026-08-01T00:00:00.000Z' })
    await store.markArchived('employee-session', '2026-08-10T00:00:00.000Z', '2026-08-20T00:00:00.000Z')

    expect(store.expiredArchivedSessionIds(new Date('2026-08-30T00:00:00.000Z'))).toEqual(['employee-session'])
    await store.remove(['employee-session'])
    expect(store.list().map((session) => session.sessionId)).toEqual(['live-session'])
  })
})
