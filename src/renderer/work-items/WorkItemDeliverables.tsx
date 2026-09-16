import { useRef, useState } from 'react'
import type { WorkArtifact, WorkArtifactAcceptRequest, WorkTaskSnapshot } from '../../shared/work-items.js'

export interface WorkItemDeliverablesProps {
  snapshot: WorkTaskSnapshot
  locale?: 'zh' | 'en'
  onAcceptArtifact: (request: WorkArtifactAcceptRequest) => Promise<WorkTaskSnapshot>
  onAccepted: (snapshot: WorkTaskSnapshot) => void
  onOpenArtifact?: (artifact: WorkArtifact) => void
}

/** Acceptance remains server-owned: a request in flight or failure is never shown as accepted. */
export function WorkItemDeliverables({ snapshot, locale = 'zh', onAcceptArtifact, onAccepted, onOpenArtifact }: WorkItemDeliverablesProps): JSX.Element {
  const english = locale === 'en'
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const retry = useRef<{ signature: string; request: WorkArtifactAcceptRequest }>()

  async function accept(artifact: WorkArtifact): Promise<void> {
    if (inFlight.current || artifact.requirementVersion !== snapshot.task.currentRequirementVersion || snapshot.task.acceptedArtifactIds.includes(artifact.id)) return
    const payload = { taskId: snapshot.task.id, expectedRevision: snapshot.task.revision, artifactId: artifact.id, contentVersion: artifact.contentVersion, requirementVersion: artifact.requirementVersion }
    const signature = JSON.stringify(payload)
    const request = retry.current?.signature === signature ? retry.current.request : { ...payload, requestId: crypto.randomUUID() }
    retry.current = { signature, request }
    inFlight.current = true
    setPending(artifact.id)
    setError('')
    try { onAccepted(await onAcceptArtifact(request)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { inFlight.current = false; setPending(undefined) }
  }

  return <section className="work-item-detail-section" aria-label={english ? 'Deliverables' : '交付成果'}>
    <h3>{english ? 'Deliverables' : '交付成果'}</h3>
    {snapshot.artifacts.length === 0 ? <p>{english ? 'No saved deliverables yet.' : '尚无已保存的交付成果。'}</p> : <ul className="work-item-history-list">
      {snapshot.artifacts.map((artifact) => {
        const accepted = snapshot.task.acceptedArtifactIds.includes(artifact.id)
        const outdated = artifact.requirementVersion !== snapshot.task.currentRequirementVersion
        return <li key={artifact.id}>
          <strong>{artifact.name}</strong>
          <span>{english ? 'Content' : '内容'} v{artifact.contentVersion} · {english ? 'Requirement' : '要求'} v{artifact.requirementVersion}</span>
          {onOpenArtifact ? <button type="button" className="work-items-button work-items-button-quiet" onClick={() => onOpenArtifact(artifact)}>{english ? 'View this version' : '查看这一版'}</button> : null}
          {accepted ? <span>{english ? 'Accepted' : '已接受'}{outdated ? (english ? ' for an earlier requirement' : '（旧版要求）') : ''}</span> : <>
            {outdated ? <span>{english ? 'Based on an earlier requirement. Make a new version before accepting.' : '基于旧版要求，请按当前要求生成新版本后再接受。'}</span> : null}
            <button type="button" className="work-items-button" disabled={pending !== undefined || outdated} onClick={() => { void accept(artifact) }}>{pending === artifact.id ? (english ? 'Accepting…' : '正在接受…') : (english ? 'Accept this version' : '接受这一版')}</button>
          </>}
        </li>
      })}
    </ul>}
    {error ? <p role="alert">{error}</p> : null}
  </section>
}
