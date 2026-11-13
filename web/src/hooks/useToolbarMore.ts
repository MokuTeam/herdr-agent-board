// The toolbar's More: what left the row (hooks/useToolbarFit.ts) as a menu out of the button, downward, on
// the board's one menu (hooks/useContextMenus.ts), as the gear's menu and the folded controls' pills
// have theirs. The button's aria-expanded is kept with the menu: true as it opens, false whenever a
// menu goes and none is up, which another menu opening in its place does too.
import { useEffect, useState } from 'react'
import type { MenuEngine } from '../components/menu/menu-engine.ts'
import { useLanguage } from '../i18n/I18nProvider.tsx'
import type { ToolbarEntry } from '../models/toolbar-fit.ts'
import { useLatest } from './useLatest.ts'

export interface ToolbarMenu {
  /** More was pressed (`keyboard`: from the keys, the first entry lit); `onPick` hears the id of the entry chosen. */
  open(button: HTMLElement, keyboard: boolean, entries: readonly ToolbarEntry[], onPick: (id: string) => void): void
  /** The menu up is More's (its aria-expanded). */
  expanded: boolean
}

export interface ToolbarMenuDeps {
  menu: Pick<MenuEngine, 'open' | 'openNow' | 'isOpen'>
  /** The pointer is a finger. */
  coarse(): boolean
  /** More's menu is up now, or is not. */
  expanded(on: boolean): void
  /** The menu's name for screen readers. */
  label(): string
}

export interface ToolbarMenus {
  open: ToolbarMenu['open']
  /** Keeps what the button says with the menu, until the function it gives back is called. */
  watch(): () => void
}

export function toolbarMenus(deps: ToolbarMenuDeps): ToolbarMenus {
  return {
    open(button, keyboard, entries, onPick) {
      const rect = button.getBoundingClientRect()
      deps.expanded(true)
      deps.menu.open(
        entries.map(e => ({
          id: e.id,
          label: e.label,
          ...(e.count !== undefined && { count: e.count }),
          ...(e.tint !== undefined && { tint: e.tint }),
          ...(e.hint !== undefined && { hint: e.hint }),
          ...(e.disabled && { disabled: true }),
          ...(e.reason !== undefined && { reason: e.reason }),
        })),
        {
          x: rect.right,
          y: rect.bottom + 6,
          source: keyboard ? 'keyboard' : deps.coarse() ? 'touch' : 'mouse',
          origin: button,
          label: deps.label(),
          onPick: id => onPick(id),
        },
      )
    },
    watch: () =>
      deps.menu.openNow.subscribe(() => {
        if (!deps.menu.isOpen()) deps.expanded(false)
      }),
  }
}

/** More's menu for the page: `menu` is the board's one menu. */
export function useToolbarMenu(menu: MenuEngine): ToolbarMenu {
  const { t } = useLanguage()
  const latest = useLatest(t)
  const [expanded, setExpanded] = useState(false)
  const [menus] = useState(() =>
    toolbarMenus({
      menu,
      coarse: () => matchMedia('(pointer: coarse)').matches,
      expanded: setExpanded,
      label: () => latest.current('tb.more'),
    }),
  )
  useEffect(() => menus.watch(), [menus])
  return { open: menus.open, expanded }
}
