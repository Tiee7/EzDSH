/** Persistent directories owned by EzDSH under Electron's userData path. */
export interface UserDataLayout {
  /** Root passed to the layout resolver. */
  root: string
  /** Per-run working directory; safe to clear after a completed run. */
  launchRoot: string
  /** DSH_HOME; never put this under the installed application directory. */
  harness: string
  /** Main-process and Runtime logs. */
  logs: string
  /** EzDSH metadata and migration state. */
  state: string
  /** Backups created before migrations or destructive settings changes. */
  backups: string
}
