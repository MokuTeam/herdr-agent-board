// The terminal board's keys on the web board, while it shows the Terminal style (which key does what:
// models/terminal-keys.ts). The selected card is the one with the focus: moving focuses the next
// card on screen (src/core/grid-nav.ts, the terminal board's own rules: a grid on a wide page, a
// list on a narrow one), and the card's keys act on it, else on the session open in the panel. They
// do what the card's menu does (its items, gray ones included, from hooks/useContextMenus.ts). The
// board's own keys go first (hooks/useBoardKeys.ts calls this only for a key they leave).
import { toggledColumn } from '../../../src/core/board-keys.ts'
import { type Dir, type GridLane, gridStep, listStep } from '../../../src/core/grid-nav.ts'
import { lookNow } from '../models/look.ts'
import type { MenuItem } from '../models/menu-model.ts'
import { type CardAct, terminalKey } from '../models/terminal-keys.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import type { ContextMenus } from './useContextMenus.ts'
import { useLatest } from './useLatest.ts'

/** What the board's keys know when they leave a key. */
export interface LeftKey {
  typing: boolean
  quickLook: boolean
}

const shown = (el: HTMLElement): boolean => el.offsetParent !== null
const cardOf = (el: Element | null): HTMLElement | null => el?.closest<HTMLElement>('#board .card[data-key]') ?? null
const isSession = (key: string | undefined): key is string => !!key && !key.startsWith('launch:')

/** The cards on screen as the grid they make: lanes on show, their columns, the cards in each. */
function boardGrid(): GridLane[] {
  return [...document.querySelectorAll<HTMLElement>('#board .lane')].filter(shown).map(lane => ({
    cols: [...lane.querySelectorAll<HTMLElement>(':scope > .lane-grid > .col')].map(col =>
      [...col.querySelectorAll<HTMLElement>(':scope > .card[data-key]:not(.ghost)')]
        .filter(shown)
        .map(card => ({ key: card.dataset.key ?? '' })),
    ),
  }))
}

/** A wide page shows the column heads and lays the lanes out as a grid; a narrow one stacks them. */
const wide = (): boolean => {
  const heads = document.getElementById('columns-head')
  return !!heads && getComputedStyle(heads).display !== 'none'
}

function focusCard(key: string): void {
  const card = document.querySelector<HTMLElement>(`#board .card[data-key="${CSS.escape(key)}"]`)
  if (!card) return
  card.focus({ preventScroll: true, focusVisible: true } as FocusOptions)
  card.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/** Runs `step` on the next frames until it says it is done (a panel opening, its fields showing), at most `frames`. */
function untilDone(step: () => boolean, frames = 30): void {
  if (step() || frames <= 0) return
  requestAnimationFrame(() => untilDone(step, frames - 1))
}

export function useTerminalKeys(
  menus: Pick<ContextMenus, 'cardMenu' | 'menu'>,
): (e: KeyboardEvent, left: LeftKey) => boolean {
  const board = useBoardContext()
  const latest = useLatest({ board, menus })

  return (e, left) => {
    if (lookNow(document.documentElement) !== 'terminal') return false
    const { board: b, menus: m } = latest.current
    const active = document.activeElement
    const onBoard = !active || active === document.body || !!document.getElementById('board')?.contains(active)
    const key = terminalKey(e, { ...left, onBoard, column: b.ui.column })
    if (!key) return false
    const focused = cardOf(active)?.dataset.key
    const selected = isSession(focused) ? focused : b.ui.open

    /** The card's menu item `id`, as a pick would run it; a gray one says why not. */
    function pick(target: string, id: string): void {
      const menu = m.cardMenu(target)
      const item = menu?.menu.items.find((i): i is MenuItem => 'id' in i && i.id === id)
      if (!menu || !item) return
      if (item.disabled) return void (item.reason && b.toast(item.reason, true))
      menu.menu.pick(id, item)
    }

    function act(target: string, what: CardAct): void {
      if (what === 'message') {
        b.dispatch({ type: 'open', key: target, compose: true })
        return
      }
      if (what === 'wait') {
        // What it waits for is a field of the card in the panel: open, the empty fields shown, there.
        if (b.ui.open !== target) b.dispatch({ type: 'open', key: target })
        untilDone(() => {
          const field = document.getElementById('wait')
          if (field instanceof HTMLTextAreaElement && !field.disabled) {
            field.focus()
            field.setSelectionRange(field.value.length, field.value.length)
            return true
          }
          const toggle = document.getElementById('sheet-properties-toggle')
          if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click()
          return false
        })
        return
      }
      if (what === 'category') {
        // The lanes as the menu's "Move to category" has them, at the card.
        const menu = m.cardMenu(target)
        const item = menu?.menu.items.find((i): i is MenuItem => 'id' in i && i.id === 'category')
        if (!menu || !item) return
        if (item.disabled || !item.submenu) return void (item.reason && b.toast(item.reason, true))
        m.menu.open(item.submenu, {
          x: menu.at.x,
          y: menu.at.y,
          source: 'keyboard',
          label: item.label,
          onPick: id => menu.menu.pick(id),
          origin: menu.origin,
        })
        return
      }
      pick(target, what)
    }

    function move(dir: Dir): void {
      const grid = boardGrid()
      const list = grid.flatMap(lane => lane.cols.flat())
      const from = focused && list.some(c => c.key === focused) ? focused : null
      const next = !from
        ? listStep(list, null, dir === 'last' ? 'last' : 'home')
        : wide() && dir !== 'home' && dir !== 'last'
          ? gridStep(grid, from, dir)
          : listStep(list, from, dir)
      if (next) focusCard(next)
    }

    e.preventDefault()
    switch (key.kind) {
      case 'move':
        move(key.dir)
        break
      case 'card':
        if (selected) act(selected, key.act)
        break
      case 'lane': {
        // As the lanes control lists them: 0 is All.
        const ids = [...document.querySelectorAll<HTMLElement>('#lanes button[data-id]')].map(el => el.dataset.id)
        const id = ids[key.n]
        if (id) b.dispatch({ type: 'filter', id })
        break
      }
      case 'column':
        b.dispatch({ type: 'column', id: toggledColumn(b.ui.column, key.column) })
        break
      case 'allColumns':
        b.dispatch({ type: 'column', id: null })
        break
      case 'refresh':
        b.resume()
        break
      case 'close':
        if (b.ui.open) b.dispatch({ type: 'open', key: null })
        break
    }
    return true
  }
}
