// The board beside a panel docked at a side (web/styles/beside.css, components/panel/place.ts): the
// header keeps the window's width, laid out as with no panel, and the panel starts under it; the
// board and the column heads keep clear of the panel, scrolling sideways where the columns do not
// fit (an iPad in landscape, about 1000 × 750). Only while <html> has data-panel-side, which the
// place sets for a panel docked left or right and never for one floating, at the bottom, closed, or
// on a phone: there the page is as it was.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MARGIN, type PanelLayout, rectFor } from '../../web/src/models/panel-layout.ts'
import { sidewaysScroll } from '../../web/src/models/panel-motion.ts'
import { box, type FakeElement, type RectBox } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'
import { newSide, type ReactSide } from './support/panel-sides.tsx'
import { rulesOf } from './support/stylesheets.ts'

const WEB = join(import.meta.dir, '..', '..', 'web')
const SHEET = 'beside.css'
const GATE = ':root[data-panel-side]'
const css = readFileSync(join(WEB, 'styles', SHEET), 'utf8')
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of every rule (inside @media too) whose selector list holds `selector`, merged. */
function declarations(selector: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map(s => s.trim())
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
