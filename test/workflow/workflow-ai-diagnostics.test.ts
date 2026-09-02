import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { WorkflowAiDiagnostics } from '../../src/main/workflow/workflow-ai-diagnostics.js'
import { extractJsonDocument, WorkflowJsonParseError } from '../../src/main/workflow/dsh-workflow-adapter.js'

describe('WorkflowAiDiagnostics', () => {
  it('preserves malformed model output when JSON extraction fails', () => {
    const rawModelOutput = `{"name":"demo", 'invalid': true}`

    expect(() => extractJsonDocument(rawModelOutput)).toThrow(WorkflowJsonParseError)
    try {
      extractJsonDocument(rawModelOutput)
    } catch (error) {
      expect(error).toMatchObject({ rawText: rawModelOutput, parseAttempt: 'embedded-document' })
    }
  })

  it('writes an absolute, task-correlated log for malformed model JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-ai-diagnostics-'))
    const diagnostics = new WorkflowAiDiagnostics(join(directory, 'logs'))
    const error = new WorkflowJsonParseError(
      'Expected double-quoted property name in JSON at position 3753',
      "{ 'name': 'invalid' }",
      'embedded-document',
    )

    const result = await diagnostics.recordFailure({
      kind: 'generation',
      taskId: 'generation-debug-1',
      prompt: '生成一个工作流',
      phase: 'validating',
      startedAt: '2026-09-01T10:00:00.000Z',
      failedAt: '2026-09-01T10:00:03.000Z',
      model: { providerId: 'provider-a', modelId: 'model-a' },
      error,
      events: [{ phase: 'validating', status: 'running', message: '正在校验。', time: '2026-09-01T10:00:03.000Z' }],
    })

    expect(result.written).toBe(true)
    expect(isAbsolute(result.path)).toBe(true)
    const content = await readFile(result.path, 'utf8')
    expect(content).toContain('generation-debug-1')
    expect(content).toContain('model-output')
    expect(content).toContain('Expected double-quoted property name')
    expect(content).toContain("{ 'name': 'invalid' }")
    expect(content).toContain('provider-a')
    expect(content).toContain('model-a')
  })
})
