import type { AppCopy } from '../../shared/locale.js'
import { StoreBrowser } from './StoreBrowser.js'

/** The skill store tab page. */
export function StorePage({ copy }: { copy: AppCopy }): JSX.Element {
  return <StoreBrowser kind="skill" copy={copy} />
}
