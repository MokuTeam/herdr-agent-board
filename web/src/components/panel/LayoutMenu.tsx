// The place menu: right, left, bottom, floating, and the default size. It opens out of a panel's
// place button (layout-menu.ts moves it and takes its keys); the dock checked is the one it opened
// with.
import { type Ref, useLayoutEffect, useRef } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import { DOCKS, type Dock } from '../../models/panel-layout.ts'
import { useStore } from '../../state/store.ts'
import { CheckMark, DockGlyph, ResetGlyph } from './glyphs.tsx'
import type { PanelPlace } from './place.ts'

export function LayoutMenu({ place }: { place: PanelPlace }) {
  const { menu } = useStore(place.state)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => (ref.current ? place.menu.attach(ref.current) : undefined), [place])
  return <LayoutMenuView checked={menu.checked} menuRef={ref} />
}

/** The menu as drawn; `checked` is null before it first opened (no item says checked or not yet). */
export function LayoutMenuView({ checked, menuRef }: { checked: Dock | null; menuRef?: Ref<HTMLDivElement> }) {
  const t = useT()
  return (
    // Shown and hidden by layout-menu.ts: `hidden` is only where it starts.
    <div className="layout-menu" role="menu" hidden ref={menuRef}>
      {DOCKS.map(dock => (
        <button
          key={dock}
          type="button"
          role="menuitemradio"
          data-dock={dock}
          tabIndex={-1}
          aria-checked={checked === null ? undefined : checked === dock}
        >
          <DockGlyph dock={dock} />
          <span>{t(`panel.${dock}`)}</span>
          <CheckMark />
        </button>
      ))}
      {/* biome-ignore lint/a11y/useSemanticElements: the menu's separator as before; an <hr> would take the menu's button styles' place */}
      <div className="layout-sep" role="separator" />
      <button type="button" role="menuitem" data-reset="" tabIndex={-1}>
        <ResetGlyph />
        <span>{t('panel.reset')}</span>
      </button>
    </div>
  )
}
