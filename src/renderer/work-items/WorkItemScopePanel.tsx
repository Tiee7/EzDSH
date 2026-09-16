import type { WorkScope } from '../../shared/work-items.js'

export interface WorkItemScopePanelProps {
  scope: WorkScope
  project?: { projectId: string; title: string; path?: string }
  locale?: 'zh' | 'en'
}

interface ScopeCopy {
  heading: string
  project: string
  unassignedProject: string
  projectDirectoryUnavailable: string
  workingDirectory: string
  noFixedWorkingDirectory: string
  references: string
  noRecordedReferences: string
  localFile: string
  projectDocument: string
  externalLink: string
  generatedArtifact: string
  legacyReference: string
  authorizationNotConfirmed: string
  authorizationGranted: string
  authorizationDenied: string
  authorizationPending: string
  version: (value: string) => string
  referenceIdentity: string
  referenceDisclaimer: string
}

const copy: Record<'zh' | 'en', ScopeCopy> = {
  zh: {
    heading: '任务作用域',
    project: '项目',
    unassignedProject: '未归项目',
    projectDirectoryUnavailable: '项目目录不可用',
    workingDirectory: '固定工作目录',
    noFixedWorkingDirectory: '未固定工作目录',
    references: '记录的引用',
    noRecordedReferences: '无记录引用',
    localFile: '本地文件',
    projectDocument: '项目文档',
    externalLink: '外部链接',
    generatedArtifact: '生成成果',
    legacyReference: '旧版未分类引用',
    authorizationNotConfirmed: '主进程尚未返回授权状态',
    authorizationGranted: '已由主进程授权',
    authorizationDenied: '主进程未授权',
    authorizationPending: '等待主进程授权',
    version: (value) => `资料版本 ${value}`,
    referenceIdentity: '资料标识',
    referenceDisclaimer: '记录的引用不代表内容已读取、已验证或已授权给执行器。'
  },
  en: {
    heading: 'Task scope',
    project: 'Project',
    unassignedProject: 'Unassigned project',
    projectDirectoryUnavailable: 'Project directory unavailable',
    workingDirectory: 'Fixed working directory',
    noFixedWorkingDirectory: 'No fixed working directory',
    references: 'Recorded references',
    noRecordedReferences: 'No recorded references',
    localFile: 'Local file',
    projectDocument: 'Project document',
    externalLink: 'External link',
    generatedArtifact: 'Generated artifact',
    legacyReference: 'Legacy unclassified reference',
    authorizationNotConfirmed: 'Authorization has not been confirmed by Main',
    authorizationGranted: 'Authorized by Main',
    authorizationDenied: 'Not authorized by Main',
    authorizationPending: 'Awaiting authorization from Main',
    version: (value) => `Material version ${value}`,
    referenceIdentity: 'Material identity',
    referenceDisclaimer: 'Recorded references do not prove that content was read, verified, or authorized for an executor.'
  }
}

type MaterialKind = 'local-file' | 'project-document' | 'external-link' | 'generated-artifact' | 'legacy'
type AuthorizationState = 'not-confirmed' | 'authorized' | 'denied' | 'pending'

interface MaterialReferenceDisplay {
  kind: MaterialKind
  summary: string
  identity?: string
  authorization: AuthorizationState
  version?: string
}

const materialKindAliases: Record<string, Exclude<MaterialKind, 'legacy'>> = {
  'local-file': 'local-file',
  'local_file': 'local-file',
  'file': 'local-file',
  'project-document': 'project-document',
  'project_document': 'project-document',
  'project-doc': 'project-document',
  'document': 'project-document',
  'external-link': 'external-link',
  'external_link': 'external-link',
  'link': 'external-link',
  'url': 'external-link',
  'generated-artifact': 'generated-artifact',
  'generated_artifact': 'generated-artifact',
  'artifact': 'generated-artifact',
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized === '' ? undefined : normalized
}

function materialKind(value: unknown): Exclude<MaterialKind, 'legacy'> | undefined {
  const normalized = stringValue(value)?.toLowerCase()
  return normalized === undefined ? undefined : materialKindAliases[normalized]
}

function authorizationState(value: Record<string, unknown>): AuthorizationState {
  const raw = value.authorizationStatus ?? value.authorization ?? value.authStatus
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    if (['authorized', 'granted', 'allowed'].includes(normalized)) return 'authorized'
    if (['denied', 'rejected', 'revoked', 'blocked'].includes(normalized)) return 'denied'
    if (['pending', 'requested', 'awaiting'].includes(normalized)) return 'pending'
  }
  if (value.authorized === true) return 'authorized'
  if (value.authorized === false) return 'denied'
  return 'not-confirmed'
}

function materialVersion(value: Record<string, unknown>): string | undefined {
  for (const key of ['snapshotVersion', 'materialVersion', 'contentVersion', 'revision']) {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
    const text = stringValue(candidate)
    if (text !== undefined) return text
  }
  return undefined
}

function objectMaterialDisplay(value: Record<string, unknown>): MaterialReferenceDisplay | undefined {
  const kind = materialKind(value.kind ?? value.type ?? value.materialType ?? value.resourceType)
  if (kind === undefined) return undefined
  const identity = [
    value.label,
    value.title,
    value.name,
    value.path,
    value.filePath,
    value.url,
    value.documentPath,
    value.artifactName,
    value.materialId,
    value.resourceId,
    value.id,
    value.ref,
  ].map(stringValue).find((candidate) => candidate !== undefined)
  return {
    kind,
    summary: identity ?? kind,
    ...(identity === undefined ? {} : { identity }),
    authorization: authorizationState(value),
    ...(materialVersion(value) === undefined ? {} : { version: materialVersion(value) }),
  }
}

function parseTaggedReference(value: string): MaterialReferenceDisplay | undefined {
  const separator = value.indexOf(':')
  if (separator <= 0) return undefined
  const kind = materialKind(value.slice(0, separator))
  const identity = stringValue(value.slice(separator + 1))
  if (kind === undefined || identity === undefined) return undefined
  return { kind, summary: identity, identity, authorization: 'not-confirmed' }
}

/**
 * The Work Item contract still accepts legacy strings. Only an explicit kind
 * marker (or a typed object supplied by a newer Main) receives a material
 * category; paths and URLs alone remain legacy and are never guessed here.
 */
function materialReferenceDisplay(value: unknown): MaterialReferenceDisplay {
  if (typeof value === 'string') {
    const parsed = value.trim().startsWith('{')
      ? (() => {
        try {
          const display = objectMaterialDisplay(recordValue(JSON.parse(value)) ?? {})
          // A JSON-looking legacy string is still untrusted text. Preserve an
          // explicit kind for readability, but never accept its auth fields.
          return display === undefined ? undefined : { ...display, authorization: 'not-confirmed' as const }
        } catch { return undefined }
      })()
      : undefined
    if (parsed !== undefined) return parsed
    return parseTaggedReference(value) ?? {
      kind: 'legacy',
      summary: value,
      identity: value,
      authorization: 'not-confirmed',
    }
  }
  const parsed = objectMaterialDisplay(recordValue(value) ?? {})
  if (parsed !== undefined) return parsed
  let summary = ''
  try { summary = JSON.stringify(value) } catch { summary = String(value) }
  return {
    kind: 'legacy',
    summary: summary || String(value),
    authorization: 'not-confirmed',
  }
}

function materialKindLabel(kind: MaterialKind, labels: ScopeCopy): string {
  if (kind === 'local-file') return labels.localFile
  if (kind === 'project-document') return labels.projectDocument
  if (kind === 'external-link') return labels.externalLink
  if (kind === 'generated-artifact') return labels.generatedArtifact
  return labels.legacyReference
}

function authorizationLabel(state: AuthorizationState, labels: ScopeCopy): string {
  if (state === 'authorized') return labels.authorizationGranted
  if (state === 'denied') return labels.authorizationDenied
  if (state === 'pending') return labels.authorizationPending
  return labels.authorizationNotConfirmed
}

function projectValue(scope: WorkScope, project: WorkItemScopePanelProps['project'], labels: ScopeCopy): JSX.Element {
  if (scope.projectId === undefined) {
    return <span>{labels.unassignedProject}</span>
  }

  if (project?.projectId === scope.projectId) {
    return <span>
      <strong>{project.title}</strong>{' '}
      <code data-scope-project-id={scope.projectId}>{scope.projectId}</code>
    </span>
  }

  return <span>
    <code data-scope-project-id={scope.projectId}>{scope.projectId}</code>{' '}
    <span role="note">({labels.projectDirectoryUnavailable})</span>
  </span>
}

/** Displays only the scope persisted on a Work Item; references remain inert text. */
export function WorkItemScopePanel({ scope, project, locale = 'zh' }: WorkItemScopePanelProps): JSX.Element {
  const labels = copy[locale]
  const references: unknown[] = [
    ...(scope.materialRefs ?? []),
    ...scope.resourceRefs,
  ]

  return (
    <section className="work-item-detail-section work-item-scope-panel" aria-label={labels.heading} data-work-item-scope-panel="true">
      <div className="work-item-detail-section-heading">
        <h3>{labels.heading}</h3>
      </div>
      <dl className="work-item-scope-list">
        <div data-scope-field="project">
          <dt>{labels.project}</dt>
          <dd>{projectValue(scope, project, labels)}</dd>
        </div>
        <div data-scope-field="cwd">
          <dt>{labels.workingDirectory}</dt>
          <dd>{scope.cwd === undefined ? labels.noFixedWorkingDirectory : <code>{scope.cwd}</code>}</dd>
        </div>
        <div data-scope-field="references">
          <dt>{labels.references}</dt>
          <dd>
            {references.length === 0
              ? <span>{labels.noRecordedReferences}</span>
              : <ul>
                {references.map((resourceRef, index) => {
                  const material = materialReferenceDisplay(resourceRef)
                  return <li key={`${index}:${material.identity ?? material.summary}`} data-resource-ref="true" data-resource-kind={material.kind}>
                    <div className="work-item-material-summary">
                      <span className="work-item-material-kind">{materialKindLabel(material.kind, labels)}</span>
                      <strong>{material.summary}</strong>
                    </div>
                    {material.identity === undefined || material.identity === material.summary ? null : <div className="work-item-material-identity"><span>{labels.referenceIdentity}</span> <code>{material.identity}</code></div>}
                    <div className="work-item-material-meta">
                      <span data-resource-authorization={material.authorization}>{authorizationLabel(material.authorization, labels)}</span>
                      {material.version === undefined ? null : <span>{labels.version(material.version)}</span>}
                    </div>
                  </li>
                })}
              </ul>}
            <p role="note">{labels.referenceDisclaimer}</p>
          </dd>
        </div>
      </dl>
    </section>
  )
}
