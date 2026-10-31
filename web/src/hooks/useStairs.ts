// The staircase (models/stairs.ts, styles/stairs.css): while the board is too narrow to give each
// column with cards a card's readable width, <html> has data-stairs and the staircase's sizes
// (models/stairs.ts stairsLayout): the card's width (--stair-card) and each column's step, where its
// cards start (--stair-<column>). What it goes by: the page's and the board's widths (the window, a
// panel docked at a side), from a ResizeObserver on the toolbar (the page's width) and its row of
// heads (as wide as the board's cards), neither of which grows or shrinks with the staircase's
// cards; and which columns have cards on show (every draw of the toolbar). A board with room, a
// phone and a narrow window never get the attribute: their page is as it was.
import { useEffect, useLayoutEffect, useState } from 'react'
import { type BoardRoom, type StairsLayout, stairsLayout, stairsWanted } from '../models/stairs.ts'
import type { ColumnHead } from '../models/toolbar.ts'

/** What the staircase writes in the page. */
export interface StairsPage {
  /** data-stairs on <html>; off, the sizes go with it. */
  turn(on: boolean): void
  /** The staircase's sizes (--stair-*). */
  sizes(layout: StairsLayout): void
}

export interface Stairs {
  /** The page's and the board's widths as they are now (null: no board). */
  room(room: BoardRoom | null): void
  /** The columns in their order and which have cards on show, after every draw of the toolbar. */
  fit(heads: readonly Pick<ColumnHead, 'id' | 'vacant'>[]): void
}

export function stairs(page: StairsPage): Stairs {
  let room: BoardRoom | null = null
  let heads: readonly Pick<ColumnHead, 'id' | 'vacant'>[] = []
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
    const layout = stairsLayout(
      heads.map(h => h.id),
      room,
    )
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

/** The page's own: <html>. */
export function documentStairs(): StairsPage {
  const written = new Set<string>()
  const set = (name: string, value: string) => {
    written.add(name)
    document.documentElement.style.setProperty(name, value)
  }
  return {
    turn(on) {
      const html = document.documentElement
      if (on) html.setAttribute('data-stairs', '')
      else {
        html.removeAttribute('data-stairs')
        for (const name of written) html.style.removeProperty(name)
        written.clear()
      }
    },
    sizes({ card, steps }) {
      set('--stair-card', `${card}px`)
      for (const [id, px] of Object.entries(steps)) set(`--stair-${id}`, `${px}px`)
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

/** After every draw of the toolbar, with the heads it drew (models/toolbar.ts columnHeads). */
export function useStairs(heads: readonly Pick<ColumnHead, 'id' | 'vacant'>[]): void {
  const [engine] = useState(() => stairs(documentStairs()))
  useLayoutEffect(() => engine.fit(heads))
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => engine.room(roomNow()))
    for (const el of [document.querySelector('.toolbar'), document.getElementById('columns-head')])
      if (el) observer.observe(el)
    return () => {
      observer.disconnect()
      engine.room(null)
    }
  }, [engine])
}
