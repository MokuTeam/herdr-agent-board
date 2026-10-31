// The board beside a panel docked at a side (web/styles/beside.css, components/panel/place.ts): the
// header keeps the window's width, laid out as with no panel, and the panel starts under it; the
// board and the column heads keep clear of the panel, scrolling sideways where the columns do not
// fit (an iPad in landscape, about 1000 × 750). Only while <html> has data-panel-side, which the
// place sets for a panel docked left or right and never for one floating, at the bottom, closed, or
// on a phone: there the page is as it was.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { columnWidths } from '../../web/src/hooks/useColumnWidths.ts'
import { MARGIN, type PanelLayout, rectFor } from '../../web/src/models/panel-layout.ts'
import { sidewaysScroll } from '../../web/src/models/panel-motion.ts'
import { besideTracks, columnTracks } from '../../web/src/models/toolbar.ts'
import { box, type FakeElement, type RectBox } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'
import { newSide, type ReactSide } from './support/panel-sides.tsx'
import { rulesOf } from './support/stylesheets.ts'

const WEB = join(import.meta.dir, '..', '..', 'web')
const SHEET = 'beside.css'
const GATE = ':root[data-panel-side]'
const css = readFileSync(join(WEB, 'styles', SHEET), 'utf8')
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** A selector list's selectors: split at its own commas, not those in :is() and the like. */
function selectorList(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++
    else if (list[i] === ')') depth--
    else if (list[i] === ',' && depth === 0) {
      out.push(list.slice(from, i).trim())
      from = i + 1
    }
  }
  return [...out, list.slice(from).trim()]
}

/** The declarations of every rule (inside @media and @container too) whose selector list holds `selector`, merged. */
function declarations(selector: string, source = bare): Record<string, string> {
  const found: Record<string, string> = {}
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = selectorList(m[1] ?? '')
    if (!selectors.includes(selector)) continue
    for (const d of (m[2] ?? '').split(';')) {
      const at = d.indexOf(':')
      if (at > 0) found[d.slice(0, at).trim()] = d.slice(at + 1).trim()
    }
  }
  return found
}

const IPAD = { w: 1000, h: 750 }
const PANEL = 'cats-sheet'
/** The header's height over the panel: the toolbar's two rows on an iPad. */
const HEADER = 90
const LAYOUT: PanelLayout = { dock: 'right', side: null, bottom: null, float: null }

async function withSide(
  options: {
    viewport?: { w: number; h: number }
    saved?: object
    phone?: boolean
    rects?: (el: FakeElement) => RectBox | null
  },
  body: (side: ReactSide, header: { top: number }) => Promise<void>,
): Promise<void> {
  const side = await newSide({
    viewport: options.viewport ?? IPAD,
    ids: [PANEL],
    ...(options.phone ? { phone: true } : {}),
    ...(options.rects ? { rects: options.rects } : {}),
    ...(options.saved ? { saved: JSON.stringify({ v: 1, ...options.saved }) } : {}),
  })
  const header = { top: HEADER }
  const off = side.shared.underHeader(side.world.wrap(side.world.body) as unknown as Element, () => header.top)
  try {
    await body(side, header)
  } finally {
    off()
    await side.world.settle()
    side.dispose()
  }
}

const sideOf = (side: ReactSide) => side.world.html.attrs.get('data-panel-side') ?? null
const rest = (side: ReactSide) => {
  const p = side.panel(PANEL)
  return { x: p.x.value, y: p.y.value, w: p.w.value, h: p.h.value }
}
async function openSettled(side: ReactSide): Promise<void> {
  await side.open(PANEL)
  await side.world.settle()
}

describe('a panel docked at a side', () => {
  test('on an iPad: it starts under the header, and the page says which side it takes of the board', async () => {
    await withSide({}, async side => {
      expect(sideOf(side)).toBe(null)
      await openSettled(side)
      expect(rest(side)).toEqual({ x: 1000 - 560, y: HEADER, w: 560, h: 750 - HEADER })
      expect(sideOf(side)).toBe('right')
      // Too narrow to make room for the board's columns: the panel's width is --over-right (its
      // size and MARGIN), which the board keeps clear of all the same (--beside-right, below).
      expect(side.world.html.attrs.get('style')).toContain('--room-right: 0px')
      expect(side.world.html.attrs.get('style')).toContain(`--over-right: ${560 + MARGIN}px`)
      await side.close(PANEL)
      await side.world.settle()
      expect(sideOf(side)).toBe(null)
    })
  })

  test('it follows the header as it takes a row more or less', async () => {
    await withSide({}, async (side, header) => {
      await openSettled(side)
      header.top = 130
      side.world.viewport = { ...IPAD }
      await side.world.fire(side.world.window, 'resize')
      await side.world.settle()
      expect(rest(side)).toEqual({ x: 1000 - 560, y: 130, w: 560, h: 750 - 130 })
    })
  })

  test('on the left of a wide window, where the board makes room: under the header too', async () => {
    await withSide({ viewport: { w: 1800, h: 1000 }, saved: { dock: 'left' } }, async side => {
      await openSettled(side)
      expect(rest(side)).toEqual({ x: 0, y: HEADER, w: 560, h: 1000 - HEADER })
      expect(sideOf(side)).toBe('left')
      expect(side.world.html.attrs.get('style')).toContain('--room-left: 560px')
    })
  })
})

describe('the card the panel is about', () => {
  test('a board scrolling sideways scrolls it into sight that way, as little as it takes', () => {
    const board = { left: 0, right: 440 }
    expect(sidewaysScroll({ left: 30, right: 166 }, board)).toBe(0)
    expect(sidewaysScroll({ left: 620, right: 756 }, board)).toBe(756 - (440 - 16))
    expect(sidewaysScroll({ left: -100, right: 36 }, board)).toBe(-100 - 16)
    // Wider than the board: from its left edge.
    expect(sidewaysScroll({ left: 100, right: 600 }, board)).toBe(100 - 16)
  })

  test('opened from the fifth column on an iPad, it stays in sight as the board narrows beside the panel', async () => {
    let scrolled = 0
    const rects = (el: FakeElement) => {
      const cls = el.node.attrs.get('class')
      if (cls === 'board') return box(0, 0, 440, 2000)
      if (cls === 'card') return box(620 - scrolled, 300, 136, 120)
      return null
    }
    await withSide({ rects }, async side => {
      const [node] = parseHtml('<main class="board" id="board"><div class="card" data-key="a"></div></main>')
      if (node?.kind !== 'element') throw new Error('no board')
      const board = side.world.mount(node)
      const card = board.querySelector('.card')
      Object.defineProperties(board, {
        scrollWidth: { value: 800 },
        scrollLeft: {
          get: () => scrolled,
          set: (v: number) => {
            scrolled = v
          },
        },
      })
      side.keepInSight({ target: () => card, top: () => HEADER })
      await openSettled(side)
      expect(scrolled).toBe(620 + 136 - (440 - 16))
    })
  })

  test('a board whose columns fit beside the panel is not scrolled', async () => {
    // 1800 wide: the board makes room, 1240 left for its columns, the card at its right end.
    const rects = (el: FakeElement) => {
      const cls = el.node.attrs.get('class')
      if (cls === 'board') return box(0, 0, 1240, 2000)
      if (cls === 'card') return box(1240 - 28 - 230, 300, 230, 120)
      return null
    }
    await withSide({ viewport: { w: 1800, h: 1000 }, rects }, async side => {
      const [node] = parseHtml('<main class="board" id="board"><div class="card" data-key="a"></div></main>')
      if (node?.kind !== 'element') throw new Error('no board')
      const board = side.world.mount(node)
      const card = board.querySelector('.card')
      const sets: number[] = []
      Object.defineProperties(board, {
        scrollWidth: { value: 1240 },
        scrollLeft: { get: () => 0, set: (v: number) => void sets.push(v) },
      })
      side.keepInSight({ target: () => card, top: () => HEADER })
      await openSettled(side)
      expect(side.world.html.attrs.get('style')).toContain('--room-right: 560px')
      expect(sets).toEqual([])
    })
  })
})

describe('everywhere else the page is as it was', () => {
  test('a floating panel: where it floated, and no side taken of the board', async () => {
    await withSide({ saved: { dock: 'float' } }, async side => {
      await openSettled(side)
      expect(sideOf(side)).toBe(null)
      // Its default spot, as with no header said.
      expect(rest(side)).toEqual(rectFor({ ...LAYOUT, dock: 'float' }, IPAD))
      expect(side.aside(PANEL).getAttribute('data-dock')).toBe('float')
    })
  })

  test('a panel at the bottom: full width at the window’s foot, and no side taken', async () => {
    await withSide({ saved: { dock: 'bottom' } }, async side => {
      await openSettled(side)
      expect(sideOf(side)).toBe(null)
      expect(rest(side)).toEqual(rectFor({ ...LAYOUT, dock: 'bottom' }, IPAD))
      expect(rest(side).y).toBeGreaterThan(HEADER)
    })
  })

  test('a phone: the full-height sheet, and no side taken', async () => {
    await withSide({ viewport: { w: 390, h: 844 }, phone: true }, async side => {
      await openSettled(side)
      expect(sideOf(side)).toBe(null)
      expect(side.aside(PANEL).getAttribute('data-dock')).toBe('mobile')
      expect(side.world.html.attrs.get('style')).toContain('--room-right: 0px')
      expect(side.world.html.attrs.get('style')).toContain('--over-right: 0px')
    })
  })
})

describe('the stylesheet', () => {
  const rules = rulesOf(SHEET, css)

  test('every rule is under :root[data-panel-side], none for a phone, a floating panel or one at the bottom', () => {
    expect(rules.length).toBeGreaterThan(10)
    expect(rules.filter(r => !r.selector.startsWith(GATE)).map(r => r.selector)).toEqual([])
    expect(bare).not.toContain('760px')
    expect(bare).not.toMatch(/data-dock="(float|bottom|mobile)"/)
    // Nothing global: only @media and @container group rules.
    expect([...new Set([...bare.matchAll(/@([\w-]+)/g)].map(m => m[1]))].sort()).toEqual(['container', 'media'])
  })

  test('linked after the sheets it changes, before the Terminal style', () => {
    const linked = [...readFileSync(join(WEB, 'index.html'), 'utf8').matchAll(/href="styles\/([\w-]+\.css)"/g)].map(
      m => m[1],
    )
    expect(linked.indexOf(SHEET)).toBeGreaterThan(linked.indexOf('app.css'))
    expect(linked.indexOf(SHEET)).toBeGreaterThan(linked.indexOf('cards.css'))
    expect(linked.indexOf(SHEET)).toBe(linked.indexOf('look-terminal.css') - 1)
  })

  test('the header keeps the window’s width; the board and its column heads keep clear of the panel', () => {
    // app.css narrows the whole page (.page) by the room, and the toolbar's row (.toolbar-fit) by a
    // panel lying over the board: here neither.
    expect(declarations(`${GATE} .page`)).toEqual({ 'margin-left': '0', 'margin-right': '0' })
    expect(declarations(`${GATE} .toolbar-fit`)).toEqual({ 'margin-left': '0', 'margin-right': '0' })
    for (const el of ['.board', '.columns-head']) {
      expect(declarations(`${GATE} ${el}`)['margin-left']).toBe('var(--beside-left)')
      expect(declarations(`${GATE} ${el}`)['margin-right']).toBe('var(--beside-right)')
    }
    // The panel's width either way: the room, or what it takes over a board too narrow (its size and MARGIN).
    const vars = declarations(GATE)
    for (const s of ['left', 'right'])
      expect(vars[`--beside-${s}`]).toBe(`calc(var(--room-${s}, 0px) + max(0px, var(--over-${s}, 0px) - ${MARGIN}px))`)
  })

  test('the board scrolls sideways where its columns do not fit, the heads with it, a finger on a card too', () => {
    expect(declarations(`${GATE} .board`)['overflow-x']).toBe('auto')
    expect(declarations(`${GATE} .lane`)['min-width']).toBe('min-content')
    expect(declarations(`${GATE} .columns-head`).overflow).toBe('hidden')
    expect(declarations(`${GATE} .card`)['touch-action']).toBe('pan-x pan-y')
    const board = readFileSync(join(WEB, 'src', 'components', 'Board.tsx'), 'utf8')
    expect(board).toContain('onScroll={headsAlong}')
  })
})

describe('the columns beside the panel', () => {
  test('one with cards keeps a card’s readable width, an empty one its head’s; with no panel the tracks are as they were', () => {
    // Two with cards, one empty, one filling: their least widths go with their shares.
    expect(besideTracks([1, 0, 0.5])).toBe(
      'minmax(max(var(--col-min), calc(var(--col-card) * 1.000)), 1.000fr) ' +
        'minmax(max(var(--col-min), calc(var(--col-card) * 0.000)), 0.000fr) ' +
        'minmax(max(var(--col-min), calc(var(--col-card) * 0.500)), 0.500fr)',
    )
    // The board with no side panel reads --cols, which is as it was.
    expect(columnTracks([1, 0, 0.5])).toBe(
      'minmax(var(--col-min), 1.000fr) minmax(var(--col-min), 0.000fr) minmax(var(--col-min), 0.500fr)',
    )
  })

  test('both are written as the shares move', async () => {
    const written: [string, string][] = []
    const widths = columnWidths((tracks, beside) => void written.push([tracks, beside]))
    widths.fit(['work', 'me', 'idle'], [1, 0, 1])
    await Promise.resolve()
    expect(written.at(-1)).toEqual([columnTracks([1, 0, 1]), besideTracks([1, 0, 1])])
    widths.stop()
  })

  test('the stylesheet: the five columns beside the panel read --cols-beside, a card at least about as wide as on an iPad with no panel', () => {
    const container = bare.slice(bare.indexOf('@container page (min-width: 961px)'))
    expect(declarations(`${GATE} .lane-grid`, container)['grid-template-columns']).toBe(
      'var(--cols-beside, var(--cols))',
    )
    expect(declarations(`${GATE} .columns-head`, container)['grid-template-columns']).toBe(
      'var(--cols-beside, var(--cols))',
    )
    // An iPad (1000 wide) with no panel: three columns with cards and two empty share 1000 less the
    // gutters (2 × 28), the gaps (4 × 12) and the empty ones' heads (2 × 136).
    const without = (1000 - 2 * 28 - 4 * 12 - 2 * 136) / 3
    const card = Number.parseFloat(declarations(GATE)['--col-card'] ?? '0')
    expect(card).toBeGreaterThanOrEqual(Math.floor(without))
    // All five with cards there is narrower still: a card never narrows below what it had then.
    expect(card).toBeGreaterThan((1000 - 2 * 28 - 4 * 12) / 5)
    // The stacked column of a narrower page is left as it was.
    expect(bare.slice(0, bare.indexOf('@container page (min-width: 961px)'))).not.toContain('--cols-beside')
  })
})

describe('the session panel at the side, under the header', () => {
  const SIDE = `${GATE} #sheet:is([data-dock="right"], [data-dock="left"])`
  const narrow = bare.slice(bare.indexOf('@container sheet not ((min-width: 680px) and (min-aspect-ratio: 5 / 4))'))
  const at = (el: string) => declarations(`${SIDE} ${el}`, narrow)

  test('nothing scrolls the panel itself: its head never slides away while a long message is typed', () => {
    expect(narrow.length).toBeGreaterThan(0)
    expect(at('.sheet-inner').overflow).toBe('clip')
  })

  test('its parts give way: the helpers and the card’s fields scroll, the conversation shrinks, never the message box', () => {
    expect(at('.sheet-helpers')['flex-shrink']).toBe('1')
    expect(at('.sheet-card')['max-height']).toBe('15cqh')
    expect(at('.sheet-body')['min-height']).toBe('max(96px, min(16cqh, 280px))')
    expect(at('.composer').flex).toBe('none')
    expect(at('.composer textarea')['max-height']).toBe('min(180px, 18cqh)')
  })

  test('on an iPad in landscape (750 tall, the header 90) the head’s lines, the card’s fields, the least conversation and the tallest message box fit', () => {
    const h = 750 - HEADER
    // A length as the stylesheet writes it (px, cqh of the panel, min and max), in px; none written
    // here: what the panel's own sheets have (session-head.css, helpers.css, app.css).
    const px = (value: string | undefined, theirs: string): number => {
      const expr = (value ?? theirs).replace(/([\d.]+)cqh/g, (_, n) => String((Number(n) / 100) * h)).replace(/px/g, '')
      return new Function('min', 'max', `return ${expr}`)(Math.min, Math.max) as number
    }
    // The head's lines: the pills, a two-line name, the line under it, its paddings.
    const head = 26 + 2 * 26 + 20 + 26
    const card = px(at('.sheet-card')['max-height'], '30cqh')
    const conversation = px(at('.sheet-body')['min-height'], 'max(96px, min(36cqh, 280px))')
    // The message box at its tallest: the buttons' row, two pictures above the box, the box and its
    // padding, the meter under it, the composer's paddings.
    const box = px(at('.composer textarea')['max-height'], '180px')
    const composer = 40 + 64 + box + 12 + 18 + 24
    expect(head + card + conversation + composer).toBeLessThanOrEqual(h)
  })

  test('only a panel docked at a side, beside the board: never a floating one, one at the bottom, a phone', () => {
    const rules = rulesOf(SHEET, narrow.slice(0, narrow.indexOf('}\n}') + 3))
    expect(rules.length).toBeGreaterThan(5)
    for (const r of rules) expect(r.selector.startsWith(SIDE)).toBe(true)
  })
})
