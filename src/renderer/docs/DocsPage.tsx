import type { AppLocale } from '../../shared/locale.js'

const DOCS_FAQ_URLS: Record<AppLocale, string> = {
  zh: 'https://docs.ezdsh.com/faq',
  en: 'https://docs.ezdsh.com/en/faq'
}

export function DocsPage({ locale }: { locale: AppLocale }) {
  return (
    <iframe
      title="EzDSH Docs"
      src={DOCS_FAQ_URLS[locale]}
    />
  )
}