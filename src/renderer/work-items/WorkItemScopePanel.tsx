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
    referenceDisclaimer: 'Recorded references do not prove that content was read, verified, or authorized for an executor.'
  }
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
            {scope.resourceRefs.length === 0
              ? <span>{labels.noRecordedReferences}</span>
              : <ul>
                {scope.resourceRefs.map((resourceRef) => <li key={resourceRef} data-resource-ref="true"><code>{resourceRef}</code></li>)}
              </ul>}
            <p role="note">{labels.referenceDisclaimer}</p>
          </dd>
        </div>
      </dl>
    </section>
  )
}
