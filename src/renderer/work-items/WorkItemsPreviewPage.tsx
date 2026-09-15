import type { AppCopy } from '../../shared/locale.js'

interface WorkItemsPreviewPageProps {
  copy: AppCopy
}

/** Developer preview seam for the future Work Items page. */
export function WorkItemsPreviewPage({ copy }: WorkItemsPreviewPageProps): JSX.Element {
  return (
    <div className="work-items-preview-page">
      <h1>{copy.tabWorkItems}</h1>
      <p>{copy.workItemsPreview}</p>
    </div>
  )
}
