// The staircase (web/src/models/stairs.ts, hooks/useStairs.ts, styles/stairs.css): a board too
// narrow to give each column with cards a card's readable width beside the empty ones' heads lays
// its cards out in one list, lane by lane, each a card's width, its left edge at its column's step
// where its head starts too, the four columns but Idle in sight and Idle past the board's right
// edge, its head peeking there, the lane titles staying at the left as the board scrolls sideways.
// When it applies, by the board's own width; the sizes; where each column's cards and head start;
// their order; the stylesheet and its gate; dragging a card in it; the keys. A board with room, a
// phone and a narrow window's stacked column are as they were.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GridLane } from '../../src/core/grid-nav.ts'
import type { ColumnId, Item } from '../../src/core/types.ts'
import { Board } from '../../web/src/components/Board.tsx'
import { ColumnsHead } from '../../web/src/components/ColumnsHead.tsx'
import { Lane } from '../../web/src/components/Lane.tsx'
import { dropPlaceAt, scrollSideways } from '../../web/src/hooks/useCardDrag.ts'
import { documentStairs, roomNow, type StairsPage, stairs } from '../../web/src/hooks/useStairs.ts'
import { dropTarget, lanesOf, NO_MOVES } from '../../web/src/models/board-view.ts'
import {
  type BoardRoom,
  boardStep,
  type HeadSize,
  nearestHead,
  STAIRS,
  sidewaysStep,
  stairsLayout,
  stairsPlace,
  stairsWanted,
} from '../../web/src/models/stairs.ts'
import { COLUMN_COLORS, type ColumnHead } from '../../web/src/models/toolbar.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { CATEGORIES } from './support/board-scene.tsx'
import { box, type FakeElement, FakeWorld, type RectBox } from './support/fake-dom.ts'
import { findAll, type Node } from './support/markup.ts'

const WEB = join(import.meta.dir, '..', '..', 'web')
const read = (sheet: string) => readFileSync(join(WEB, 'styles', sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const css = read('stairs.css')
const GATE = ':root[data-stairs]'
const CONTAINER = '@container page (min-width: 961px)'
const COLUMNS = Object.keys(COLUMN_COLORS) as ColumnId[]

/** Every style rule of a sheet: its selectors, its declarations and the group rules it sits in. */
function rulesIn(text: string): { selectors: string[]; decls: Record<string, string>; at: string[] }[] {
  const out: { selectors: string[]; decls: Record<string, string>; at: string[] }[] = []
  const walk = (from: number, to: number, at: string[]) => {
    let i = from
    while (i < to) {
      const open = text.indexOf('{', i)
      if (open < 0 || open >= to) return
      const prelude = text.slice(i, open).trim()
      let depth = 0
      let close = open
      for (; close < to; close++) {
        if (text[close] === '{') depth++
        else if (text[close] === '}' && --depth === 0) break
      }
      if (prelude.startsWith('@')) walk(open + 1, close, [...at, prelude.replace(/\s+/g, ' ')])
      else {
        const decls: Record<string, string> = {}
        for (const d of text.slice(open + 1, close).split(';')) {
          const colon = d.indexOf(':')
          if (colon > 0) decls[d.slice(0, colon).trim()] = d.slice(colon + 1).trim()
        }
        out.push({ selectors: prelude.split(',').map(s => s.trim().replace(/\s+/g, ' ')), decls, at })
      }
      i = close + 1
    }
  }
  walk(0, text.length, [])
  return out
}

const rules = rulesIn(css)
/** The declarations of the rules for `selector` in the staircase's sheet, merged. */
const of = (selector: string): Record<string, string> =>
  Object.assign({}, ...rules.filter(r => r.selectors.includes(selector)).map(r => r.decls))

/** A simple selector's specificity, as [ids, classes and attributes and pseudo-classes, types]. */
function specificity(of: string): [number, number, number] {
  // :not() and :is() count as what they hold.
  const selector = of.replace(/:(not|is)\(/g, '(')
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length
  const types = selector.replace(/\[[^\]]+\]|::?[\w-]+|[#.][\w-]+/g, ' ').match(/\b[a-z]+\b/g)?.length ?? 0
  return [ids, classes, types]
}
const outranks = (a: string, b: string) => {
  const [x, y] = [specificity(a), specificity(b)]
  return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2]
}

/** app.css's own: an empty column's width (its head's) and the gap between columns. */
const app = read('app.css')
const SIZES = {
  colMin: Number.parseFloat(/--col-min:\s*([\d.]+)px/.exec(app)?.[1] ?? 'NaN'),
  gap: Number.parseFloat(/--gap:\s*([\d.]+)px/.exec(app)?.[1] ?? 'NaN'),
}
const GUTTER = 28
/** The heads with the first `full` columns holding cards. */
const heads = (full: number) => COLUMNS.map((_, i) => ({ vacant: i >= full }))
/** A window `w` wide, the board `board` wide in it (a panel docked at a side takes the rest). */
const at = (w: number, boardWidth = w): BoardRoom => ({
  page: w,
  room: boardWidth - 2 * GUTTER,
  ...SIZES,
  gutter: GUTTER,
})
/** Beside a side panel of its default 560px: the board makes it room (a wide window) or keeps clear of it all the same (styles/beside.css). */
const beside = (w: number) => at(w, w - 560)

describe('when the board is a staircase: by its own width', () => {
  test('app.css’s sizes, and the least width of a column with cards is beside.css’s --col-card', () => {
    expect(SIZES).toEqual({ colMin: 136, gap: 12 })
    const card = /--col-card:\s*([\d.]+)px/.exec(read('beside.css'))?.[1]
    // So beside a panel, wherever the columns stay, their tracks fit (no sideways scrolling).
    expect(Number(card)).toBe(STAIRS.column)
    expect(STAIRS.column).toBe(210)
  })

  test('an iPad in landscape with the panel docked at a side: a staircase, however few columns have cards', () => {
    for (const w of [1133, 1180, 1194, 1366])
      for (let full = 1; full <= 5; full++)
        expect([w, full, stairsWanted(heads(full), beside(w))]).toEqual([w, full, true])
    // The owner's: a board about 590 wide.
    expect(stairsWanted(heads(1), at(1180, 590))).toBe(true)
  })

  test('the same iPad with the panel closed keeps its columns, all five with cards too', () => {
    for (let full = 1; full <= 5; full++) expect(stairsWanted(heads(full), at(1180))).toBe(false)
  })

  test('a desktop window with room keeps its columns, beside a panel too', () => {
    for (let full = 1; full <= 5; full++) {
      expect(stairsWanted(heads(full), at(1440))).toBe(false)
      expect(stairsWanted(heads(full), at(1920))).toBe(false)
      // 1920 wide, the board makes the panel room: 1360 left.
      expect(stairsWanted(heads(full), beside(1920))).toBe(false)
    }
  })

  test('the switch point: every column with cards at 210px, every empty one at its head’s, and the gaps', () => {
    // Three with cards, two empty: 3 × 210 + 2 × 136 + 4 × 12 = 950.
    const need = 3 * 210 + 2 * 136 + 4 * 12
    const r = (room: number): BoardRoom => ({ page: 1200, room, ...SIZES, gutter: GUTTER })
    expect(stairsWanted(heads(3), r(need - 1))).toBe(true)
    expect(stairsWanted(heads(3), r(need))).toBe(false)
    // A laptop 1440 wide with the panel over the board (880 left): one column with cards fits, two do not.
    expect(stairsWanted(heads(1), beside(1440))).toBe(false)
    expect(stairsWanted(heads(2), beside(1440))).toBe(true)
    // A window 1000 wide with no panel (944 for the columns): two with cards fit, three do not.
    expect(stairsWanted(heads(2), at(1000))).toBe(false)
    expect(stairsWanted(heads(3), at(1000))).toBe(true)
  })

  test('never on a phone or where the page stacks its columns, never with no card on show', () => {
    for (let full = 1; full <= 5; full++) {
      expect(stairsWanted(heads(full), at(390))).toBe(false)
      expect(stairsWanted(heads(full), at(760))).toBe(false)
      expect(stairsWanted(heads(full), at(820))).toBe(false)
      expect(stairsWanted(heads(full), at(900, 328))).toBe(false)
      expect(stairsWanted(heads(full), at(960))).toBe(false)
    }
    expect(stairsWanted(heads(5), at(961))).toBe(true)
    expect(stairsWanted(heads(0), beside(1180))).toBe(false)
    // app.css stacks the columns up to 960px; the staircase's sheet starts above it.
    expect(app).toContain(`@container page (max-width: ${STAIRS.stacked}px)`)
    expect(css).toContain(`@container page (min-width: ${STAIRS.stacked + 1}px)`)
  })
})

/** Heads as wide as their name and count (with two digits' room), as an iPad draws them. */
const widths = (w: Record<ColumnId, number>): HeadSize[] => COLUMNS.map(id => ({ id, width: w[id] }))
const RU = widths({ work: 95, me: 99, ext: 129, done: 82, idle: 100 })
const EN = widths({ work: 82, me: 92, ext: 140, done: 62, idle: 60 })
/** The owner's iPad in landscape, the panel docked at a side: the board 590 wide. */
const OWNER = { room: 590 - 2 * GUTTER, gutter: GUTTER }

describe('the sizes: wide cards, the four columns in sight, Idle past the edge', () => {
  test('on the owner’s iPad: cards 373.5 wide, the steps 53.5 apart, Idle past the board’s edge', () => {
    const l = stairsLayout(RU, OWNER)
    expect(l.card).toBe(373.5)
    expect(l.steps).toEqual({ work: 0, me: 53.5, ext: 107, done: 160.5, idle: 534 + GUTTER })
    // Two rows of heads, each starting at its column's step; Idle's where it peeks, at the right.
    expect(l.rows).toEqual({ work: 1, me: 2, ext: 1, done: 2, idle: 1 })
    expect(l.end).toBe(562 + 373.5)
  })

  test('a card is 320 to 420 wide, the four columns fill what the board shows, Idle out of sight', () => {
    for (const hs of [RU, EN])
      for (let room = 300; room <= 1100; room += 7) {
        const l = stairsLayout(hs, { room, gutter: GUTTER })
        const s = l.steps
        expect(l.card).toBeGreaterThanOrEqual(STAIRS.card.min)
        expect(l.card).toBeLessThanOrEqual(STAIRS.card.max)
        expect([s.work, s.me, s.ext, s.done].every((v, i, a) => i === 0 || (v ?? 0) > (a[i - 1] ?? 0))).toBe(true)
        // The last of the four ends at the board's right edge, unless the card is at its least.
        const last = (s.done ?? 0) + l.card
        if (l.card > STAIRS.card.min) expect(last).toBeLessThanOrEqual(room + 0.01)
        // Idle starts past the right edge and its padding, and past the other columns' cards.
        expect(s.idle ?? 0).toBeGreaterThanOrEqual(room + GUTTER - 0.01)
        expect(s.idle ?? 0).toBeGreaterThanOrEqual(last + GUTTER - 0.01)
        expect(l.end).toBe(Math.round(((s.idle ?? 0) + l.card) * 100) / 100)
      }
  })

  test('each head starts at its column’s step, none over another in its row, in two rows where the four fit', () => {
    for (const hs of [RU, EN])
      for (let room = 300; room <= 1100; room += 7) {
        const l = stairsLayout(hs, { room, gutter: GUTTER })
        const placed = hs.map(h => {
          // Idle's head peeks at the right edge of the heads' row until the board scrolls to it.
          const left = h.id === 'idle' ? room - h.width : (l.steps[h.id] ?? 0)
          return { row: l.rows[h.id], left, right: left + h.width }
        })
        for (const a of placed)
          for (const b of placed)
            if (a !== b && a.row === b.row && a.left <= b.left)
              expect(b.left).toBeGreaterThanOrEqual(a.right + STAIRS.headGap - 0.01)
        // Two rows wherever the least card and the steps fit; a third only on a board narrower still.
        const four = STAIRS.card.min + 3 * (l.steps.me ?? 0)
        expect(Math.max(...Object.values(l.rows))).toBeLessThanOrEqual(room >= four ? 2 : 3)
      }
  })

  test('a wider board: the card at its widest, the steps wider, the heads in one row', () => {
    const l = stairsLayout(RU, { room: 905, gutter: GUTTER })
    expect(l.card).toBe(420)
    expect(l.steps.me).toBeCloseTo((905 - 420) / 3, 1)
    expect(Object.values(l.rows)).toEqual([1, 1, 1, 1, 1])
    // Too narrow for the least card: it keeps 320, the last of the four running a little past the edge.
    expect(stairsLayout(RU, { room: 420, gutter: GUTTER }).card).toBe(320)
  })
})

describe('turning it on and off', () => {
  /** A page whose heads are `hs` wide, recording what is written. */
  function fakePage(hs: HeadSize[]) {
    const log: unknown[] = []
    let reads = 0
    const page: StairsPage = {
      turn: on => void log.push(['turn', on]),
      heads: () => {
        reads++
        return hs.map(h => ({ ...h }))
      },
      sizes: layout => void log.push(['sizes', layout]),
    }
    return { log, page, reads: () => reads }
  }

  test('a board with room: nothing written, the heads never read', () => {
    const p = fakePage(RU)
    const s = stairs(p.page)
    s.fit(heads(5))
    s.room(at(1440))
    s.fit(heads(3))
    s.room(beside(1920))
    expect(p.log).toEqual([])
    expect(p.reads()).toBe(0)
  })

  test('too narrow: on, then the sizes for the board’s width and the heads’', () => {
    const p = fakePage(RU)
    const s = stairs(p.page)
    s.fit(heads(2))
    s.room(at(1180, 590))
    expect(p.log).toEqual([
      ['turn', true],
      ['sizes', stairsLayout(RU, OWNER)],
    ])
    // Drawn again, nothing moved: nothing written.
    s.fit(heads(2))
    expect(p.log).toHaveLength(2)
  })

  test('the sizes follow the heads (a count grows a digit, another language, the Terminal style) and the board', () => {
    const hs = RU.map(h => ({ ...h }))
    const p = fakePage(hs)
    const s = stairs(p.page)
    s.fit(heads(2))
    s.room(at(1180, 590))
    for (const h of hs) if (h.id === 'me') h.width = 119
    s.room(at(1180, 590))
    expect(p.log.at(-1)).toEqual(['sizes', stairsLayout(hs, OWNER)])
    s.room(at(1180, 620))
    expect(p.log.at(-1)).toEqual(['sizes', stairsLayout(hs, { room: 620 - 56, gutter: GUTTER })])
  })

  test('off again when the panel closes, the columns empty, or the board goes', () => {
    for (const away of [
      (s: ReturnType<typeof stairs>) => s.room(at(1180)),
      (s: ReturnType<typeof stairs>) => s.fit(heads(0)),
      (s: ReturnType<typeof stairs>) => s.room(null),
    ]) {
      const p = fakePage(RU)
      const s = stairs(p.page)
      s.fit(heads(4))
      s.room(beside(1180))
      away(s)
      expect(p.log.at(-1)).toEqual(['turn', false])
    }
  })
})

/** A world with the page's column heads (as ColumnsHead draws them) and the board (as Board draws it). */
const ITEMS: Item[] = [
  item({ key: 'a1', category: 'proj', column: 'work', status: 'working' }),
  item({ key: 'a2', category: 'proj', column: 'me' }),
  item({ key: 'a3', category: 'proj', column: 'me' }),
  item({ key: 'a4', category: 'proj', column: 'done' }),
  item({ key: 'b1', category: 'other', column: 'work', status: 'working' }),
  item({ key: 'b2', category: 'other', column: 'ext' }),
  item({ key: 'b3', category: 'other', column: 'idle' }),
]
const HEADS: ColumnHead[] = COLUMNS.map(id => ({ id, title: id, color: COLUMN_COLORS[id], n: 1, vacant: false }))
/** Steps in the window, for the drop place's own rules. */
const HEAD_LEFT: Record<string, number> = { work: 28, me: 128, ext: 232, done: 366, idle: 453 }
/** The owner's iPad: the board 590 wide at the window's left, its heads' row at its gutter. */
const BOARD = box(0, 0, 590, 2000)
const HEADS_ROW = box(GUTTER, 90, 590 - 2 * GUTTER, 44)

let world: FakeWorld
const html = () => world.document.documentElement
/** <html>'s inline style, as the page's code writes it. */
const htmlStyle = () => html().style as unknown as CSSStyleDeclaration
function mountPage(): void {
  const context = board({ data: payload({ items: ITEMS, categories: CATEGORIES }) })
  for (const nodes of [renderInBoard(<ColumnsHead heads={HEADS} />, context), renderInBoard(<Board />, context)])
    for (const node of nodes) if (node.kind === 'element') world.mount(node)
}
const el = (selector: string): FakeElement => {
  const found = html().querySelector(selector)
  if (!found) throw new Error(`no ${selector}`)
  return found
}
/** A card of the page, as an element the drag's code takes. */
const card = (key: string) => el(`.card[data-key="${key}"]`) as unknown as Element
const under = (selector: string) => el(selector) as unknown as Element

beforeEach(() => {
  world = new FakeWorld({
    viewport: { w: 1180, h: 820 },
    rects: (e: FakeElement): RectBox | null => {
      const col = e.getAttribute('data-col')
      const width = RU.find(h => h.id === col)?.width ?? 0
      if (e.getAttribute('class')?.split(' ').includes('col-head') && col)
        return box(HEAD_LEFT[col] ?? 0, 96, width, 20)
      if (e.getAttribute('id') === 'board') return BOARD
      if (e.getAttribute('id') === 'columns-head') return HEADS_ROW
      return null
    },
  })
  world.install()
})
afterEach(async () => {
  try {
    await world.settle()
  } finally {
    world.uninstall()
  }
})

describe('where each column’s cards and head start: at its step', () => {
  test('the page’s heads are read in their order, and the sizes written on <html> and taken away', () => {
    mountPage()
    htmlStyle().setProperty('--cols', 'kept')
    const page = documentStairs()
    expect(page.heads()).toEqual(RU)
    page.turn(true)
    page.sizes(stairsLayout(page.heads(), OWNER))
    expect(html().getAttribute('data-stairs')).toBe('')
    const written = (name: string) => htmlStyle().getPropertyValue(name)
    expect([written('--stair-card'), written('--stair-end')]).toEqual(['373.5px', '935.5px'])
    expect(COLUMNS.map(id => written(`--stair-${id}`))).toEqual(['0px', '53.5px', '107px', '160.5px', '562px'])
    expect(COLUMNS.map(id => written(`--stair-row-${id}`))).toEqual(['1', '2', '1', '2', '1'])
    page.turn(false)
    expect(html().hasAttribute('data-stairs')).toBe(false)
    for (const name of [
      '--stair-card',
      '--stair-end',
      ...COLUMNS.flatMap(id => [`--stair-${id}`, `--stair-row-${id}`]),
    ])
      expect(written(name)).toBe('')
    expect(written('--cols')).toBe('kept')
  })

  test('a column’s cards and its head start at the same step, so a card’s left edge is its head’s', () => {
    // The least card until the sizes are written; then the card's width as written.
    expect(of(GATE)['--stair-card']).toBe(`${STAIRS.card.min}px`)
    expect(of(`${GATE} .lane-grid > .col`)).toEqual({ width: 'var(--stair-card)', 'max-width': 'none' })
    for (const id of COLUMNS) {
      expect(of(`${GATE} .lane-grid > [data-col="${id}"]`)['margin-left']).toBe(`var(--stair-${id}, 0px)`)
      expect(of(`${GATE} .columns-head > [data-col="${id}"]`)['margin-left']).toBe(`var(--stair-${id}, 0px)`)
      expect(of(`${GATE} .columns-head > [data-col="${id}"]`)['grid-row']).toBe(`var(--stair-row-${id}, 1)`)
    }
    // The heads' row starts at the toolbar's gutter, the board's cards at the board's: the same.
    expect(app).toMatch(/\.toolbar \{[^}]*padding: 10px var\(--gutter\) 0;/)
    expect(app).toMatch(/\.board \{ padding: 4px var\(--gutter\)/)
  })

  test('the board’s width as the page lays it out: the page’s, and the board’s less its gutters', () => {
    world.uninstall()
    world = new FakeWorld({
      viewport: { w: 1180, h: 820 },
      rects: e => (e.getAttribute('id') === 'board' ? box(0, 0, 620, 900) : box(0, 0, 1180, 900)),
      computed: () =>
        ({
          paddingLeft: '28px',
          paddingRight: '28px',
          getPropertyValue: (name: string) => ({ '--col-min': '136px', '--gap': '12px' })[name] ?? '',
        }) as unknown as Record<string, string>,
    })
    world.install()
    const [page] = renderInBoard(
      <div className="page">
        <main className="board" id="board" />
      </div>,
      board(),
    )
    if (page?.kind === 'element') world.mount(page)
    expect(roomNow()).toEqual({ page: 1180, room: 620 - 56, colMin: 136, gap: 12, gutter: 28 })
  })
})

describe('the cards’ order: lane by lane, by column, then each column’s own', () => {
  test('one list from top to bottom, as the lane draws its columns and cards', () => {
    const items = [
      item({ key: 'i1', category: 'proj', column: 'idle' }),
      item({ key: 'd1', category: 'proj', column: 'done' }),
      item({ key: 'm1', category: 'proj', column: 'me' }),
      item({ key: 'd2', category: 'proj', column: 'done' }),
      item({ key: 'w1', category: 'proj', column: 'work' }),
      item({ key: 'm2', category: 'proj', column: 'me' }),
    ]
    const [lane] = lanesOf({ categories: CATEGORIES, columns: COLUMNS.map(id => ({ id })) }, items, [], NO_MOVES)
    if (!lane) throw new Error('no lane')
    const nodes: Node[] = renderInBoard(
      <Lane
        lane={lane}
        lit={null}
        canMutate
        onNewSession={() => {}}
        renderCard={it => <div className="card" data-key={it.key} key={it.key} />}
      />,
      board(),
    )
    const keys = findAll(nodes, e => e.attrs.get('class') === 'card').map(e => e.attrs.get('data-key'))
    expect(keys).toEqual(['w1', 'm1', 'm2', 'd1', 'd2', 'i1'])
  })

  test('the sheet keeps that order: a column, its cards in the column, nothing reordered', () => {
    expect(of(`${GATE} .lane-grid`)).toEqual({
      display: 'flex',
      'flex-direction': 'column',
      gap: 'var(--stair-gap, 8px)',
    })
    for (const r of rules.filter(r => r.selectors.some(sel => /\.(lane|col|board|card)\b/.test(sel))))
      expect(Object.keys(r.decls).filter(d => /^(order|grid-row|grid-area|flex-flow)$/.test(d))).toEqual([])
    expect(css).not.toContain('-reverse')
    // An empty column takes no row; while a card is dragged, the one it would land in opens there.
    expect(of(`${GATE} .lane-grid > .col:not(.has-cards)`).display).toBe('none')
    expect(of(`${GATE} body.dragging .lane-grid > .col.drop`).display).toBe('flex')
    expect(outranks(`${GATE} body.dragging .lane-grid > .col.drop`, `${GATE} .lane-grid > .col:not(.has-cards)`)).toBe(
      true,
    )
    // The cards stand 8px apart in a column, the Terminal style's 10px: the list keeps that.
    expect(app).toMatch(/\.col \{ display: flex; flex-direction: column; gap: 8px;/)
    const terminal = read('look-terminal.css')
    expect(terminal).toContain(':root[data-look="terminal"] .col { gap: 10px; }')
    expect(terminal).toContain(':root[data-look="terminal"] { --stair-bar: var(--stair-card); --stair-gap: 10px; }')
  })
})

describe('the stylesheet', () => {
  test('every rule under :root[data-stairs], all but the card’s width where the page lays out columns', () => {
    expect(rules.length).toBeGreaterThan(15)
    for (const r of rules) for (const s of r.selectors) expect(s.startsWith(GATE)).toBe(true)
    for (const r of rules)
      if (!r.selectors.includes(GATE)) expect([r.selectors[0], r.at[0]]).toEqual([r.selectors[0], CONTAINER])
    // Nothing for a phone or a narrow window's stacked column.
    expect(css).not.toContain('760px')
    expect(css).not.toMatch(/\(max-width/)
  })

  test('linked after the board’s sheets, before beside.css and the Terminal style', () => {
    const linked = [...readFileSync(join(WEB, 'index.html'), 'utf8').matchAll(/href="styles\/([\w-]+\.css)"/g)].map(
      m => m[1],
    )
    const i = linked.indexOf('stairs.css')
    for (const before of ['app.css', 'launch.css', 'cards.css', 'card-wrap.css', 'favorites.css', 'desktop.css'])
      expect(i).toBeGreaterThan(linked.indexOf(before))
    expect(i).toBe(linked.indexOf('beside.css') - 1)
  })

  test('the heads: each at its step in its row, going sideways with the board as far as its cards go', () => {
    const row = `${GATE} .toolbar .columns-head`
    expect(of(row)).toEqual({
      'grid-template-columns': 'var(--stair-end, max-content)',
      'row-gap': '4px',
      overflow: 'hidden',
    })
    // beside.css (linked after) sets the heads' columns beside a side panel: this outranks it.
    expect(read('beside.css')).toContain(':root[data-panel-side] .columns-head { grid-template-columns:')
    expect(outranks(row, ':root[data-panel-side] .columns-head')).toBe(true)
    expect(of(`${GATE} .columns-head > .col-head`)).toEqual({ 'grid-column': '1', 'justify-self': 'start' })
    // Two digits' room: a head does not grow as a count does.
    expect(of(`${GATE} .col-head > .n`)).toEqual({ 'min-width': '2ch' })
    const board = readFileSync(join(WEB, 'src', 'components', 'Board.tsx'), 'utf8')
    expect(board).toContain('onScroll={headsAlong}')
  })

  test('Idle’s head peeks at the right edge of the heads’ row, with a ›, until the board scrolls to its column', () => {
    const idle = of(`${GATE} .columns-head > [data-col="idle"]`)
    expect([idle.position, idle.right]).toEqual(['sticky', '0'])
    expect(of(`${GATE} .columns-head > [data-col="idle"]::after`).content).toBe('"›" / ""')
    expect(STAIRS.aside).toBe('idle')
  })

  test('the board scrolls sideways, its lanes as wide as the widest one’s steps', () => {
    expect(of(`${GATE} .board`)).toEqual({
      display: 'grid',
      'grid-template-columns': 'minmax(max-content, 1fr)',
      'align-content': 'start',
      'overflow-x': 'auto',
      'overscroll-behavior-x': 'contain',
    })
    // A finger on a card scrolls it sideways too.
    const touch = rules.find(r => r.selectors.includes(`${GATE} .card`))
    expect(touch?.at).toEqual([CONTAINER, '@media (pointer: coarse)'])
    expect(touch?.decls).toEqual({ 'touch-action': 'pan-x pan-y' })
  })

  test('the lane titles stay at the left as it scrolls, in the Terminal style too', () => {
    const bar = `${GATE} .lane > .lane-bar`
    expect(of(bar)).toEqual({ position: 'sticky', left: 'var(--gutter)', width: 'var(--stair-bar, max-content)' })
    // The Terminal style (linked after) sets the bar's position: this outranks it.
    const terminal = read('look-terminal.css')
    expect(terminal).toContain(':root[data-look="terminal"] .lane-bar { position: relative;')
    expect(outranks(bar, ':root[data-look="terminal"] .lane-bar')).toBe(true)
    // Its bar, a rule to the + at the end, a card's width; the Classic one as wide as what it holds.
    expect(terminal).toContain('--stair-bar: var(--stair-card);')
    expect(css).not.toContain('data-look')
  })
})

describe('dragging a card in the staircase', () => {
  const H = COLUMNS.map(id => ({ id, left: HEAD_LEFT[id] ?? 0 }))
  const a2 = item({ key: 'a2', category: 'proj', column: 'me' })

  test('the column is the step nearest the card’s left edge; of two as near, the left one', () => {
    expect(nearestHead(H, 128)).toBe('me')
    expect(nearestHead(H, 179)).toBe('me')
    expect(nearestHead(H, 181)).toBe('ext')
    expect(nearestHead(H, 180)).toBe('me')
    expect(nearestHead(H, -50)).toBe('work')
    expect(nearestHead(H, 900)).toBe('idle')
    expect(nearestHead([], 100)).toBe(null)
  })

  test('picked up, it stays in its column until moved toward another step; the lane is the one under the pointer', () => {
    const over = (fields: Partial<Parameters<typeof stairsPlace>[0]>) =>
      dropTarget(
        a2,
        NO_MOVES,
        stairsPlace({ lane: 'proj', inCards: true, head: null, own: 'proj', left: 128, heads: H, ...fields }),
      )
    // Where it was: nothing changes.
    expect(over({})).toBe(null)
    expect(over({ left: 150 })).toBe(null)
    // Toward Done's step, and past the last one.
    expect(over({ left: 350 })).toEqual({ cat: null, column: 'done' })
    expect(over({ left: 700 })).toEqual({ cat: null, column: 'idle' })
    // Another lane, at its own step: that lane only; at another's: both.
    expect(over({ lane: 'other' })).toEqual({ cat: 'other', column: null })
    expect(over({ lane: 'other', left: 236 })).toEqual({ cat: 'other', column: 'ext' })
    // "Working" takes no cards: the lane only.
    expect(over({ left: 20 })).toBe(null)
    expect(over({ lane: 'other', left: 20 })).toEqual({ cat: 'other', column: null })
    // Over a lane's title: the lane alone, wherever the card is.
    expect(over({ lane: 'other', inCards: false, left: 366 })).toEqual({ cat: 'other', column: null })
    // Over a column's head at the top: that column, in its own lane.
    expect(over({ lane: null, inCards: false, head: 'ext' })).toEqual({ cat: null, column: 'ext' })
    // Off the lanes: nothing.
    expect(over({ lane: null, inCards: false })).toBe(null)
  })

  test('in the page: the staircase by the steps in sight, the columns as before', () => {
    mountPage()
    const grabbed = card('a2')
    // Columns: the lane and column under the pointer, whatever the card's left edge.
    expect(dropPlaceAt(card('b2'), grabbed, 128)).toEqual({ lane: 'other', column: 'ext' })
    expect(dropPlaceAt(card('a4'), grabbed, 30)).toEqual({ lane: 'proj', column: 'done' })
    expect(dropPlaceAt(under('[data-cat="other"] .lane-head'), grabbed, 366)).toEqual({ lane: 'other', column: null })
    expect(dropPlaceAt(under('#columns-head [data-col="idle"]'), grabbed, 128)).toEqual({ lane: null, column: null })
    // The staircase on the owner's iPad: steps at the gutter (28) and 53.5 apart, Idle's at 590, the board's edge.
    html().setAttribute('data-stairs', '')
    documentStairs().sizes(stairsLayout(RU, OWNER))
    expect(dropPlaceAt(card('b1'), grabbed, 28 + 107)).toEqual({ lane: 'other', column: 'ext' })
    expect(dropPlaceAt(card('b2'), grabbed, 28 + 60)).toEqual({ lane: 'other', column: 'me' })
    expect(dropPlaceAt(card('a4'), grabbed, 28 + 170)).toEqual({ lane: 'proj', column: 'done' })
    // Idle is out of sight: a card pushed far right goes to Done, never where it cannot be seen.
    expect(dropPlaceAt(card('a4'), grabbed, 450)).toEqual({ lane: 'proj', column: 'done' })
    expect(dropPlaceAt(under('[data-cat="other"] .lane-head'), grabbed, 366)).toEqual({ lane: 'other', column: null })
    // Over Idle's head, peeking at the edge: Idle, in the card's own lane.
    expect(dropPlaceAt(under('#columns-head [data-col="idle"] .t'), grabbed, 128)).toEqual({
      lane: 'proj',
      column: 'idle',
    })
    expect(dropPlaceAt(null, grabbed, 128)).toEqual({ lane: null, column: null })
    // The board scrolled to Idle (its heads with it): Idle's step in sight takes the card.
    Object.defineProperty(el('#columns-head'), 'scrollLeft', { value: 400 })
    expect(dropPlaceAt(card('b3'), grabbed, 28 + 562 - 400)).toEqual({ lane: 'other', column: 'idle' })
    expect(dropPlaceAt(card('b3'), grabbed, 28 + 160.5 - 400)).toEqual({ lane: 'other', column: 'done' })
  })

  test('near the board’s left or right edge it scrolls the board sideways, 14px a move, while it can go', () => {
    const b = { left: 0, right: 620 }
    expect(sidewaysStep(600, b, { at: 0, max: 300 })).toBe(14)
    expect(sidewaysStep(900, b, { at: 0, max: 300 })).toBe(14) // over the panel beside it
    expect(sidewaysStep(600, b, { at: 300, max: 300 })).toBe(0)
    expect(sidewaysStep(300, b, { at: 100, max: 300 })).toBe(0)
    expect(sidewaysStep(20, b, { at: 100, max: 300 })).toBe(-14)
    expect(sidewaysStep(20, b, { at: 0, max: 300 })).toBe(0)
    expect(sidewaysStep(600, b, { at: 0, max: 0 })).toBe(0)
  })

  test('in the page: only a board that scrolls sideways, the staircase or beside a side panel', () => {
    mountPage()
    const boardEl = el('#board')
    let scrolled = 0
    Object.defineProperties(boardEl, {
      scrollWidth: { value: 1000 },
      clientWidth: { value: 590 },
      scrollLeft: {
        get: () => scrolled,
        set: (v: number) => {
          scrolled = v
        },
      },
    })
    // A board with room: as before, never.
    scrollSideways(580)
    expect(scrolled).toBe(0)
    // Toward Idle, past the right edge.
    html().setAttribute('data-stairs', '')
    scrollSideways(580)
    scrollSideways(580)
    expect(scrolled).toBe(28)
    scrollSideways(300)
    expect(scrolled).toBe(28)
    html().removeAttribute('data-stairs')
    html().setAttribute('data-panel-side', 'right')
    scrollSideways(5)
    expect(scrolled).toBe(14)
  })
})

describe('the keys in the staircase (the Terminal style’s)', () => {
  // Project: a1 working; a2, a3 waiting on me; a4 done. Other: b1 working; b2 waiting on others.
  const grid: GridLane[] = [
    { cols: [[{ key: 'a1' }], [{ key: 'a2' }, { key: 'a3' }], [], [{ key: 'a4' }], []] },
    { cols: [[{ key: 'b1' }], [], [{ key: 'b2' }], [], []] },
  ]

  test('up and down go to the card above and below, as the list shows them', () => {
    expect(boardStep(grid, 'a1', 'down', 'stairs')).toBe('a2')
    expect(boardStep(grid, 'a3', 'down', 'stairs')).toBe('a4')
    expect(boardStep(grid, 'a4', 'down', 'stairs')).toBe('b1')
    expect(boardStep(grid, 'b1', 'up', 'stairs')).toBe('a4')
    // The columns as before: down from Working goes to the next lane's.
    expect(boardStep(grid, 'a1', 'down', 'columns')).toBe('b1')
    expect(boardStep(grid, 'a3', 'down', 'columns')).toBe('b1')
  })

  test('left and right go to the lane’s next column with cards that way, as in the columns', () => {
    expect(boardStep(grid, 'a2', 'right', 'stairs')).toBe('a4')
    expect(boardStep(grid, 'a4', 'left', 'stairs')).toBe('a2')
    expect(boardStep(grid, 'b1', 'right', 'stairs')).toBe('b2')
    expect(boardStep(grid, 'b2', 'right', 'stairs')).toBe(null)
    for (const [from, dir] of [
      ['a2', 'right'],
      ['a4', 'left'],
      ['b1', 'right'],
    ] as const)
      expect(boardStep(grid, from, dir, 'stairs')).toBe(boardStep(grid, from, dir, 'columns'))
  })

  test('a stacked board is a list, the ends and no card yet as before', () => {
    expect(boardStep(grid, 'a1', 'right', 'stacked')).toBe('a2')
    expect(boardStep(grid, 'a4', 'down', 'stacked')).toBe('b1')
    for (const layout of ['columns', 'stacked', 'stairs'] as const) {
      expect(boardStep(grid, 'a3', 'home', layout)).toBe('a1')
      expect(boardStep(grid, 'a3', 'last', layout)).toBe('b2')
      expect(boardStep(grid, null, 'down', layout)).toBe('a1')
      expect(boardStep(grid, 'gone', 'last', layout)).toBe('b2')
    }
  })
})
