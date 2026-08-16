import type { AppCopy } from '../../shared/locale.js'
import { StoreBrowser } from '../store/StoreBrowser.js'

/** The preset store tab page. */
export function PresetPage({ copy }: { copy: AppCopy }): JSX.Element {
  return <StoreBrowser kind="preset" copy={copy} />
}
