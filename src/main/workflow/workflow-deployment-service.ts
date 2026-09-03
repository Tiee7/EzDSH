import { randomUUID } from 'node:crypto'
import { computeWorkflowReleaseSha256, verifyWorkflowReleaseIntegrity } from './workflow-release-integrity.js'
import { WorkflowEnvironmentStore } from './workflow-environment-store.js'
import { WorkflowReleaseStore } from './workflow-release-store.js'
import { WorkflowRunService } from './workflow-run-service.js'
import { WorkflowStore } from './workflow-store.js'
import { assertValidWorkflow } from './workflow-validator.js'
import {
  deriveEnvironmentConnectorGrants,
  type WorkflowCustomerEnvironment,
  type WorkflowRelease,
  type WorkflowReleasePublishInput,
} from '../../shared/workflow-operations.js'
import { cloneWorkflow, isWorkflowValue, type WorkflowConnectorGrant, type WorkflowDefinition, type WorkflowNode, type WorkflowRunOptions, type WorkflowRunRecord, type WorkflowValue } from '../../shared/workflow.js'

interface WorkflowDeploymentServiceOptions {
  workflowStore: WorkflowStore
  environmentStore: WorkflowEnvironmentStore
  releaseStore: WorkflowReleaseStore
  runService: WorkflowRunService
}

interface WorkflowReleasePlan {
  workflowSnapshot: WorkflowDefinition
  workflowDependencies: WorkflowDefinition[]
  connectorGrants: WorkflowConnectorGrant[]
}

export class WorkflowDeploymentService {
  constructor(private readonly options: WorkflowDeploymentServiceOptions) {}

  async publish(input: WorkflowReleasePublishInput): Promise<WorkflowRelease> {
    await this.options.workflowStore.initialize()
    await this.options.environmentStore.initialize()
    await this.options.releaseStore.initialize()
    const workflow = this.resolveWorkflowOrThrow(input.workflowId, input.workflowRevision)
    if (workflow.enabled !== true) throw new Error('只能发布已启用的工作流')
    assertValidWorkflow(workflow, '发布工作流')
    const environment = this.requireActiveEnvironment(input.environmentId)
    const releasePlan = this.collectReleasePlan(workflow, environment)
    return this.options.releaseStore.publish({
      id: input.id?.trim() || `release-${randomUUID()}`,
      environmentId: environment.id,
      workflowId: releasePlan.workflowSnapshot.id,
      workflowRevision: releasePlan.workflowSnapshot.revision,
      contentSha256: computeWorkflowReleaseSha256(releasePlan),
      workflowSnapshot: releasePlan.workflowSnapshot,
      ...(releasePlan.workflowDependencies.length === 0 ? {} : { workflowDependencies: releasePlan.workflowDependencies }),
      status: 'published',
      connectorGrants: releasePlan.connectorGrants,
      createdAt: new Date().toISOString(),
      publishedAt: new Date().toISOString(),
    })
  }

  async start(releaseId: string, input: WorkflowValue, options: WorkflowRunOptions = {}): Promise<WorkflowRunRecord> {
    await this.options.environmentStore.initialize()
    await this.options.releaseStore.initialize()
    if (!isWorkflowValue(input)) throw new Error('Workflow 输入必须是 JSON-safe 值')
    const release = this.requirePublishedVerifiedRelease(releaseId)
    const environment = this.requireActiveEnvironment(release.environmentId)
    return this.options.runService.startReleased(release.id, input, {
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      allowShellFile: environment.allowShellFile && options.allowShellFile === true,
      allowCode: environment.allowCode && options.allowCode === true,
      connectorGrants: options.connectorGrants === undefined
        ? cloneConnectorGrants(release.connectorGrants)
        : intersectConnectorGrants(release.connectorGrants, options.connectorGrants),
      ...(options.debug === undefined ? {} : { debug: options.debug }),
      ...(options.model === undefined ? {} : { model: options.model }),
    })
  }

  async rollback(releaseId: string): Promise<WorkflowRelease> {
    await this.options.environmentStore.initialize()
    await this.options.releaseStore.initialize()
    const release = this.requireVerifiedRelease(releaseId)
    this.requireActiveEnvironment(release.environmentId)
    return this.options.releaseStore.rollback(releaseId)
  }

  private resolveWorkflowOrThrow(workflowId: string, revision?: number): WorkflowDefinition {
    const workflow = revision === undefined
      ? this.options.workflowStore.get(workflowId)
      : this.options.workflowStore.getRevision(workflowId, revision)
    if (workflow === undefined) throw new Error(`Workflow not found: ${workflowId}${revision === undefined ? '' : `@${String(revision)}`}`)
    return workflow
  }

  private requireActiveEnvironment(environmentId: string): WorkflowCustomerEnvironment {
    const environment = this.options.environmentStore.get(environmentId)
    if (environment === undefined) throw new Error(`Workflow environment not found: ${environmentId}`)
    if (environment.status !== 'active') throw new Error(`Workflow environment must be active: ${environmentId}`)
    return environment
  }

  private requireVerifiedRelease(releaseId: string): WorkflowRelease {
    const release = this.options.releaseStore.get(releaseId)
    if (release === undefined) throw new Error(`Workflow release not found: ${releaseId}`)
    if (!verifyWorkflowReleaseIntegrity(release)) throw new Error('Workflow release integrity verification failed')
    return release
  }

  private requirePublishedVerifiedRelease(releaseId: string): WorkflowRelease {
    const release = this.requireVerifiedRelease(releaseId)
    if (release.status !== 'published') throw new Error('只能启动已发布的 workflow release')
    return release
  }

  private collectReleasePlan(
    workflow: WorkflowDefinition,
    environment: WorkflowCustomerEnvironment,
  ): WorkflowReleasePlan {
    const collected = new Map<string, Set<'read' | 'write'>>()
    const dependencies = new Map<string, WorkflowDefinition>()
    const workflowSnapshot = this.collectWorkflowDeploymentState(workflow, environment, collected, dependencies, [])
    return {
      workflowSnapshot,
      workflowDependencies: [...dependencies.entries()]
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([, dependency]) => cloneWorkflow(dependency)),
      connectorGrants: [...collected.entries()].map(([connectorId, operations]) => ({ connectorId, operations: [...operations] })),
    }
  }

  private collectWorkflowDeploymentState(
    workflow: WorkflowDefinition,
    environment: WorkflowCustomerEnvironment,
    collected: Map<string, Set<'read' | 'write'>>,
    dependencies: Map<string, WorkflowDefinition>,
    stack: string[],
  ): WorkflowDefinition {
    const workflowKey = `${workflow.id}@${String(workflow.revision)}`
    if (stack.includes(workflowKey)) throw new Error(`子工作流存在循环依赖：${[...stack, workflowKey].join(' -> ')}`)
    const nextStack = [...stack, workflowKey]
    const connectorGrants = deriveEnvironmentConnectorGrants(workflow, environment)
    const allowedOperations = new Map(connectorGrants.map((grant) => [grant.connectorId.trim(), new Set(grant.operations)]))
    for (const grant of connectorGrants) {
      const operations = collected.get(grant.connectorId) ?? new Set<'read' | 'write'>()
      for (const operation of grant.operations) operations.add(operation)
      if (operations.size > 0) collected.set(grant.connectorId, operations)
    }
    const pinnedNodes = workflow.nodes.map((node) => this.pinDeploymentNode(node, environment, allowedOperations, collected, dependencies, nextStack))
    return {
      ...cloneWorkflow(workflow),
      nodes: pinnedNodes,
    }
  }

  private pinDeploymentNode(
    node: WorkflowNode,
    environment: WorkflowCustomerEnvironment,
    allowedOperations: Map<string, Set<'read' | 'write'>>,
    collected: Map<string, Set<'read' | 'write'>>,
    dependencies: Map<string, WorkflowDefinition>,
    stack: string[],
  ): WorkflowNode {
    this.assertNodeAllowedForDeployment(node, environment, allowedOperations)
    if (node.type !== 'sub-workflow') return cloneWorkflow(node)
    const child = this.resolveWorkflowOrThrow(
      node.config.workflowId,
      typeof node.config.version === 'number' ? node.config.version : undefined,
    )
    if (child.enabled !== true) throw new Error(`只能发布已启用的子工作流：${child.name}`)
    assertValidWorkflow(child, `发布子工作流 ${child.name}`)
    const childSnapshot = this.collectWorkflowDeploymentState(child, environment, collected, dependencies, stack)
    dependencies.set(`${childSnapshot.id}@${String(childSnapshot.revision)}`, cloneWorkflow(childSnapshot))
    return {
      ...cloneWorkflow(node),
      config: {
        ...node.config,
        workflowId: childSnapshot.id,
        version: childSnapshot.revision,
      },
    }
  }

  private assertNodeAllowedForDeployment(
    node: WorkflowNode,
    environment: WorkflowCustomerEnvironment,
    allowedOperations: Map<string, Set<'read' | 'write'>>,
  ): void {
    if (node.type === 'http' && node.config.connectorId !== undefined) {
      const connectorId = node.config.connectorId.trim()
      const connectorPath = node.config.connectorPath?.trim()
      if (connectorId === '' || connectorPath === undefined || connectorPath === '') throw new Error(`托管 HTTP 节点缺少 connectorPath: ${node.label}`)
      const requiredOperation = node.config.method === 'GET' ? 'read' : 'write'
      if (!allowedOperations.get(connectorId)?.has(requiredOperation)) {
        throw new Error(`环境未授予连接器 ${connectorId} 的 ${requiredOperation} 权限`)
      }
    }
    if (environment.kind !== 'production') return
    if (node.type === 'http' && node.config.connectorId === undefined) throw new Error('生产环境禁止 raw URL HTTP 节点')
    if (node.type === 'sub-workflow' && node.config.version === 'latest') throw new Error('生产环境禁止 latest 子工作流版本')
    if (node.type === 'shell' || node.type === 'file' || node.type === 'code') {
      throw new Error(`生产环境禁止 ${node.type} 节点`)
    }
  }
}

function cloneConnectorGrants(grants: readonly WorkflowConnectorGrant[]): WorkflowConnectorGrant[] {
  return grants.map((grant) => ({ connectorId: grant.connectorId, operations: [...grant.operations] }))
}

function intersectConnectorGrants(
  base: readonly WorkflowConnectorGrant[],
  requested: readonly WorkflowConnectorGrant[],
): WorkflowConnectorGrant[] {
  const allowed = new Map(base.map((grant) => [grant.connectorId.trim(), new Set(grant.operations)]))
  const narrowed = new Map<string, Set<'read' | 'write'>>()
  for (const grant of requested) {
    const connectorId = grant.connectorId.trim()
    const permitted = allowed.get(connectorId)
    if (permitted === undefined) continue
    const operations = narrowed.get(connectorId) ?? new Set<'read' | 'write'>()
    for (const operation of grant.operations) if (permitted.has(operation)) operations.add(operation)
    if (operations.size > 0) narrowed.set(connectorId, operations)
  }
  return [...narrowed.entries()].map(([connectorId, operations]) => ({ connectorId, operations: [...operations] }))
}
