import { isWorkflowValue } from '../../shared/workflow.js'
import type {
  WorkExecutor,
  WorkTaskCreateRequest,
  WorkTaskExecuteRequest,
  WorkTaskSnapshot,
} from '../../shared/work-items.js'

export type WorkItemCreateExecutor = { kind: 'none' } | WorkExecutor

export type WorkItemCreateExecutionDraft = Omit<
  WorkTaskExecuteRequest,
  'taskId' | 'expectedRevision'
>

export interface WorkItemCreateSubmissionInput {
  title: string
  goal: string
  acceptance: string
  projectId?: string
  cwd?: string
  executor: WorkItemCreateExecutor
  executionInput: unknown
  createRequestId: string
  executeRequestId: string
}

export interface WorkItemCreateSubmission {
  create: WorkTaskCreateRequest
  execute?: WorkItemCreateExecutionDraft
}

function required(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error(`${field} is required`)
  return normalized
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized === undefined || normalized === '' ? undefined : normalized
}

/**
 * Builds the two-step direct-creation submission without inventing the task
 * identity that only Main can assign after create succeeds.
 */
export function buildWorkItemCreateSubmission(
  input: WorkItemCreateSubmissionInput,
): WorkItemCreateSubmission {
  const projectId = optional(input.projectId)
  const cwd = optional(input.cwd)
  const create: WorkTaskCreateRequest = {
    requestId: required(input.createRequestId, 'createRequestId'),
    title: required(input.title, 'title'),
    goal: required(input.goal, 'goal'),
    acceptance: required(input.acceptance, 'acceptance'),
    scope: {
      ...(projectId === undefined ? {} : { projectId }),
      ...(cwd === undefined ? {} : { cwd }),
      resourceRefs: [],
    },
  }

  if (input.executor.kind === 'none') return { create }
  if (input.executor.kind === 'workflow' && !isWorkflowValue(input.executionInput)) {
    throw new Error('workflow executionInput must be a finite JSON-safe value')
  }

  return {
    create,
    execute: {
      requestId: required(input.executeRequestId, 'executeRequestId'),
      executor: { ...input.executor },
      mode: 'initial',
      input: input.executionInput,
    },
  }
}

/** Add the authoritative identity from create; this is the only finalization point. */
export function finalizeWorkItemCreateExecution(
  draft: WorkItemCreateExecutionDraft,
  created: WorkTaskSnapshot,
): WorkTaskExecuteRequest {
  return {
    ...draft,
    taskId: created.task.id,
    expectedRevision: created.task.revision,
  }
}
