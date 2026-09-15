import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkMethodService } from '../../src/main/employees/work-method-service.js'
import { EmployeeService } from '../../src/main/employees/employee-service.js'
import { validateMethodInput, type EmployeeWorkMethodCreate } from '../../src/shared/employee-methods.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const input: EmployeeWorkMethodCreate = { name: '研究方法', description: '核对公开信息并列出来源', workflowId: 'research', workflowRevision: 1 }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-methods-')); roots.push(root)
  const configPath = join(root, 'employee-methods.json')
  const options = { configPath, ownerExists: (id: string) => ['researcher', 'writer'].includes(id), workflowExists: (id: string, rev: number) => id === 'research' && [1, 2].includes(rev) }
  return { root, configPath, options, service: new WorkMethodService(options) }
}
describe('employee reusable methods', () => {
  it('persists workflow references, keeps detached versioned snapshots and reopens after restart', async () => {
    const { service, options } = await setup()
    const first = await service.create('researcher', input)
    const snapshot = await service.snapshot('researcher', first.id)
    const second = await service.update('researcher', first.id, { expectedVersion: 1, name: '更新研究方法', workflowRevision: 2 })
    expect(second.version).toBe(2)
    expect(second.createdAt).toBe(first.createdAt)
    expect(snapshot).toMatchObject({ name: input.name, version: 1, workflowRevision: 1 })
    snapshot.name = 'mutated locally'
    expect((await service.get('researcher', first.id))?.name).toBe(second.name)
    expect(await new WorkMethodService(options).list('researcher')).toEqual([second])
    await service.remove('researcher', first.id, 2)
    expect(await new WorkMethodService(options).list('researcher')).toEqual([])
  })
  it('checks owners, method identities and workflow revisions before writes', async () => {
    const { service } = await setup()
    await expect(service.create('missing', input)).rejects.toThrow('owner')
    await expect(service.create('researcher', { ...input, workflowRevision: 3 })).rejects.toThrow('revision')
    const method = await service.create('researcher', input)
    await expect(service.get('writer', method.id)).rejects.toThrow('another employee')
    await expect(service.update('writer', method.id, { expectedVersion: 1, name: 'hijack' })).rejects.toThrow('another employee')
    await expect(service.remove('writer', method.id, 1)).rejects.toThrow('another employee')
    await expect(service.list('../researcher')).rejects.toThrow('ID')
    await expect(service.snapshot('researcher', 'missing')).rejects.toThrow('not found')
    expect(await service.list('researcher')).toEqual([method])
  })
  it('serializes writes and rejects a stale editor rather than overwriting a concurrent revision', async () => {
    const { service } = await setup()
    const method = await service.create('researcher', input)
    const results = await Promise.allSettled([
      service.update('researcher', method.id, { expectedVersion: 1, name: 'A' }),
      service.update('researcher', method.id, { expectedVersion: 1, name: 'B' }),
    ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    await expect(service.remove('researcher', method.id, 1)).rejects.toThrow('version conflict')
    expect((await service.snapshot('researcher', method.id)).version).toBe(2)
  })
  it('keeps previous state when atomic file replacement fails and recovers for the next write', async () => {
    const { service, configPath } = await setup()
    const method = await service.create('researcher', input)
    const previous = await readFile(configPath, 'utf8')
    await rm(configPath); await mkdir(configPath)
    await expect(service.update('researcher', method.id, { expectedVersion: 1, name: 'should fail' })).rejects.toThrow()
    expect(await service.get('researcher', method.id)).toEqual(method)
    await rm(configPath, { recursive: true }); await writeFile(configPath, previous)
    expect((await service.update('researcher', method.id, { expectedVersion: 1, name: 'retry' })).version).toBe(2)
  })
  it('rejects run state, arbitrary nested definitions and common credentials from public metadata', async () => {
    for (const key of ['sessionId', 'prompt', 'connectorGrants', 'connectorSecrets', 'output', 'instructions', 'nodes', '__proto__']) {
      expect(() => validateMethodInput({ ...input, [key]: 'private-data' })).toThrow('Unsupported')
    }
    for (const description of ['api_key=private-token', 'Bearer hidden-value', '密码：pass123', 'sk-abcdefghijklmnop']) {
      expect(() => validateMethodInput({ ...input, description })).toThrow('credentials')
    }
    expect(() => validateMethodInput({ ...input, workflowRevision: NaN })).toThrow('version')
    expect(() => validateMethodInput({ ...input, name: ' ' })).toThrow('text')
    const { service } = await setup()
    const saved = await service.create('researcher', input)
    expect(Object.keys(saved).sort()).toEqual(['schemaVersion', 'id', 'employeeId', 'name', 'description', 'workflowId', 'workflowRevision', 'version', 'createdAt', 'updatedAt'].sort())
  })
  it('rejects malformed persisted records without overwriting the original file', async () => {
    const { service, configPath } = await setup()
    const raw = JSON.stringify([{ ...input, schemaVersion: 1, id: 'method', employeeId: 'researcher', version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sessionId: 'secret-session' }])
    await writeFile(configPath, raw)
    await expect(service.list('researcher')).rejects.toThrow('fields')
    expect(await readFile(configPath, 'utf8')).toBe(raw)
  })
  it('exposes methods on EmployeeService while keeping legacy profiles unchanged', async () => {
    const { root } = await setup()
    const service = new EmployeeService({ configPath: join(root, 'employees.json'), cwd: root, createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), methodWorkflowExists: () => true })
    await service.initialize()
    const before = service.get('researcher')
    const method = await service.methods.create('researcher', input)
    expect(await service.methods.snapshot('researcher', method.id)).toEqual(method)
    expect(service.get('researcher')).toEqual(before)
  })
})
