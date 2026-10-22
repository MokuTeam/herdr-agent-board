// The board's context menu as drawn: each level — the menu, an open submenu, one fading away — a
// .menu of its own in <body> beside the page (the focus manager leaves menus out of the inert
// page, hooks/useModalFocus.ts), its items, and under them the reason gray items share. Where it
// goes, how it moves and what the keys and the pointer do are menu-engine.ts's.
import { type Ref, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { isSeparator } from '../../models/menu-model.ts'
import { useStore } from '../../state/store.ts'
import { classNames } from '../class-names.ts'
import { MenuItem } from './MenuItem.tsx'
import type { LayerView, MenuEngine } from './menu-engine.ts'

export function ContextMenu({ engine }: { engine: MenuEngine }) {
  const { layers } = useStore(engine.view)
  if (typeof document === 'undefined') return null
  return createPortal(
    layers.map(layer => <Level key={layer.id} layer={layer} engine={engine} />),
    document.body,
  )
}

function Level({ layer, engine }: { layer: LayerView; engine: MenuEngine }) {
  const ref = useRef<HTMLDivElement>(null)
  // Drawn: the engine places it, grows it and gives it the pointer.
  useLayoutEffect(() => (ref.current ? engine.attach(layer.id, ref.current) : undefined), [engine, layer.id])
  return <MenuLayer layer={layer} menuRef={ref} />
}

/** One level as drawn for one state. */
export function MenuLayer({ layer, menuRef }: { layer: LayerView; menuRef?: Ref<HTMLDivElement> }) {
  return (
    <div
      className={classNames('menu', !layer.checks && 'no-checks', layer.touch && 'touch')}
      role="menu"
      tabIndex={-1}
      aria-label={layer.label || undefined}
      aria-activedescendant={layer.active >= 0 ? `${layer.id}-${layer.active}` : undefined}
      ref={menuRef}
    >
      {/* A level's items never change but for their checks; ids may repeat (a pinned card's Auto is a column too). */}
      {layer.items.map((it, i) =>
        isSeparator(it) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          // biome-ignore lint/a11y/useSemanticElements: the menu's separator as before; an <hr> would take the stylesheet's place
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <MenuItem
            // biome-ignore lint/suspicious/noArrayIndexKey: as above
            key={i}
            item={it}
            id={`${layer.id}-${i}`}
            index={i}
            checks={layer.checks}
            active={layer.active === i}
            expanded={layer.sub === i}
          />
        ),
      )}
      {layer.note && (
        <div className="menu-note" role="note">
          {layer.note}
        </div>
      )}
    </div>
  )
}
