/** Capabilities that can be assigned to an AI employee. */
export const EMPLOYEE_CAPABILITIES = [
  'research',
  'copywriting',
  'image-generation',
  'file-read',
  'file-write',
  'workflow',
] as const

export type EmployeeCapability = (typeof EMPLOYEE_CAPABILITIES)[number]

export const EMPLOYEE_SCHEMA_VERSION = 2 as const

/** @deprecated Persisted V1 input only. Employee profiles no longer own workflows. */
export interface EmployeeWorkflowStep {
  id: string
  name: string
  instruction: string
  enabled: boolean
}

export interface EmployeeDefinition {
  schemaVersion: typeof EMPLOYEE_SCHEMA_VERSION
  version: number
  id: string
  /** Personal name used to distinguish people; legacy profiles may omit it. */
  displayName?: string
  /** Legacy short name retained for persisted V2 compatibility. Prefer displayName + role in UI. */
  name: string
  role: string
  description: string
  businessBoundary: string
  systemPrompt: string
  operatingGuidelines: string[]
  qualityStandards: string[]
  capabilities: EmployeeCapability[]
  skillIds: string[]
  enabled: boolean
  builtIn: boolean
  createdAt: string
  updatedAt: string
}

export type EmployeeSnapshot = EmployeeDefinition

export interface EmployeeGenerateRequest {
  prompt: string
}

export type EmployeeCreateInput = Omit<EmployeeDefinition, 'schemaVersion' | 'version' | 'id' | 'createdAt' | 'updatedAt' | 'builtIn'> & {
  id?: string
  builtIn?: boolean
}

export type EmployeeGeneratedProfile = Omit<EmployeeCreateInput, 'displayName'> & { displayName: string }

export type EmployeeUpdateInput = Partial<Omit<EmployeeDefinition, 'schemaVersion' | 'version' | 'id' | 'createdAt' | 'updatedAt' | 'builtIn'>>

/** Return the personal name while remaining compatible with pre-displayName profiles. */
export function employeeDisplayName(employee: Pick<EmployeeDefinition, 'name' | 'displayName'>): string {
  return employee.displayName?.trim() || employee.name.trim()
}

/** User-facing employee identity. */
export function employeeDisplayLabel(employee: Pick<EmployeeDefinition, 'name' | 'displayName' | 'role'>): string {
  const displayName = employeeDisplayName(employee)
  const role = employee.role.trim()
  return role === '' ? displayName : `${displayName}（${role}）`
}

export interface EmployeeProjectSummary {
  projectId: string
  path: string
  title: string
  sessionIds: string[]
}

export interface EmployeeSessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank?: boolean
  title?: string
}

export interface EmployeeSessionLock {
  sessionId: string
  employeeId: string
  runId: string
  startedAt: string
}

export interface EmployeeRunRequest {
  task: string
  projectId?: string
  sessionId?: string
}

export type EmployeeRunStepStatus = 'completed' | 'failed'

export interface EmployeeRunStepResult {
  stepId: string
  name: string
  status: EmployeeRunStepStatus
  output: string
  error?: string
}

export type EmployeeRunStatus = 'completed' | 'failed'

export interface EmployeeRunResult {
  runId: string
  employeeId: string
  status: EmployeeRunStatus
  output: string
  steps: EmployeeRunStepResult[]
  startedAt: string
  completedAt: string
  error?: string
}
