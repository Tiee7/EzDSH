import { useEffect, useState } from 'react'
import type { WorkItemProjectContextSnapshot } from '../../shared/project-context.js'

interface WorkItemProjectContextPanelProps {
  includeArchived: boolean
  locale?: 'zh' | 'en'
}

const copy = {
  zh: {
    title: '项目上下文',
    unavailable: '项目目录暂不可用，仍显示已保存的工作项。',
    loading: '正在汇总项目与工作项…',
    empty: '暂无可汇总的项目或工作项。',
    unassigned: '未归属项目',
    workItems: '工作项',
    active: '活动',
    actions: '待处理',
    runs: '运行中',
    artifacts: '成果',
  },
  en: {
    title: 'Project context',
    unavailable: 'The project directory is unavailable; saved work items remain visible.',
    loading: 'Joining projects and work items…',
    empty: 'No projects or work items to summarize.',
    unassigned: 'Unassigned project',
    workItems: 'work items',
    active: 'active',
    actions: 'open actions',
    runs: 'active runs',
    artifacts: 'artifacts',
  },
} as const

/** Read-only project join; no project or execution state is mutated here. */
export function WorkItemProjectContextPanel({ includeArchived, locale = 'zh' }: WorkItemProjectContextPanelProps): JSX.Element | null {
  const labels = copy[locale]
  const [snapshot, setSnapshot] = useState<WorkItemProjectContextSnapshot>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    const read = window.EzDSH.workItems.getProjectContext
    if (read === undefined) {
      setLoading(false)
      return () => { active = false }
    }
    void read({ includeArchived, includeUnassigned: true }).then((next) => {
      if (active) setSnapshot(next)
    }).catch(() => {
      if (active) setSnapshot(undefined)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [includeArchived])

  if (loading && snapshot === undefined) {
    return <section className="work-item-project-context" aria-label={labels.title}><span>{labels.loading}</span></section>
  }
  if (snapshot === undefined) return null
  if (snapshot.contexts.length === 0) {
    return <section className="work-item-project-context" aria-label={labels.title}><span>{labels.empty}</span></section>
  }

  return (
    <section className="work-item-project-context" aria-label={labels.title}>
      <div className="work-item-project-context-header">
        <h2>{labels.title}</h2>
        {snapshot.directory.state === 'unavailable' ? <span className="work-item-project-context-warning" role="status">{labels.unavailable}</span> : null}
      </div>
      <div className="work-item-project-context-grid">
        {snapshot.contexts.map((context) => {
          const totals = context.totals
          const title = context.key.kind === 'unassigned' ? labels.unassigned : context.project?.title ?? context.key.projectId
          return (
            <article key={context.key.kind === 'unassigned' ? 'unassigned' : context.key.projectId} className="work-item-project-context-card">
              <strong>{title}</strong>
              <small>{totals.workItems} {labels.workItems} · {totals.activeWorkItems} {labels.active}</small>
              <small>{totals.openActions} {labels.actions} · {totals.activeRuns} {labels.runs} · {totals.artifacts} {labels.artifacts}</small>
            </article>
          )
        })}
      </div>
    </section>
  )
}
