// The session panel's row of actions (components/sheet/Composer.tsx) shows as many as its width
// holds, in PRIORITY order, and More the rest (models/row-model.ts decides). Their widths are taken
// once per set of buttons, language and layout: all shown with their words, then as icons, within
// one task, so nothing flickers. The row's width does not depend on what it shows, so fitting it
// again never resizes it. It fits again when its width changes, a button shows or hides (no
// MokuPilot, not in git, asleep...), the language changes or the panel becomes the phone's sheet.
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { PHONE_QUERY } from '../models/panel-motion.ts'
import { fitRow, type RowButton } from '../models/row-model.ts'
import { useMediaQuery } from './useMediaQuery.ts'

/** The row's buttons, the most used first. */
export const PRIORITY: readonly string[] = [
  'sheet-focus',
  'sheet-mokupilot',
  'sheet-fork',
  'sheet-term',
  'sheet-changes',
  'sheet-history',
  'sheet-wake',
  'sheet-sleep',
  'sheet-restart',
  'sheet-archive',
  'sheet-new',
]

/** How the row shows its buttons. */
export interface ActionRow {
  /** As icons (the row's `.icons`), the first keeping its words. */
  icons: boolean
  /** The buttons the row leaves to More (`.over`); More itself when nothing is left over. */
  over: ReadonlySet<string>
}

/** Before the row is measured (the server's markup, the page as it starts): all of it, with words. */
export const WHOLE_ROW: ActionRow = { icons: false, over: new Set() }

/** The row's buttons on show, those the row itself may show, and what their widths go by. */
export interface RowButtons {
  all: HTMLElement[]
  row: HTMLElement[]
  key: string
}

/** The buttons' widths as last measured, and the buttons, words and layout they go by. */
export interface RowWidths {
  key: string
  buttons: RowButton[]
  more: number
}

export const NOT_MEASURED: RowWidths = { key: '', buttons: [], more: 0 }

/** The layout's width, whatever the panel's transform. */
const width = (el: Element): number => Number.parseFloat(getComputedStyle(el).width) || 0

/** The buttons of the row `actions` on show, in PRIORITY order (`narrow`: the phone's sheet). */
export function rowButtons(actions: HTMLElement, narrow: boolean): RowButtons {
  const byId = new Map<string, HTMLElement>()
  for (const el of Array.from(actions.children)) if (el instanceof HTMLElement) byId.set(el.id, el)
  const all = PRIORITY.map(id => byId.get(id)).filter((el): el is HTMLElement => !!el && !el.hidden)
  // A terminal wants a keyboard: on a phone it stays under More.
  const row = all.filter(el => !(narrow && el.id === 'sheet-term'))
  const key = [narrow, ...row.map(el => `${el.id} ${(el.textContent ?? '').trim()}`)].join('\n')
  return { all, row, key }
}

/** Every button shown with its words, then as icons; the row's classes as they were after. */
function measure(actions: HTMLElement, buttons: RowButtons): RowWidths {
  const classes = actions.className
  actions.classList.add('measuring')
  actions.classList.remove('icons')
  const words = buttons.row.map(width)
  actions.classList.add('icons')
  const more = actions.querySelector('#sheet-more')
  const widths = {
    key: buttons.key,
    buttons: buttons.row.map((el, i) => ({ words: words[i] ?? 0, icon: width(el) })),
    more: more ? width(more) : 0,
  }
  actions.className = classes
  return widths
}

/**
 * How the row `actions` shows `buttons` at its width now, with the widths it went by: `widths`
 * while the buttons, their words and the layout are the same, else measured anew. Null while the
 * row has no width (not laid out).
 */
export function fitActions(
  actions: HTMLElement,
  buttons: RowButtons,
  widths: RowWidths,
): { shown: ActionRow; widths: RowWidths } | null {
  const room = width(actions)
  if (!room) return null
  const measured = buttons.key === widths.key ? widths : measure(actions, buttons)
  const gap = Number.parseFloat(getComputedStyle(actions).columnGap) || 0
  // A button the row never shows (the terminal on a phone) keeps More on the row: room for it.
  // As icons only Focus keeps its words (app.css); in a phone's browser there is no Focus.
  const fit = fitRow(measured.buttons, room, {
    gap,
    more: measured.more,
    moreAlways: buttons.all.length > buttons.row.length,
    firstWords: buttons.row[0]?.id === 'sheet-focus',
  })
  const over = new Set(
    buttons.all
      .filter(el => {
        const i = buttons.row.indexOf(el)
        return i < 0 || i >= fit.shown
      })
      .map(el => el.id),
  )
  if (!over.size) over.add('sheet-more')
  return { shown: { icons: !fit.words, over }, widths: measured }
}

const sameRow = (a: ActionRow, b: ActionRow): boolean =>
  a.icons === b.icons && a.over.size === b.over.size && [...a.over].every(id => b.over.has(id))

/** How the row `actions` shows its buttons now, fitted again as it changes. */
export function useActionRow(actions: RefObject<HTMLElement | null>): ActionRow {
  const narrow = useMediaQuery(PHONE_QUERY)
  const [shown, setShown] = useState(WHOLE_ROW)
  const widths = useRef(NOT_MEASURED)
  const drawn = useRef('')
  const fit = useRef<() => ActionRow | null>(() => null)

  // On every draw: the buttons on show, their words and the layout as drawn; fitted again (and
  // drawn before the frame shows) only when one of them changed.
  useLayoutEffect(() => {
    const el = actions.current
    if (!el) return
    const fitted = (buttons: RowButtons): ActionRow | null => {
      const next = fitActions(el, buttons, widths.current)
      if (!next) return null
      widths.current = next.widths
      return next.shown
    }
    fit.current = () => fitted(rowButtons(el, narrow))
    const buttons = rowButtons(el, narrow)
    const now = `${buttons.key}\n${buttons.all.map(b => b.id).join(' ')}`
    if (now === drawn.current) return
    drawn.current = now
    const next = fitted(buttons)
    if (next) setShown(was => (sameRow(was, next) ? was : next))
  })

  // The row's width: fitted again and drawn at once, in the frame that resized it.
  useLayoutEffect(() => {
    const el = actions.current
    if (!el || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => {
      const next = fit.current()
      if (next) flushSync(() => setShown(was => (sameRow(was, next) ? was : next)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [actions])

  return shown
}
