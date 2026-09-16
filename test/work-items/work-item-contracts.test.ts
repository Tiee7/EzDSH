import { describe, expect, it } from 'vitest'
import {
  WorkItemValidationError,
  canAcceptWorkArtifact,
  validateWorkTaskCancelRequest,
  validateWorkTaskArchiveRequest,
  validateWorkTaskCreateRequest,
  validateWorkTaskExecuteRequest
} from '../../src/shared/work-items'
import { workArtifactFixture, workTaskFixture } from './fixtures'

const expectInvalid = (fn: () => unknown, code: string, path: string): void => {
  try {
    fn()
    throw new Error('Expected validation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(WorkItemValidationError)
    expect(error).toMatchObject({ code, path })
  }
}

describe('validateWorkTaskCreateRequest', () => {
  const validRequest = () => ({
    requestId: 'request-1',
    title: 'Release notes',
    goal: 'Summarize the release',
    acceptance: 'Every user-visible change is covered',
    scope: { resourceRefs: [] }
  })

  it.each([null, [], 'request', 42])('rejects a non-object request: %j', (value) => {
    expectInvalid(() => validateWorkTaskCreateRequest(value), 'INVALID_TYPE', '$')
  })

  it('rejects a blank goal', () => {
    expectInvalid(
      () => validateWorkTaskCreateRequest({ ...validRequest(), goal: ' \n\t ' }),
      'EMPTY_STRING',
      'goal'
    )
  })

  it('accepts an explicitly projectless scope without inventing a project', () => {
    expect(validateWorkTaskCreateRequest(validRequest())).toEqual(validRequest())
  })

  it('trims boundary whitespace while preserving deliberate internal whitespace', () => {
    const result = validateWorkTaskCreateRequest({
      ...validRequest(),
      requestId: '  request-1  ',
      title: '  Release   notes  ',
      goal: '\n Summarize  the release \t',
      scope: { cwd: '  /tmp/ezdsh-work-items  ', resourceRefs: ['  synthetic:item  '] }
    })

    expect(result).toMatchObject({
      requestId: 'request-1',
      title: 'Release   notes',
      goal: 'Summarize  the release',
      scope: { cwd: '/tmp/ezdsh-work-items', resourceRefs: ['synthetic:item'] }
    })
  })

  it('preserves multiline requirement prose and accepts a Windows cwd', () => {
    const result = validateWorkTaskCreateRequest({
      ...validRequest(),
      goal: 'First line\n\nSecond line',
      acceptance: 'One\r\nTwo',
      scope: { cwd: 'C:\\work\\ezdsh', resourceRefs: [] }
    })

    expect(result.goal).toBe('First line\n\nSecond line')
    expect(result.acceptance).toBe('One\r\nTwo')
    expect(result.scope.cwd).toBe('C:\\work\\ezdsh')
  })

  it('rejects control characters in identifiers', () => {
    expectInvalid(
      () => validateWorkTaskCreateRequest({ ...validRequest(), requestId: 'request\nforged' }),
      'INVALID_VALUE',
      'requestId'
    )
  })

  it('rejects resource refs duplicated after whitespace normalization', () => {
    expectInvalid(
      () => validateWorkTaskCreateRequest({
        ...validRequest(), scope: { resourceRefs: ['synthetic:item', ' synthetic:item '] }
      }),
      'DUPLICATE_VALUE',
      'scope.resourceRefs[1]'
    )
  })

  it('rejects sparse resource ref arrays', () => {
    const resourceRefs = new Array<string>(1)
    expectInvalid(
      () => validateWorkTaskCreateRequest({ ...validRequest(), scope: { resourceRefs } }),
      'INVALID_TYPE',
      'scope.resourceRefs[0]'
    )
  })

  it('enforces explicit prose and collection limits', () => {
    expectInvalid(
      () => validateWorkTaskCreateRequest({ ...validRequest(), title: 'x'.repeat(201) }),
      'STRING_TOO_LONG',
      'title'
    )
    expectInvalid(
      () => validateWorkTaskCreateRequest({
        ...validRequest(), scope: { resourceRefs: Array.from({ length: 101 }, (_, index) => `ref-${index}`) }
      }),
      'COLLECTION_TOO_LARGE',
      'scope.resourceRefs'
    )
  })

  it('rejects unknown top-level and scope configuration fields', () => {
    expectInvalid(
      () => validateWorkTaskCreateRequest({ ...validRequest(), authorization: { admin: true } }),
      'UNKNOWN_FIELD',
      'authorization'
    )
    expectInvalid(
      () => validateWorkTaskCreateRequest({ ...validRequest(), scope: { resourceRefs: [], grants: ['shell'] } }),
      'UNKNOWN_FIELD',
      'scope.grants'
    )
  })
})

describe('validateWorkTaskArchiveRequest', () => {
  const validRequest = () => ({
    requestId: 'archive-1',
    taskId: 'task-1',
    expectedRevision: 2,
    archived: true,
  })

  it('normalizes identities and accepts archive and restore requests', () => {
    expect(validateWorkTaskArchiveRequest({
      ...validRequest(),
      requestId: ' archive-1 ',
      taskId: ' task-1 ',
    })).toEqual(validRequest())
    expect(validateWorkTaskArchiveRequest({ ...validRequest(), archived: false }).archived).toBe(false)
  })

  it('rejects non-boolean archive state and unknown fields', () => {
    expectInvalid(
      () => validateWorkTaskArchiveRequest({ ...validRequest(), archived: 'yes' }),
      'INVALID_TYPE',
      'archived'
    )
    expectInvalid(
      () => validateWorkTaskArchiveRequest({ ...validRequest(), force: true }),
      'UNKNOWN_FIELD',
      'force'
    )
  })
})

describe('validateWorkTaskCancelRequest', () => {
  const validRequest = () => ({
    requestId: 'cancel-task-1',
    taskId: 'task-1',
    expectedRevision: 3,
  })

  it('normalizes the durable request identity and revision', () => {
    expect(validateWorkTaskCancelRequest({
      ...validRequest(),
      requestId: ' cancel-task-1 ',
      taskId: ' task-1 ',
    })).toEqual(validRequest())
  })

  it('rejects an invalid revision and unknown fields', () => {
    expectInvalid(
      () => validateWorkTaskCancelRequest({ ...validRequest(), expectedRevision: 0 }),
      'INVALID_INTEGER',
      'expectedRevision'
    )
    expectInvalid(
      () => validateWorkTaskCancelRequest({ ...validRequest(), force: true }),
      'UNKNOWN_FIELD',
      'force'
    )
  })
})

describe('validateWorkTaskExecuteRequest', () => {
  const validRequest = () => ({
    requestId: 'request-2',
    taskId: 'task-1',
    expectedRevision: 2,
    executor: { kind: 'employee' as const, employeeId: 'employee-1' },
    mode: 'initial' as const,
    input: { prompt: 'Draft it' }
  })

  it.each([null, [], false, 'request'])('rejects a non-object request: %j', (value) => {
    expectInvalid(() => validateWorkTaskExecuteRequest(value), 'INVALID_TYPE', '$')
  })

  it('rejects an absent taskId', () => {
    const { taskId: _taskId, ...request } = validRequest()
    expectInvalid(() => validateWorkTaskExecuteRequest(request), 'MISSING_FIELD', 'taskId')
  })

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1, -1])('rejects invalid expectedRevision %s', (revision) => {
    expectInvalid(
      () => validateWorkTaskExecuteRequest({ ...validRequest(), expectedRevision: revision }),
      'INVALID_INTEGER',
      'expectedRevision'
    )
  })

  it('accepts employee and workflow executors with their distinct identities', () => {
    expect(validateWorkTaskExecuteRequest(validRequest()).executor).toEqual({
      kind: 'employee', employeeId: 'employee-1'
    })
    expect(validateWorkTaskExecuteRequest({
      ...validRequest(),
      executor: { kind: 'workflow', workflowId: 'workflow-1', workflowRevision: 3 }
    }).executor).toEqual({ kind: 'workflow', workflowId: 'workflow-1', workflowRevision: 3 })
  })

  it('rejects executor identity mixing and forged authorization configuration', () => {
    expectInvalid(
      () => validateWorkTaskExecuteRequest({
        ...validRequest(), executor: { kind: 'employee', employeeId: 'employee-1', workflowId: 'workflow-1' }
      }),
      'UNKNOWN_FIELD',
      'executor.workflowId'
    )
    expectInvalid(
      () => validateWorkTaskExecuteRequest({ ...validRequest(), permissions: ['filesystem'] }),
      'UNKNOWN_FIELD',
      'permissions'
    )
    expectInvalid(
      () => validateWorkTaskExecuteRequest({
        ...validRequest(), executor: { kind: 'workflow', workflowId: 'workflow-1', authorized: true }
      }),
      'UNKNOWN_FIELD',
      'executor.authorized'
    )
  })

  it('keeps opaque workflow input as data even when it contains privilege-like fields', () => {
    const input = { authorization: { admin: true }, grants: ['filesystem'] }
    expect(validateWorkTaskExecuteRequest({ ...validRequest(), input }).input).toBe(input)
  })
})

describe('canAcceptWorkArtifact', () => {
  it('accepts a current artifact for the same non-cancelled task', () => {
    expect(canAcceptWorkArtifact(workTaskFixture(), workArtifactFixture())).toBe(true)
  })

  it('rejects an artifact from a stale requirement version', () => {
    expect(canAcceptWorkArtifact(
      workTaskFixture({ currentRequirementVersion: 3 }),
      workArtifactFixture({ requirementVersion: 2 })
    )).toBe(false)
  })

  it('rejects a different task identity or a cancelled task', () => {
    expect(canAcceptWorkArtifact(workTaskFixture(), workArtifactFixture({ taskId: 'task-2' }))).toBe(false)
    expect(canAcceptWorkArtifact(workTaskFixture({ status: 'cancelled' }), workArtifactFixture())).toBe(false)
  })
})
