// The staircase (models/stairs.ts, styles/stairs.css): while the board is too narrow to give each
// column with cards a card's readable width, <html> has data-stairs and the staircase's sizes
// (models/stairs.ts stairsLayout): the card's width (--stair-card), each column's step, where its
// cards and its head start (--stair-<column>), the row of the heads its head is in
// (--stair-row-<column>), and where the last column ends (--stair-end). What it goes by: the page's and the
// board's widths (the window, a panel docked at a side), which columns have cards on show (every
// draw of the toolbar), and the heads' widths (their counts, the language, the style). The widths
// come from a ResizeObserver on the toolbar (the page's width), its row of heads (as wide as the
// board's columns) and each head: none of them grows or shrinks with the staircase's cards. A board
// with room, a phone and a narrow window never get the attribute: their page is as it was.
import { useEffect, useLayoutEffect, useState } from 'react'
import { type BoardRoom, type HeadSize, type StairsLayout, stairsLayout, stairsWanted } from '../models/stairs.ts'
import type { ColumnHead } from '../models/toolbar.ts'

/** What the staircase reads and writes in the page. */
export interface StairsPage {
  /** data-stairs on <html>; off, the sizes go with it. */
  turn(on: boolean): void
  /** The column heads' widths, in their order, as the page lays them out now. */
  heads(): HeadSize[]
  /** The staircase's sizes (--stair-*). */
  sizes(layout: StairsLayout): void
}

export interface Stairs {
  /** The page's and the board's widths as they are now (null: no board). */
  room(room: BoardRoom | null): void
  /** Which columns have cards on show, after every draw of the toolbar. */
  fit(heads: readonly Pick<ColumnHead, 'vacant'>[]): void
}

export function stairs(page: StairsPage): Stairs {
  let room: BoardRoom | null = null
  let heads: readonly Pick<ColumnHead, 'vacant'>[] = []
  let on = false
  let written = ''
  const apply = () => {
    const want = room !== null && stairsWanted(heads, room)
    if (want !== on) {
      on = want
      written = ''
      page.turn(on)
    }
    if (!on || !room) return
    // Read with the heads laid out as the staircase has them.
    const layout = stairsLayout(page.heads(), room)
    const key = JSON.stringify(layout)
    if (key === written) return
    written = key
    page.sizes(layout)
  }
  return {
    room(next) {
      room = next
      apply()
    },
    fit(next) {
      heads = next
      apply()
    },
  }
}

/** The toolbar's column heads. */
const headsNow = (): HTMLElement[] => [
  ...(document.getElementById('columns-head')?.querySelectorAll<HTMLElement>('.col-head') ?? []),
]

/** The page's own: <html> and the toolbar's column heads. */
export function documentStairs(): StairsPage {
  const written = new Set<string>()
  return {
    turn(on) {
      const html = document.documentElement
      if (on) html.setAttribute('data-stairs', '')
      else {
        html.removeAttribute('data-stairs')
        for (const name of written) html.style.removeProperty(name)
        written.clear()
      }
      // The heads go sideways with the board (components/Board.tsx), from where it is now.
      const heads = document.getElementById('columns-head')
      const board = document.getElementById('board')
      if (heads && board && heads.scrollLeft !== board.scrollLeft) heads.scrollLeft = board.scrollLeft
    },
    heads: () => headsNow().map(el => ({ id: el.dataset.col ?? '', width: el.getBoundingClientRect().width })),
    sizes({ card, steps, rows, end }) {
      const set = (name: string, value: string) => {
        written.add(name)
        document.documentElement.style.setProperty(name, value)
      }
      set('--stair-card', `${card}px`)
      set('--stair-end', `${end}px`)
      for (const [id, px] of Object.entries(steps)) set(`--stair-${id}`, `${px}px`)
      for (const [id, row] of Object.entries(rows)) set(`--stair-row-${id}`, String(row))
    },
  }
}

const px = (value: string): number => Number.parseFloat(value) || 0

/** The page's width and the board's for its columns, as the stylesheet lays them out. */
export function roomNow(): BoardRoom | null {
  const page = document.querySelector<HTMLElement>('.page')
  const board = document.getElementById('board')
  if (!page || !board) return null
  const style = getComputedStyle(board)
  return {
    page: page.clientWidth,
    room: board.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
    colMin: px(style.getPropertyValue('--col-min')),
    gap: px(style.getPropertyValue('--gap')),
    gutter: px(style.paddingRight),
  }
}

interface Watch {
  observer: ResizeObserver | null
  seen: WeakSet<Element>
}

/** Watches the elements not watched yet. */
function follow(watch: Watch, els: Iterable<Element | null>): void {
  for (const el of els)
    if (el && watch.observer && !watch.seen.has(el)) {
      watch.seen.add(el)
      watch.observer.observe(el)
    }
}

/** After every draw of the toolbar, with the heads it drew (models/toolbar.ts columnHeads). */
export function useStairs(heads: readonly Pick<ColumnHead, 'vacant'>[]): void {
  const [engine] = useState(() => stairs(documentStairs()))
  const [watch] = useState((): Watch => ({ observer: null, seen: new WeakSet() }))
  useLayoutEffect(() => {
    follow(watch, headsNow()) // heads drawn since
    engine.fit(heads)
  })
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    watch.observer = new ResizeObserver(() => engine.room(roomNow()))
    follow(watch, [document.querySelector('.toolbar'), document.getElementById('columns-head'), ...headsNow()])
    return () => {
      watch.observer?.disconnect()
      watch.observer = null
      watch.seen = new WeakSet()
      engine.room(null)
    }
  }, [engine, watch])
}
