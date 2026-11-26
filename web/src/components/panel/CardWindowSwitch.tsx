import { useT } from '../../i18n/I18nProvider.tsx'
import type { CardWindowView } from '../../models/card-window.ts'
import { DockGlyph } from './glyphs.tsx'

export function CardWindowSwitch({ view, onToggle }: { view: CardWindowView; onToggle(): void }) {
  const t = useT()
  const next = view === 'modal' ? 'right' : 'float'
  const label = t(view === 'modal' ? 'panel.showSide' : 'panel.showModal')
  return (
    <button
      type="button"
      className="icon-button"
      data-card-window=""
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      <DockGlyph dock={next} />
    </button>
  )
}
