import type { AppLocale } from '../../shared/locale.js'

const DOCS_FAQ_URLS: Record<AppLocale, string> = {
  zh: 'https://docs.ezdsh.com/guide/install#windows-%E5%AE%89%E8%A3%85%E6%AD%A5%E9%AA%A4',
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