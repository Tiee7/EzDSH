import type { WorkTaskSnapshot } from '../../shared/work-items.js'
import { attentionGroup, type WorkItemAttentionGroup } from './work-item-attention-model.js'
import './work-item-attention.css'

export interface WorkItemAttentionViewProps {
  snapshots: readonly WorkTaskSnapshot[]
  onSelect: (taskId: string) => void
  selectedTaskId?: string
  onButtonRef?: (taskId: string, button: HTMLButtonElement | null) => void
  locale?: 'zh' | 'en'
}

const GROUPS: readonly { id: WorkItemAttentionGroup; en: string; zh: string }[] = [
  { id: 'needs-action', en: 'Needs action', zh: '需要处理' },
  { id: 'in-progress', en: 'In progress', zh: '进行中' },
  { id: 'review', en: 'Review', zh: '等待验收' },
  { id: 'failed', en: 'Failed', zh: '执行失败' },
  { id: 'completed', en: 'Completed', zh: '已完成' },
]

/** A bridge-free projection: selecting a stable task id is its only effect. */
export function WorkItemAttentionView({ snapshots, onSelect, selectedTaskId, onButtonRef, locale = 'en' }: WorkItemAttentionViewProps): JSX.Element {
  const grouped = new Map<WorkItemAttentionGroup, WorkTaskSnapshot[]>(GROUPS.map(({ id }) => [id, []]))
  for (const snapshot of snapshots) grouped.get(attentionGroup(snapshot))?.push(snapshot)

  return <nav className="work-item-attention-view" aria-label={locale === 'en' ? 'Work item attention groups' : '工作项关注分组'}>
    {GROUPS.map(({ id, en, zh }) => {
      const label = locale === 'en' ? en : zh
      const items = grouped.get(id) ?? []
      return <section key={id} className="work-item-attention-group" data-attention-group={id}>
        <header className="work-item-attention-heading">
          <h2>{label}</h2>
          <span aria-label={`${label} count`} data-attention-count={items.length}>{items.length}</span>
        </header>
        {items.length === 0
          ? <p className="work-item-attention-empty" data-attention-empty="true">{locale === 'en' ? 'No tasks in this group.' : '此分组暂无工作项。'}</p>
          : <ul className="work-item-attention-list">
            {items.map((snapshot) => <li key={snapshot.task.id}>
              <button
                type="button"
                className={`work-item-attention-task ${selectedTaskId === snapshot.task.id ? 'work-item-attention-task-selected' : ''}`}
                data-task-id={snapshot.task.id}
                aria-pressed={selectedTaskId === snapshot.task.id}
                ref={(button) => onButtonRef?.(snapshot.task.id, button)}
                onClick={() => onSelect(snapshot.task.id)}
              >
                <strong>{snapshot.task.title}</strong>
                <span>{locale === 'en' ? `Requirement v${snapshot.task.currentRequirementVersion}` : `要求 v${snapshot.task.currentRequirementVersion}`}</span>
                <small>{snapshot.task.scope.projectId ?? (locale === 'en' ? 'Unassigned' : '未归入项目')}</small>
              </button>
            </li>)}
          </ul>}
      </section>
    })}
  </nav>
}
