// The staircase (web/src/models/stairs.ts, hooks/useStairs.ts, styles/stairs.css): a board too
// narrow to give each column with cards a card's readable width beside the empty ones' heads lays
// its cards out in one list, lane by lane, each a card's width, its left edge under its column's
// head, the heads in one row at the top, the lane titles staying at the left as the board scrolls
// sideways. When it applies, by the board's own width; where each column's cards start; their order;
// the stylesheet and its gate; dragging a card in it; the keys. A board with room, a phone and a
// narrow window's stacked column are as they were.
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
  nearestHead,
  STAIRS,
  sidewaysStep,
  stairOffsets,
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
const at = (w: number, boardWidth = w): BoardRoom => ({ page: w, room: boardWidth - 2 * GUTTER, ...SIZES })
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
    const r = (room: number): BoardRoom => ({ page: 1200, room, ...SIZES })
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

describe('turning it on and off', () => {
  /** A page whose heads stand at `lefts`, recording what is written. */
  function fakePage(lefts: number[]) {
    const log: unknown[] = []
    let reads = 0
    const page: StairsPage = {
      turn: on => void log.push(['turn', on]),
      heads: () => {
        reads++
        return COLUMNS.map((id, i) => ({ id, left: lefts[i] ?? 0 }))
      },
      steps: offsets => void log.push(['steps', offsets]),
    }
    return { log, page, reads: () => reads }
  }
  const LEFTS = [28, 128, 232, 366, 453]

  test('a board with room: nothing written, the heads never read', () => {
    const p = fakePage(LEFTS)
    const s = stairs(p.page)
    s.fit(heads(5))
    s.room(at(1440))
    s.fit(heads(3))
    s.room(beside(1920))
    expect(p.log).toEqual([])
    expect(p.reads()).toBe(0)
  })

  test('too narrow: on, then each column’s step, its head’s left edge from the first head’s', () => {
    const p = fakePage(LEFTS)
    const s = stairs(p.page)
    s.fit(heads(2))
    s.room(beside(1180))
    expect(p.log).toEqual([
      ['turn', true],
      ['steps', { work: 0, me: 100, ext: 204, done: 338, idle: 425 }],
    ])
    // Drawn again, nothing moved: nothing written.
    s.fit(heads(2))
    expect(p.log).toHaveLength(2)
  })

  test('the steps follow the heads (a count grows a digit, another language, the Terminal style)', () => {
    const lefts = [...LEFTS]
    const p = fakePage(lefts)
    const s = stairs(p.page)
    s.fit(heads(2))
    s.room(beside(1180))
    lefts[2] = 240
    lefts[3] = 374
    lefts[4] = 461
    s.room(beside(1180))
    expect(p.log.at(-1)).toEqual(['steps', { work: 0, me: 100, ext: 212, done: 346, idle: 433 }])
  })

  test('off again when the panel closes, the columns empty, or the board goes', () => {
    for (const away of [
      (s: ReturnType<typeof stairs>) => s.room(at(1180)),
      (s: ReturnType<typeof stairs>) => s.fit(heads(0)),
      (s: ReturnType<typeof stairs>) => s.room(null),
    ]) {
      const p = fakePage(LEFTS)
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
/** The heads' left edges in the window: the gutter, then each as wide as its name and count, 12px apart. */
const HEAD_LEFT: Record<string, number> = { work: 28, me: 128, ext: 232, done: 366, idle: 453 }

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
      if (e.getAttribute('class')?.split(' ').includes('col-head') && col) return box(HEAD_LEFT[col] ?? 0, 96, 90, 20)
      if (e.getAttribute('id') === 'board') return box(0, 0, 620, 2000)
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

describe('where each column’s cards start: under its head', () => {
  test('the page’s heads are read in their order, and the steps written on <html> and taken away', () => {
    mountPage()
    htmlStyle().setProperty('--cols', 'kept')
    const page = documentStairs()
    expect(page.heads()).toEqual(COLUMNS.map(id => ({ id, left: HEAD_LEFT[id] ?? NaN })))
    page.turn(true)
    page.steps(stairOffsets(page.heads()))
    expect(html().getAttribute('data-stairs')).toBe('')
    for (const id of COLUMNS)
      expect(htmlStyle().getPropertyValue(`--stair-${id}`)).toBe(`${(HEAD_LEFT[id] ?? NaN) - 28}px`)
    page.turn(false)
    expect(html().hasAttribute('data-stairs')).toBe(false)
    for (const id of COLUMNS) expect(htmlStyle().getPropertyValue(`--stair-${id}`)).toBe('')
    expect(htmlStyle().getPropertyValue('--cols')).toBe('kept')
  })

  test('each column sits at its step, a card’s width, so its cards’ left edges are its head’s', () => {
    expect(of(GATE)['--stair-card']).toBe('280px')
    expect(of(`${GATE} .lane-grid > .col`)).toEqual({ width: 'var(--stair-card)', 'max-width': 'none' })
    for (const id of COLUMNS)
      expect(of(`${GATE} .lane-grid > [data-col="${id}"]`)['margin-left']).toBe(`var(--stair-${id}, 0px)`)
    // The board's cards start at its gutter, as the heads do in the toolbar: a card's left edge is
    // the gutter and its step, its head's left edge.
    const steps = stairOffsets(COLUMNS.map(id => ({ id, left: HEAD_LEFT[id] ?? 0 })))
    for (const id of COLUMNS) expect(GUTTER + (steps[id] ?? NaN)).toBe(HEAD_LEFT[id] ?? 0)
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
    expect(roomNow()).toEqual({ page: 1180, room: 620 - 56, colMin: 136, gap: 12 })
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
    expect(css).not.toMatch(/\border\s*:|-reverse|grid-row|grid-area/)
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

  test('the heads: one row, each as wide as its name and count, going sideways as far as the board does', () => {
    expect(of(`${GATE} .columns-head`)).toEqual({ display: 'flex', overflow: 'hidden' })
    expect(of(`${GATE} .columns-head > .col-head`)).toEqual({ flex: 'none' })
    // Two digits' room: the steps stay put as a count grows.
    expect(of(`${GATE} .col-head > .n`)).toEqual({ 'min-width': '2ch' })
    // Past the last head, a card's width: the row can scroll as far as the last column's cards go.
    expect(of(`${GATE} .columns-head::after`)).toEqual({ content: '""', flex: 'none', width: 'var(--stair-card)' })
    const board = readFileSync(join(WEB, 'src', 'components', 'Board.tsx'), 'utf8')
    expect(board).toContain('onScroll={headsAlong}')
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

  test('in the page: the staircase by the steps, the columns as before', () => {
    mountPage()
    const grabbed = card('a2')
    // Columns: the lane and column under the pointer, whatever the card's left edge.
    expect(dropPlaceAt(card('b2'), grabbed, 128)).toEqual({ lane: 'other', column: 'ext' })
    expect(dropPlaceAt(card('a4'), grabbed, 30)).toEqual({ lane: 'proj', column: 'done' })
    expect(dropPlaceAt(under('[data-cat="other"] .lane-head'), grabbed, 366)).toEqual({ lane: 'other', column: null })
    expect(dropPlaceAt(under('#columns-head [data-col="idle"]'), grabbed, 128)).toEqual({ lane: null, column: null })
    // The staircase: over another lane's card at the step of Waiting on others, over its title, over a head.
    html().setAttribute('data-stairs', '')
    expect(dropPlaceAt(card('b1'), grabbed, 236)).toEqual({ lane: 'other', column: 'ext' })
    expect(dropPlaceAt(card('b2'), grabbed, 128)).toEqual({ lane: 'other', column: 'me' })
    expect(dropPlaceAt(card('a4'), grabbed, 128)).toEqual({ lane: 'proj', column: 'me' })
    expect(dropPlaceAt(under('[data-cat="other"] .lane-head'), grabbed, 366)).toEqual({ lane: 'other', column: null })
    expect(dropPlaceAt(under('#columns-head [data-col="idle"] .t'), grabbed, 128)).toEqual({
      lane: 'proj',
      column: 'idle',
    })
    expect(dropPlaceAt(null, grabbed, 128)).toEqual({ lane: null, column: null })
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
      clientWidth: { value: 620 },
      scrollLeft: {
        get: () => scrolled,
        set: (v: number) => {
          scrolled = v
        },
      },
    })
    // A board with room: as before, never.
    scrollSideways(610)
    expect(scrolled).toBe(0)
    html().setAttribute('data-stairs', '')
    scrollSideways(610)
    scrollSideways(610)
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
