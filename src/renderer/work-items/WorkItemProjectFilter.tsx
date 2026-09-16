import type { ChangeEvent } from 'react'
import type { WorkItemProjectFilterValue, WorkItemProjectOption } from './work-item-project-filter.js'

export type { WorkItemProjectDirectoryEntry, WorkItemProjectOption, WorkItemProjectFilterValue } from './work-item-project-filter.js'

export interface WorkItemProjectFilterProps {
  value: WorkItemProjectFilterValue
  options: readonly WorkItemProjectOption[]
  onChange: (value: WorkItemProjectFilterValue) => void
  locale?: 'zh' | 'en'
}

function serializedValue(value: WorkItemProjectFilterValue, options: readonly WorkItemProjectOption[]): string {
  if (value.kind === 'all' || value.kind === 'unassigned') return value.kind
  return options.some((option) => option.projectId === value.projectId) ? `project:${value.projectId}` : 'all'
}

function projectOptionLabel(option: WorkItemProjectOption, duplicateTitles: ReadonlySet<string>, locale: 'zh' | 'en'): string {
  if (option.orphaned) return locale === 'en' ? `${option.projectId} (unavailable)` : `${option.projectId}（不可用）`
  return duplicateTitles.has(option.title) ? `${option.title} (${option.projectId})` : option.title
}

function filterFromSerializedValue(serialized: string, options: readonly WorkItemProjectOption[]): WorkItemProjectFilterValue {
  if (serialized === 'all') return { kind: 'all' }
  if (serialized === 'unassigned') return { kind: 'unassigned' }
  if (serialized.startsWith('project:')) {
    const projectId = serialized.slice('project:'.length)
    if (options.some((option) => option.projectId === projectId)) return { kind: 'project', projectId }
  }
  return { kind: 'all' }
}

export function WorkItemProjectFilter({ value, options, onChange, locale = 'zh' }: WorkItemProjectFilterProps): JSX.Element {
  const english = locale === 'en'
  const duplicateTitles = new Set(options
    .map((option) => option.title)
    .filter((title, index, titles) => titles.indexOf(title) !== index))
  const selectedValue = serializedValue(value, options)
  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    onChange(filterFromSerializedValue(event.target.value, options))
  }

  return <div className="work-item-project-filter" data-project-filter="true">
    <label htmlFor="work-item-project-filter-select">{english ? 'Project scope' : '项目范围'}</label>
    <select id="work-item-project-filter-select" aria-label={english ? 'Project scope' : '项目范围'} value={selectedValue} onChange={handleChange}>
      <option value="all">{english ? 'All' : '全部'}</option>
      <option value="unassigned">{english ? 'Unassigned' : '未归项目'}</option>
      {options.map((option) => <option key={option.projectId} value={`project:${option.projectId}`}>
        {projectOptionLabel(option, duplicateTitles, locale)}
      </option>)}
    </select>
    <small data-project-filter-count="true" aria-label={english ? 'Available project count' : '可用项目数量'}>
      {english ? `Available projects: ${options.length}` : `可选项目：${options.length}`}
    </small>
  </div>
}
