// A folded toolbar control's pill (components/SegmentPick.tsx; the lanes control, the profile
// switch): its choices as a menu out of it, downward, the one on show checked
// (models/segment-fold.ts segmentMenu); a pick does what that segment's click does. The pill's
// aria-expanded kept with the menu, as the gear's is (hooks/useSettingsMenu.ts settingsGear).
import { useEffect, useState } from 'react'
import type { MenuEngine } from '../components/menu/menu-engine.ts'
import { type SegmentOption, segmentMenu } from '../models/segment-fold.ts'

/** What a folded control offers: its name, its choices, the one on show, and what a pick does. */
export interface SegmentChoices {
  /** The menu's name: the control's ("Categories", "Profiles"). */
  label: string
  options: readonly SegmentOption[]
  picked: string
  /** Each count in its choice's color, as the profile switch has them. */
  tint: boolean
  /** What a click on that segment does. */
  onPick(id: string): void
}

export interface SegmentPicks {
  /** A pill pressed (`id`: its control's, `lanes` or `profiles`; `keyboard`: from the keys, the first choice lit). */
  open(id: string, button: HTMLElement, keyboard: boolean, choices: SegmentChoices): void
  /** The control whose menu is up (its pill's aria-expanded), if one is. */
  expanded: string | null
}

export interface SegmentPickDeps {
  menu: Pick<MenuEngine, 'open' | 'openNow' | 'isOpen'>
  /** The pointer is a finger. */
  coarse(): boolean
  /** The control whose menu is up now, null once none is. */
  expanded(id: string | null): void
}

export interface SegmentPickMenus {
  open: SegmentPicks['open']
  /** Keeps what the pills say with the menu, until the function it gives back is called. */
  watch(): () => void
}

/**
 * The pills' menus on the board's one menu: a pill says its menu is up as it opens it; whenever a
 * menu goes and none is up, which another menu opening in its place does too, none says so.
 */
export function segmentPickMenus(deps: SegmentPickDeps): SegmentPickMenus {
  return {
    open(id, button, keyboard, choices) {
      const rect = button.getBoundingClientRect()
      deps.expanded(id)
      deps.menu.open(segmentMenu(choices.options, choices.picked, choices.tint), {
        x: rect.left,
        y: rect.bottom + 4,
        source: keyboard ? 'keyboard' : deps.coarse() ? 'touch' : 'mouse',
        origin: button,
        label: choices.label,
        onPick: pick => choices.onPick(pick),
      })
    },
    watch: () =>
      deps.menu.openNow.subscribe(() => {
        if (!deps.menu.isOpen()) deps.expanded(null)
      }),
  }
}

/** The pills' menus for the page: `menu` is the board's one menu (hooks/useContextMenus.ts). */
export function useSegmentPicks(menu: MenuEngine): SegmentPicks {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [picks] = useState(() =>
    segmentPickMenus({ menu, coarse: () => matchMedia('(pointer: coarse)').matches, expanded: setExpanded }),
  )
  useEffect(() => picks.watch(), [picks])
  return { open: picks.open, expanded }
}
