/** A reusable method references an independently versioned workflow. It contains no run state. */
export interface EmployeeWorkMethod {
  schemaVersion: 1
  id: string
  employeeId: string
  name: string
  description: string
  workflowId: string
  workflowRevision: number
  version: number
  createdAt: string
  updatedAt: string
}
export type EmployeeWorkMethodCreate = Pick<EmployeeWorkMethod, 'name' | 'description' | 'workflowId' | 'workflowRevision'>
export type EmployeeWorkMethodUpdate = Partial<EmployeeWorkMethodCreate> & { expectedVersion: number }
export interface EmployeeMethodsBridge {
  list(employeeId: string): Promise<EmployeeWorkMethod[]>
  get(employeeId: string, id: string): Promise<EmployeeWorkMethod | undefined>
  create(employeeId: string, input: EmployeeWorkMethodCreate): Promise<EmployeeWorkMethod>
  update(employeeId: string, id: string, input: EmployeeWorkMethodUpdate): Promise<EmployeeWorkMethod>
  remove(employeeId: string, id: string, expectedVersion: number): Promise<void>
  snapshot(employeeId: string, id: string): Promise<EmployeeWorkMethod>
}

export function validateMethodId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(value)) throw new Error('Invalid method or owner ID')
  return value
}
export function validateMethodVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid method version')
  return value
}
function publicText(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && value.trim() === '')) throw new Error('Invalid method text')
  // Do not accept common credential assignments in public template metadata.
  if (/(?:sk-[a-zA-Z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY|\bBearer\s+\S+|(?:api[_ -]?key|(?:access[_ -]?)?token|password|secret|密钥|密码)\s*[:=：]\s*\S+)/iu.test(value)) {
    throw new Error('Method metadata must not contain credentials')
  }
  return value.trim()
}
export function validateMethodInput(value: unknown, partial = false): EmployeeWorkMethodCreate | EmployeeWorkMethodUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid method input')
  const raw = value as Record<string, unknown>
  const allowed = ['name', 'description', 'workflowId', 'workflowRevision', ...(partial ? ['expectedVersion'] : [])]
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new Error('Unsupported method field')
  const result: Record<string, unknown> = {}
  if (!partial || raw.name !== undefined) result.name = publicText(raw.name, 160, true)
  if (!partial || raw.description !== undefined) result.description = publicText(raw.description, 4000)
  if (!partial || raw.workflowId !== undefined) result.workflowId = validateMethodId(raw.workflowId)
  if (!partial || raw.workflowRevision !== undefined) result.workflowRevision = validateMethodVersion(raw.workflowRevision)
  if (partial) result.expectedVersion = validateMethodVersion(raw.expectedVersion)
  return result as unknown as EmployeeWorkMethodCreate | EmployeeWorkMethodUpdate
}
