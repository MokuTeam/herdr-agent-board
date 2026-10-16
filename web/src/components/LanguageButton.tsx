// "EN": switches the board to the next language, on this page at once and in the config.
import { LANGUAGES, translator } from '../../../src/core/i18n/translator.ts'
import { api, errorText } from '../api/client.ts'
import { useLanguage } from '../i18n/I18nProvider.tsx'
import { nextLanguage } from '../models/language.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { GlobeIcon } from './icons.tsx'

export function LanguageButton() {
  const { t, choose } = useLanguage()
  const { data, canEdit, toast } = useBoardContext()
  const names = data?.languages ?? LANGUAGES

  async function switchLanguage(): Promise<void> {
    if (!canEdit) return toast(t('live.off'), true)
    const next = nextLanguage(Object.keys(names), t.lang)
    choose(next)
    try {
      await api.post('/api/settings', { language: next })
    } catch (err) {
      toast(errorText(err, translator(next)), true)
    }
  }

  return (
    <button
      type="button"
      className="pill-toggle"
      id="lang"
      title={t('tb.lang', { name: names[t.lang] ?? t.lang })}
      disabled={!canEdit}
      onClick={() => void switchLanguage()}
    >
      <GlobeIcon />
      <span id="lang-code">{t.lang.toUpperCase()}</span>
    </button>
  )
}
