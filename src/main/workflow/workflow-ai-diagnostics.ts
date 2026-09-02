import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { WorkflowModelSelection } from '../../shared/workflow.js'

export type WorkflowAiTaskKind = 'generation' | 'modification'

export interface WorkflowAiDiagnosticEvent {
  phase: string
  status: string
  message: string
  time: string
}

export interface WorkflowAiDiagnosticFailure {
  kind: WorkflowAiTaskKind
  taskId: string
  prompt: string
  phase: string
  startedAt: string
  failedAt: string
  model?: WorkflowModelSelection
  sessionId?: string
  workflowId?: string
  error: unknown
  events?: readonly WorkflowAiDiagnosticEvent[]
  source?: 'model-output' | 'model-service' | 'runtime' | 'ezdsh' | 'unknown'
  rawModelOutput?: string
  checkpointModelOutput?: string
}

export interface WorkflowAiDiagnosticWriteResult {
  path: string
  written: boolean
  writeError?: string
}

const MAX_CAPTURED_TEXT = 100_000

/**
 * Writes one append-only, task-correlated diagnostic stream for AI workflow
 * generation and modification. Secrets are never passed to this class.
 */
export class WorkflowAiDiagnostics {
  private readonly logDirectory: string

  constructor(logDirectory: string) {
    this.logDirectory = resolve(logDirectory)
  }

  getLogPath(kind: WorkflowAiTaskKind, taskId: string): string {
    return join(this.logDirectory, 'workflow-ai', `${kind}-${safeFilePart(taskId)}.log`)
  }

  async recordFailure(input: WorkflowAiDiagnosticFailure): Promise<WorkflowAiDiagnosticWriteResult> {
    const path = this.getLogPath(input.kind, input.taskId)
    const error = serializeError(input.error)
    const errorRawModelOutput = rawModelOutputFromError(input.error)
    const rawModelOutput = input.rawModelOutput ?? errorRawModelOutput
    const entry = {
      formatVersion: 1,
      recordedAt: new Date().toISOString(),
      kind: input.kind,
      taskId: input.taskId,
      workflowId: input.workflowId,
      source: input.source ?? (errorRawModelOutput === undefined ? 'unknown' : 'model-output'),
      phase: input.phase,
      startedAt: input.startedAt,
      failedAt: input.failedAt,
      model: input.model,
      sessionId: input.sessionId,
      prompt: captureText(input.prompt, 8_000),
      error,
      jsonParseAttempt: parseAttemptFromError(input.error),
      rawModelOutput: rawModelOutput === undefined ? undefined : captureText(rawModelOutput, MAX_CAPTURED_TEXT),
      checkpointModelOutput: input.checkpointModelOutput === undefined ? undefined : captureText(input.checkpointModelOutput, MAX_CAPTURED_TEXT),
      events: input.events,
    }

    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await appendFile(path, `${JSON.stringify(entry, null, 2)}\n\n`, { mode: 0o600 })
      return { path, written: true }
    } catch (writeError) {
      return { path, written: false, writeError: errorMessage(writeError) }
    }
  }
}

export function formatWorkflowAiFailureMessage(error: unknown, diagnostic: WorkflowAiDiagnosticWriteResult | undefined): string {
  const message = errorMessage(error)
  const prefix = rawModelOutputFromError(error) === undefined
    ? 'AI 工作流任务失败'
    : 'AI 输出 JSON 解析失败'
  if (diagnostic === undefined) return `${prefix}：${message}`
  if (diagnostic.written) return `${prefix}：${message}。详细错误日志：${diagnostic.path}`
  return `${prefix}：${message}。详细错误日志写入失败（${diagnostic.writeError ?? '未知原因'}），预期地址：${diagnostic.path}`
}

export function withWorkflowAiFailureMessage(error: unknown, message: string): Error {
  const enriched = new Error(message)
  if (error instanceof Error) enriched.name = error.name
  return enriched
}

function safeFilePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 120)
  return safe === '' ? 'task' : safe
}

function captureText(value: string, limit: number): { text: string; originalLength: number; truncated: boolean } {
  return { text: value.slice(0, limit), originalLength: value.length, truncated: value.length > limit }
}

function rawModelOutputFromError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const rawText = (error as { rawText?: unknown }).rawText
  return typeof rawText === 'string' ? rawText : undefined
}

function parseAttemptFromError(error: unknown): 'document' | 'embedded-document' | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const parseAttempt = (error as { parseAttempt?: unknown }).parseAttempt
  return parseAttempt === 'document' || parseAttempt === 'embedded-document' ? parseAttempt : undefined
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...serializeCause(error),
    }
  }
  return { name: 'UnknownError', message: String(error) }
}

function serializeCause(error: Error): { cause?: { name: string; message: string; stack?: string } } {
  const cause = (error as Error & { causeError?: unknown }).causeError
  if (cause === undefined) return {}
  if (cause instanceof Error) {
    return {
      cause: {
        name: cause.name,
        message: cause.message,
        ...(cause.stack === undefined ? {} : { stack: cause.stack }),
      },
    }
  }
  return { cause: { name: 'UnknownError', message: String(cause) } }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
