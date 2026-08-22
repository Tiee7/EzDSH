import type { AppCopy, AppLocale } from '../../shared/locale.js'
import { StoreBrowser } from '../store/StoreBrowser.js'

/** The preset store tab page. */
export function PresetPage({ copy, locale }: { copy: AppCopy; locale: AppLocale }): JSX.Element {
  return (
    <div className="store-page">
      <StoreBrowser kind="preset" copy={copy} locale={locale} />
    </div>
  )
}
