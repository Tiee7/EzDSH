import { useEffect, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import {
  isBuiltinNavItem,
  isValidWebUrl,
  pinFixedTabs,
  validateNavConfig,
  type AppTab,
  type CustomNavItem,
  type NavConfig,
  type NavItem
} from '../../shared/navigation.js'

interface NavigationSectionProps {
  copy: AppCopy
}

interface EditingDraft {
  label: string
  url: string
}

function builtinLabel(id: AppTab, copy: AppCopy): string {
  switch (id) {
    case 'harness':
      return copy.tabHarness
    case 'store':
      return copy.tabStore
    case 'presets':
      return copy.tabPresets
    case 'docs':
      return copy.tabDocs
    case 'settings':
      return copy.tabSettings
  }
}

/** Manage which tabs show in the top tab bar and in which order. */
export function NavigationSection({ copy }: NavigationSectionProps): JSX.Element {
  const [items, setItems] = useState<NavItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [editingId, setEditingId] = useState<string>()
  const [draft, setDraft] = useState<EditingDraft>({ label: '', url: '' })
  const [dragIndex, setDragIndex] = useState<number>()
  const [dropBoundary, setDropBoundary] = useState<number>()

  useEffect(() => {
    let active = true
    void window.EzDSH.navigation.getConfig()
      .then((config: NavConfig) => {
        if (active) setItems(config.items)
      })
      .catch(() => {
        if (active) setSaveError(copy.navSaveFailed)
      })
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [copy.navSaveFailed])

  const persist = async (next: NavItem[]): Promise<void> => {
    const pinned = pinFixedTabs(next)
    const error = validateNavConfig({ items: pinned })
    if (error !== undefined) {
      setSaveError(error)
      return
    }
    setBusy(true)
    setSaveError(undefined)
    try {
      await window.EzDSH.navigation.setConfig({ items: pinned })
      setItems(pinned)
    } catch {
      setSaveError(copy.navSaveFailed)
    } finally {
      setBusy(false)
    }
  }

  const toggleBuiltin = (id: string): void => {
    const next = items.map((item) =>
      isBuiltinNavItem(item) && item.id === id ? { ...item, visible: !item.visible } : item
    )
    void persist(next)
  }

  const startEdit = (item: CustomNavItem): void => {
    setEditingId(item.id)
    setDraft({ label: item.label, url: item.url })
  }

  const startAdd = (): void => {
    const id = crypto.randomUUID()
    setEditingId(id)
    setDraft({ label: '', url: '' })
    setItems([...items, { kind: 'custom', id, label: '', url: '' }])
  }

  const saveEdit = (item: CustomNavItem): void => {
    const label = draft.label.trim()
    const url = draft.url.trim()
    if (label === '') {
      setSaveError(copy.navNameRequired)
      return
    }
    if (!isValidWebUrl(url)) {
      setSaveError(copy.navInvalidUrl)
      return
    }
    const next = items.map((i) => (i.id === item.id ? { ...item, label, url } : i))
    setEditingId(undefined)
    void persist(next)
  }

  const cancelEdit = (item: CustomNavItem): void => {
    setEditingId(undefined)
    if (item.label === '' && item.url === '') {
      setItems(items.filter((i) => i.id !== item.id))
    }
  }

  const deleteItem = (id: string): void => {
    void persist(items.filter((item) => item.id !== id))
  }

  const onListDragOver = (event: React.DragEvent<HTMLUListElement>): void => {
    event.preventDefault()
    if (dragIndex === undefined || editingId !== undefined) return
    const rows = Array.from(event.currentTarget.children) as HTMLLIElement[]
    let boundary = 0
    for (let i = 0; i < rows.length; i += 1) {
      const rect = rows[i].getBoundingClientRect()
      if (event.clientY < rect.top + rect.height / 2) {
        boundary = i
        break
      }
      boundary = i + 1
    }
    setDropBoundary(Math.min(Math.max(boundary, 1), items.length - 1))
  }

  const onDrop = (event: React.DragEvent<HTMLUListElement>): void => {
    event.preventDefault()
    if (dragIndex === undefined) {
      setDropBoundary(undefined)
      return
    }
    let to = dropBoundary ?? dragIndex
    if (dragIndex < to) to -= 1
    if (to !== dragIndex) {
      const next = [...items]
      const [moved] = next.splice(dragIndex, 1)
      next.splice(to, 0, moved)
      void persist(next)
    }
    setDragIndex(undefined)
    setDropBoundary(undefined)
  }

  if (!loaded) {
    return <p className="settings-hint">{copy.loading}</p>
  }

  return (
    <div className="nav-section">
      <p className="settings-hint">{copy.navSectionHint}</p>
      <p className="settings-hint nav-shortcut-hint">{copy.navShortcutHint}</p>
      <ul className="nav-list" onDragOver={onListDragOver} onDrop={onDrop}>
        {items.map((item, index) => {
          const movable = editingId === undefined && !(isBuiltinNavItem(item) && item.locked)
          return (
            <li
              key={item.id}
              className={`nav-row ${dragIndex === index ? 'nav-row-dragging' : ''} ${editingId === item.id ? 'nav-row-editing' : ''} ${dropBoundary === index ? 'nav-row-drop-above' : ''}`}
              draggable={movable}
              onDragStart={movable ? () => setDragIndex(index) : undefined}
              onDragEnd={movable ? () => {
                setDragIndex(undefined)
                setDropBoundary(undefined)
              } : undefined}
            >
              {movable ? <span className="nav-drag-handle" aria-hidden="true">⋮⋮</span> : <span className="nav-drag-spacer" aria-hidden="true" />}
              {isBuiltinNavItem(item) ? (
                <>
                  <span className="nav-label">{builtinLabel(item.id, copy)}</span>
                  <span className="nav-badge">{copy.navSystemBadge}</span>
                  <button
                    type="button"
                    className={`nav-toggle ${item.visible ? 'nav-toggle-on' : ''}`}
                    disabled={item.locked || busy}
                    aria-pressed={item.visible}
                    onClick={() => toggleBuiltin(item.id)}
                  >
                    {item.visible ? copy.navHide : copy.navShow}
                  </button>
                </>
              ) : editingId === item.id ? (
                <>
                  <input
                    className="nav-input"
                    value={draft.label}
                    placeholder={copy.navName}
                    onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                  />
                  <input
                    className="nav-input nav-input-url"
                    value={draft.url}
                    placeholder={copy.navUrlPlaceholder}
                    onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                  />
                  <button type="button" className="nav-action" disabled={busy} onClick={() => saveEdit(item)}>{copy.navSave}</button>
                  <button type="button" className="nav-action" disabled={busy} onClick={() => cancelEdit(item)}>{copy.navCancel}</button>
                </>
              ) : (
                <>
                  <span className="nav-label">{item.label}</span>
                  <code className="nav-url">{item.url}</code>
                  <button type="button" className="nav-action" disabled={busy} onClick={() => startEdit(item)}>{copy.navEdit}</button>
                  <button type="button" className="nav-action nav-action-danger" disabled={busy} onClick={() => deleteItem(item.id)}>{copy.navDelete}</button>
                </>
              )}
            </li>
          )
        })}
      </ul>
      <button type="button" className="nav-add" disabled={busy} onClick={startAdd}>{copy.navAddLink}</button>
      {saveError !== undefined ? <p className="nav-error" role="alert">{saveError}</p> : null}
    </div>
  )
}
