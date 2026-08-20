interface RestartableApp {
  relaunch(options: { args: string[] }): void
  quit(): void
}

/** electron-vite owns the dev server and exits when the Electron child exits. */
export function shouldRelaunchWorkspace(isPackaged: boolean): boolean {
  return isPackaged
}

/** Queue a relaunch and close the current Electron instance through its normal lifecycle. */
export function restartApplication(app: RestartableApp, args: string[]): void {
  app.relaunch({ args })
  app.quit()
}
