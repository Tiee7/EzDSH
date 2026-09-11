import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import { computeWorkflowDefinitionSha256 } from '../../src/main/workflow/workflow-release-integrity.js'
import {
  deriveWorkflowLaunchFields,
  normalizeWorkflowLaunchInput,
  validateWorkflow,
  type WorkflowDefinition,
  type WorkflowInputField,
  type WorkflowValue,
} from '../../src/shared/workflow.js'
import type { WorkflowCustomerEnvironment, WorkflowRelease } from '../../src/shared/workflow-operations.js'

function definition(fields?: WorkflowInputField[]): WorkflowDefinition {
  return {
    schemaVersion: 2,
    id: 'workflow-launch-contract',
    name: 'Launch contract',
    description: '',
    revision: 1,
    enabled: true,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    nodes: [
      { id: 'input', type: 'input', label: 'Input', config: fields === undefined ? { name: 'task' } : { fields }, position: { x: 0, y: 0 } },
      { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 240, y: 0 } },
    ],
    edges: [{ id: 'input-output', source: 'input', target: 'output' }],
  }
}

const structuredFields: WorkflowInputField[] = [
  { name: 'title', label: 'Title', type: 'string', required: true },
  { name: 'count', type: 'number', defaultValue: 2 },
  { name: 'enabled', type: 'boolean', required: true },
  { name: 'document', type: 'file', required: true },
  { name: 'attachments', type: 'file-list', required: true },
  { name: 'metadata', type: 'json', required: true },
  { name: 'note', type: 'string', required: false },
]

describe('workflow launch contract', () => {
  it('projects only safe structured launch fields and clones defaults', () => {
    const workflow = definition([{ name: 'payload', label: 'Payload', type: 'json', required: true, defaultValue: { nested: ['safe'] }, secret: 'must-not-cross' } as never])

    const fields = deriveWorkflowLaunchFields(workflow)

    expect(fields).toEqual([{ name: 'payload', label: 'Payload', type: 'json', required: true, defaultValue: { nested: ['safe'] } }])
    expect(fields[0]).not.toBe(workflow.nodes[0]?.type === 'input' ? workflow.nodes[0].config.fields?.[0] : undefined)
    ;(fields[0]?.defaultValue as { nested: string[] }).nested.push('changed')
    expect(workflow.nodes[0]?.type === 'input' ? workflow.nodes[0].config.fields?.[0]?.defaultValue : undefined).toEqual({ nested: ['safe'] })
  })

  it('keeps completely legacy workflows compatible with any WorkflowValue', () => {
    const input: WorkflowValue = ['free-form', null, { nested: true }]

    expect(normalizeWorkflowLaunchInput(definition(), input)).toEqual(input)
    expect(normalizeWorkflowLaunchInput(definition([]), input)).toEqual(input)
  })

  it('applies defaults, preserves unknown keys, and accepts every valid structured field type', () => {
    const input = {
      title: 'Quarterly report',
      enabled: false,
      document: 'docs/report.md',
      attachments: ['docs/a.md', ' docs/b.md '],
      metadata: null,
      note: '   ',
      length: 3,
      unknown: { preserved: true },
    }

    expect(normalizeWorkflowLaunchInput(definition(structuredFields), input)).toEqual({ ...input, count: 2 })
  })

  it.each([
    ['non-object structured input', 'text'],
    ['missing required field', { enabled: true, document: 'a.txt', attachments: ['a.txt'], metadata: null }],
    ['non-finite number', { title: 'ok', count: Number.POSITIVE_INFINITY, enabled: true, document: 'a.txt', attachments: ['a.txt'], metadata: null }],
    ['wrong boolean', { title: 'ok', enabled: 'true', document: 'a.txt', attachments: ['a.txt'], metadata: null }],
    ['wrong string', { title: 3, enabled: true, document: 'a.txt', attachments: ['a.txt'], metadata: null }],
    ['blank required string', { title: '   ', enabled: true, document: 'a.txt', attachments: ['a.txt'], metadata: null }],
    ['blank file', { title: 'ok', enabled: true, document: '   ', attachments: ['a.txt'], metadata: null }],
    ['empty file list', { title: 'ok', enabled: true, document: 'a.txt', attachments: [], metadata: null }],
    ['blank file-list item', { title: 'ok', enabled: true, document: 'a.txt', attachments: ['a.txt', '  '], metadata: null }],
  ])('rejects %s', (_name, input) => {
    expect(() => normalizeWorkflowLaunchInput(definition(structuredFields), input as never)).toThrow()
  })

  it('validates structured field names, cross-node uniqueness, and default compatibility', () => {
    const invalid = definition([
      { name: '   ', type: 'string' },
      { name: 'count', type: 'number', defaultValue: Number.NaN },
      { name: 'document', type: 'file', defaultValue: '   ' },
      { name: 'attachments', type: 'file-list', defaultValue: [] },
      { name: 'requiredTitle', type: 'string', required: true, defaultValue: '   ' },
    ])
    invalid.nodes.splice(1, 0, {
      id: 'input-two', type: 'input', label: 'Input two', config: { fields: [{ name: 'count', type: 'number' }] }, position: { x: 0, y: 120 },
    })

    const result = validateWorkflow(invalid)

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'nodes.0.config.fields.0.name' }),
      expect.objectContaining({ path: 'nodes.0.config.fields.1.defaultValue' }),
      expect.objectContaining({ path: 'nodes.0.config.fields.2.defaultValue' }),
      expect.objectContaining({ path: 'nodes.0.config.fields.3.defaultValue' }),
      expect.objectContaining({ path: 'nodes.0.config.fields.4.defaultValue' }),
      expect.objectContaining({ path: 'nodes.1.config.fields.0.name' }),
    ]))
  })

  it('accepts compatible defaults including optional blank strings and json null', () => {
    const workflow = definition([
      { name: 'title', type: 'string', required: false, defaultValue: '' },
      { name: 'count', type: 'number', defaultValue: 0 },
      { name: 'enabled', type: 'boolean', defaultValue: false },
      { name: 'document', type: 'file', defaultValue: 'docs/a.md' },
      { name: 'attachments', type: 'file-list', defaultValue: ['docs/a.md'] },
      { name: 'metadata', type: 'json', defaultValue: null },
    ])

    expect(validateWorkflow(workflow)).toMatchObject({ valid: true, issues: [] })
  })

  it('uses the persisted required-by-default semantics for missing, blank, and default string values', () => {
    const workflow = definition([{ name: 'title', type: 'string' }])
    const invalidDefault = definition([{ name: 'title', type: 'string', defaultValue: '   ' }])

    expect(() => normalizeWorkflowLaunchInput(workflow, {})).toThrow(/title|必填/u)
    expect(() => normalizeWorkflowLaunchInput(workflow, { title: '   ' })).toThrow(/title|string/u)
    expect(validateWorkflow(invalidDefault).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'nodes.0.config.fields.0.defaultValue' }),
    ]))
  })

  it('rejects non-JSON-safe legacy launch values with a diagnostic error', () => {
    const accessor = {}
    Object.defineProperty(accessor, 'danger', { enumerable: true, get: () => { throw new Error('secret getter failure') } })

    expect(() => normalizeWorkflowLaunchInput(definition(), new Date() as never)).toThrow(/JSON-safe/u)
    expect(() => normalizeWorkflowLaunchInput(definition(), Number.NaN as never)).toThrow(/JSON-safe/u)
    expect(() => normalizeWorkflowLaunchInput(definition(), accessor as never)).toThrow(/JSON-safe/u)
  })
})

describe('WorkflowStore structured launch validation', () => {
  it.each([
    ['non-object entry', [null]],
    ['non-string name', [{ name: 42, type: 'string' }]],
    ['unknown type', [{ name: 'count', type: 'integer' }]],
    ['non-string type', [{ name: 'enabled', type: 42 }]],
  ])('rejects a %s during create instead of degrading it to legacy input', async (_name, fields) => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-launch-contract-create-'))
    const store = new WorkflowStore(dir)

    await expect(store.create({ ...definition(fields as never), id: 'malformed-create' })).rejects.toThrow(/字段|field|type|name/u)
    expect(store.list()).toEqual([])
  })

  it('rejects malformed fields during update and keeps the prior valid revision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-launch-contract-update-'))
    const store = new WorkflowStore(dir)
    const created = await store.create({ ...definition(), id: 'malformed-update' })
    const malformed = definition([{ name: 'payload', type: { unexpected: true } as never }])

    await expect(store.update(created.id, { revision: created.revision, nodes: malformed.nodes })).rejects.toThrow(/字段类型|type/u)
    expect(store.get(created.id)).toEqual(created)
    expect(store.getRevision(created.id, 2)).toBeUndefined()
  })
})

async function serviceFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ezdsh-launch-contract-'))
  const workflowStore = new WorkflowStore(dir)
  const runStore = new WorkflowRunStore(dir)
  const workflow = await workflowStore.create({
    ...definition([
      { name: 'title', type: 'string', required: true },
      { name: 'count', type: 'number', defaultValue: 2 },
      { name: '__proto__', type: 'json', defaultValue: { safe: true } },
      { name: 'constructor', type: 'string', defaultValue: 'safe-constructor' },
    ]),
  })
  const release: WorkflowRelease = {
    id: 'release-launch-contract',
    environmentId: 'environment-launch-contract',
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    contentSha256: computeWorkflowDefinitionSha256(workflow),
    workflowSnapshot: workflow,
    status: 'published',
    connectorGrants: [],
    createdAt: workflow.createdAt,
    publishedAt: workflow.createdAt,
  }
  const environment: WorkflowCustomerEnvironment = {
    id: release.environmentId,
    customerName: 'Acme',
    name: 'Production',
    kind: 'production',
    status: 'active',
    connectorIds: [],
    allowShellFile: false,
    allowCode: false,
    createdAt: workflow.createdAt,
    updatedAt: workflow.createdAt,
  }
  const service = new WorkflowRunService({
    workflowStore,
    runStore,
    workflowRoot: dir,
    createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
    resolveEmployee: () => undefined,
    resolveReleasedWorkflow: (id) => id === release.id ? release : undefined,
    resolveWorkflowEnvironment: (id) => id === environment.id ? environment : undefined,
  })
  await service.initialize()
  await service.stop()
  return { service, workflow, release, runStore }
}

describe('WorkflowRunService launch contract', () => {
  it('normalizes and persists the same effective input for normal and released starts', async () => {
    const { service, workflow, release, runStore } = await serviceFixture()
    const supplied = { title: 'Report', unknown: ['preserved'] }

    const normal = await service.start(workflow.id, supplied)
    const released = await service.startReleased(release.id, supplied)

    expect(normal.input).toEqual({ title: 'Report', unknown: ['preserved'], count: 2, ['__proto__']: { safe: true }, constructor: 'safe-constructor' })
    expect(released.input).toEqual(normal.input)
    expect(runStore.get(normal.id)?.input).toEqual(normal.input)
    expect(runStore.get(released.id)?.input).toEqual(normal.input)
    for (const record of [normal, released, runStore.get(normal.id), runStore.get(released.id)]) {
      const descriptor = Object.getOwnPropertyDescriptor(record?.input, '__proto__')
      expect(descriptor).toMatchObject({ enumerable: true, value: { safe: true } })
      expect(Object.getOwnPropertyDescriptor(record?.input, 'constructor')).toMatchObject({ enumerable: true, value: 'safe-constructor' })
    }
  })

  it('preserves caller-supplied own __proto__ and constructor fields in the durable run', async () => {
    const { service, workflow, runStore } = await serviceFixture()
    const supplied: Record<string, WorkflowValue> = { title: 'Report' }
    Object.defineProperty(supplied, '__proto__', { value: { caller: true }, enumerable: true, writable: true, configurable: true })
    Object.defineProperty(supplied, 'constructor', { value: 'caller-constructor', enumerable: true, writable: true, configurable: true })

    const run = await service.start(workflow.id, supplied)
    const persisted = runStore.get(run.id)

    expect(Object.getOwnPropertyDescriptor(persisted?.input, '__proto__')).toMatchObject({ enumerable: true, value: { caller: true } })
    expect(Object.getOwnPropertyDescriptor(persisted?.input, 'constructor')).toMatchObject({ enumerable: true, value: 'caller-constructor' })
  })

  it.each(['normal', 'released'] as const)('rejects invalid %s starts without creating a run record', async (kind) => {
    const { service, workflow, release, runStore } = await serviceFixture()

    const launch = kind === 'normal'
      ? service.start(workflow.id, { count: 3 })
      : service.startReleased(release.id, { count: 3 })

    await expect(launch).rejects.toThrow(/title|必填/u)
    expect(runStore.list()).toEqual([])
  })

  it('preserves arbitrary legacy input in direct service starts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-launch-contract-legacy-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const workflow = await workflowStore.create({ ...definition(), id: 'legacy-launch' })
    const service = new WorkflowRunService({
      workflowStore,
      runStore,
      workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })
    await service.initialize()
    await service.stop()
    const input: WorkflowValue = ['legacy', null, { unrestricted: true }]

    const run = await service.start(workflow.id, input)

    expect(run.input).toEqual(input)
    expect(runStore.get(run.id)?.input).toEqual(input)
  })
})
