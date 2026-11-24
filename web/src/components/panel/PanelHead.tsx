// A panel's head: optional back control, its title, its own tools, the place button and the close
// button. The head is where the panel is grabbed (components/panel/motion.ts), except on its buttons.
import type { MouseEvent, ReactNode } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { Dock } from '../../models/panel-layout.ts'
import { ChevLeftIcon } from '../icons.tsx'
import { CloseGlyph, DockGlyph } from './glyphs.tsx'

export interface PanelBack {
  /** Parent name shown beside the chevron (e.g. "Settings"). */
  label: string
  /** Accessible label and tooltip (defaults to `label`). */
  ariaLabel?: string | undefined
  onBack(): void
}

export interface PanelHeadProps {
  /** Back control left of the title (e.g. from an inner Settings page back to Settings, #679). */
  back?: PanelBack | undefined
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

export function PanelHead({ back, title, tools, glyph, menuOpen, closeId, onPlace, onClose }: PanelHeadProps) {
  const t = useT()
  return (
    <header className="sheet-head">
      {back && (
        <button
          type="button"
          className="sheet-back"
          aria-label={back.ariaLabel ?? back.label}
          title={back.ariaLabel ?? back.label}
          onClick={() => back.onBack()}
        >
          <ChevLeftIcon />
          <span>{back.label}</span>
        </button>
      )}
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
