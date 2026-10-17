// A panel's head: its title, its own tools, the place button and the close button. The head is
// where the panel is grabbed (components/panel/motion.ts), except on its buttons.
import type { MouseEvent, ReactNode } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { Dock } from '../../models/panel-layout.ts'
import { CloseGlyph, DockGlyph } from './glyphs.tsx'

export interface PanelHeadProps {
  /** What goes in `.sheet-title`. */
  title: ReactNode
  /** Buttons of the panel's own, before the place button. */
  tools?: ReactNode
  /** The viewer's dock, which the place button shows. */
  glyph: Dock
  /** The place menu is up from this panel's button. */
  menuOpen: boolean
  /** The session sheet's close button has an id (#sheet-close); the others do not. */
  closeId?: string | undefined
  onPlace?: ((button: HTMLElement) => void) | undefined
  onClose?: (() => void) | undefined
}

export function PanelHead({ title, tools, glyph, menuOpen, closeId, onPlace, onClose }: PanelHeadProps) {
  const t = useT()
  return (
    <header className="sheet-head">
      <div className="sheet-title">{title}</div>
      <div className="sheet-tools">
        {tools}
        <button
          type="button"
          className="icon-button"
          data-layout=""
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={t('panel.place')}
          aria-label={t('panel.place')}
          data-glyph={glyph}
          onClick={(e: MouseEvent<HTMLButtonElement>) => onPlace?.(e.currentTarget)}
        >
          <DockGlyph dock={glyph} />
        </button>
        <button
          type="button"
          className="icon-button"
          id={closeId}
          data-close=""
          title={t('sheet.close')}
          aria-label={t('sheet.closeLabel')}
          onClick={() => onClose?.()}
        >
          <CloseGlyph />
        </button>
      </div>
    </header>
  )
}
