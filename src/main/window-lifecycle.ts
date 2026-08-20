interface WindowWithWebContents {
  readonly webContents: { readonly id: number }
  on(event: 'closed', listener: () => void): unknown
}

/** Capture window state before Electron destroys webContents during close. */
export function bindWindowClosedCleanup(
  window: WindowWithWebContents,
  watcherIds: Set<number>,
  onClosed: () => void,
): void {
  const webContentsId = window.webContents.id
  window.on('closed', () => {
    watcherIds.delete(webContentsId)
    onClosed()
  })
}
