import { useEffect, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  SOUND_IDS,
  type NotificationEventId,
  type NotificationSettings,
} from '../../shared/notifications.js'
import { previewNotificationSound } from '../notifications/audio.js'

interface NotificationsSectionProps {
  copy: AppCopy
}

type EventRow = {
  id: NotificationEventId
  onKey: 'questionOn' | 'approvalOn' | 'taskOn' | 'jobOn' | 'subagentOn' | 'errorOn'
  soundKey: 'questionSound' | 'approvalSound' | 'taskSound' | 'jobSound' | 'subagentSound' | 'errorSound'
  labelKey: 'settingsNotificationQuestion' | 'settingsNotificationApproval' | 'settingsNotificationTask' | 'settingsNotificationJob' | 'settingsNotificationSubagent' | 'settingsNotificationError'
  hintKey: 'settingsNotificationQuestionHint' | 'settingsNotificationApprovalHint' | 'settingsNotificationTaskHint' | 'settingsNotificationJobHint' | 'settingsNotificationSubagentHint' | 'settingsNotificationErrorHint'
}

const eventRows: readonly EventRow[] = [
  { id: 'question', onKey: 'questionOn', soundKey: 'questionSound', labelKey: 'settingsNotificationQuestion', hintKey: 'settingsNotificationQuestionHint' },
  { id: 'approval', onKey: 'approvalOn', soundKey: 'approvalSound', labelKey: 'settingsNotificationApproval', hintKey: 'settingsNotificationApprovalHint' },
  { id: 'task', onKey: 'taskOn', soundKey: 'taskSound', labelKey: 'settingsNotificationTask', hintKey: 'settingsNotificationTaskHint' },
  { id: 'job', onKey: 'jobOn', soundKey: 'jobSound', labelKey: 'settingsNotificationJob', hintKey: 'settingsNotificationJobHint' },
  { id: 'subagent', onKey: 'subagentOn', soundKey: 'subagentSound', labelKey: 'settingsNotificationSubagent', hintKey: 'settingsNotificationSubagentHint' },
  { id: 'error', onKey: 'errorOn', soundKey: 'errorSound', labelKey: 'settingsNotificationError', hintKey: 'settingsNotificationErrorHint' },
]

function soundLabel(sound: string): string {
  return sound.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ')
}

export function NotificationsSection({ copy }: NotificationsSectionProps): JSX.Element {
  const [settings, setSettings] = useState<NotificationSettings>({ ...DEFAULT_NOTIFICATION_SETTINGS })
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    void window.EzDSH.notifications.getSettings()
      .then((next) => {
        if (active) setSettings(next)
      })
      .catch(() => {
        if (active) setError(copy.settingsNotificationsSaveFailed)
      })
    const unsubscribe = window.EzDSH.notifications.onSettingsChange((next) => {
      if (active) setSettings(next)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [copy.settingsNotificationsSaveFailed])

  const save = (next: NotificationSettings): void => {
    setSettings(next)
    setError(undefined)
    void window.EzDSH.notifications.setSettings(next).catch(() => {
      setError(copy.settingsNotificationsSaveFailed)
    })
  }

  const toggle = (key: keyof Pick<NotificationSettings, 'master' | 'nativeOn'>): void => {
    save({ ...settings, [key]: !settings[key] })
  }

  const toggleEvent = (row: EventRow): void => {
    save({ ...settings, [row.onKey]: !settings[row.onKey] })
  }

  const preview = (row: EventRow): void => {
    previewNotificationSound(settings, row.id)
  }

  return (
    <section className="settings-card settings-notifications-card">
      <div className="settings-card-header">
        <div className="settings-card-heading-row">
          <div>
            <p className="settings-label">{copy.settingsNotifications}</p>
            <p className="settings-hint settings-notifications-hint">{copy.settingsNotificationsHint}</p>
          </div>
        </div>
      </div>
      <div className="settings-item">
        <div className="settings-item-text">
          <p className="settings-label">{copy.settingsNotificationsEnable}</p>
          <p className="settings-hint">{copy.settingsNotificationsEnableHint}</p>
        </div>
        <label className="settings-notification-toggle">
          <input type="checkbox" checked={settings.master} onChange={() => toggle('master')} />
          <span>{settings.master ? copy.settingsNotificationsOn : copy.settingsNotificationsOff}</span>
        </label>
      </div>
      <div className="settings-item">
        <div className="settings-item-text">
          <p className="settings-label">{copy.settingsNotificationsDesktop}</p>
          <p className="settings-hint">{copy.settingsNotificationsDesktopHint}</p>
        </div>
        <label className="settings-notification-toggle">
          <input type="checkbox" checked={settings.nativeOn} onChange={() => toggle('nativeOn')} />
          <span>{settings.nativeOn ? copy.settingsNotificationsOn : copy.settingsNotificationsOff}</span>
        </label>
      </div>
      <div className="settings-item settings-notification-volume-row">
        <div className="settings-item-text">
          <p className="settings-label">{copy.settingsNotificationsVolume}</p>
        </div>
        <div className="settings-notification-volume-control">
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={settings.volume}
            aria-label={copy.settingsNotificationsVolume}
            onChange={(event) => save({ ...settings, volume: Number(event.target.value) })}
          />
          <span className="settings-value">{settings.volume}%</span>
        </div>
      </div>
      {eventRows.map((row) => (
        <div className="settings-item settings-notification-event" key={row.id}>
          <div className="settings-item-text">
            <p className="settings-label">{copy[row.labelKey]}</p>
            <p className="settings-hint">{copy[row.hintKey]}</p>
          </div>
          <div className="settings-notification-controls">
            <select
              className="settings-notification-select"
              value={settings[row.soundKey]}
              aria-label={`${copy[row.labelKey]} ${copy.settingsNotificationsSound}`}
              onChange={(event) => save({ ...settings, [row.soundKey]: event.target.value as NotificationSettings[EventRow['soundKey']] })}
            >
              {SOUND_IDS.map((sound) => <option key={sound} value={sound}>{soundLabel(sound)}</option>)}
            </select>
            <button className="settings-action" type="button" onClick={() => preview(row)}>{copy.settingsNotificationsPreview}</button>
            <label className="settings-notification-toggle">
              <input type="checkbox" checked={settings[row.onKey]} onChange={() => toggleEvent(row)} />
              <span>{settings[row.onKey] ? copy.settingsNotificationsOn : copy.settingsNotificationsOff}</span>
            </label>
          </div>
        </div>
      ))}
      {error ? <p className="settings-error settings-notifications-error" role="alert">{error}</p> : null}
    </section>
  )
}
