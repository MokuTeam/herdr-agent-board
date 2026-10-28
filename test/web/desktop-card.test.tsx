// An agent's own browser on its card (Card.tsx): a small mark only while it runs, "Open its
// browser" under the question when the agent asks for it there, both opening the session with its
// Browser fold (data-act="browser": Board.tsx, the board's `open` with `browser`). A card without
// one, or with one stopped, is drawn exactly as before, and so is its session panel.
import { describe, expect, test } from 'bun:test'
import type { Item, ItemDesktop } from '../../src/core/types.ts'
import { Sheet } from '../../web/src/components/sheet/Sheet.tsx'
import { boardUi, initialUi } from '../../web/src/state/board-ui.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { bothCards, CATEGORIES } from './support/board-scene.tsx'
import { canonical, findAll, hasClass } from './support/markup.ts'
import { bothSheets } from './support/sheet-scene.tsx'

const desktop = (fields: Partial<ItemDesktop> = {}): ItemDesktop => ({
  running: true,
  profile: null,
  control: 'agent',
  asks: false,
  ...fields,
})
const card = (it: Item) => bothCards({ items: [it] }, it.key)
const marks = (html: string) => html.match(/data-act="browser"/g)?.length ?? 0

describe('the browser mark', () => {
  test('a card without a browser, or with one stopped, is the old page’s card as before', () => {
    for (const column of ['work', 'me', 'idle'] as const) {
      const plain = item({ key: 'a', name: 'Alpha', column, question: 'Sign in?' })
      const stopped = { ...plain, desktop: desktop({ running: false }) }
      const before = card(plain)
      expect(card(stopped).react).toBe(before.react)
      expect(marks(before.react)).toBe(0)
    }
  })

  test('only while it runs: a button by the name that opens its browser, in either language', () => {
    const it = item({ key: 'a', name: 'Alpha', column: 'work', desktop: desktop() })
    const { react } = card(it)
    expect(marks(react)).toBe(1)
    expect(react).toMatch(/<button[^>]*class="desk-mark"[^>]*data-act="browser"/)
    expect(react).toContain('title="Its browser is running: open it"')
    const ru = bothCards({ items: [it], lang: 'ru' }, 'a').react
    expect(ru).toContain('title="Его браузер запущен: открыть"')
  })

  test('the agent asks for it: "Open its browser" under its question, nowhere else', () => {
    const asks = item({ key: 'a', name: 'Alpha', column: 'me', question: 'Sign in to GitHub for me', attention: 'ask' })
    const { react } = card({ ...asks, desktop: desktop({ asks: true }) })
    expect(marks(react)).toBe(2)
    expect(react).toMatch(/<div class="ask">.*Sign in to GitHub for me.*<button[^>]*data-act="browser"/s)
    expect(react).toContain('Open its browser')
    // Not asking: the mark alone.
    expect(marks(card({ ...asks, desktop: desktop() }).react)).toBe(1)
  })
})

describe('the opening it asks for', () => {
  const ui = initialUi((_key, fallback) => fallback)

  test('open with `browser`: the sheet opens with the fold; any other opening without', () => {
    const withFold = boardUi(ui, { type: 'open', key: 'a', browser: true })
    expect(withFold).toMatchObject({ open: 'a', browser: true, compose: false, opened: 1 })
    const plain = boardUi(withFold, { type: 'open', key: 'a' })
    expect(plain).toMatchObject({ open: 'a', browser: false, opened: 2 })
    expect(boardUi(withFold, { type: 'open', key: 'b', compose: true })).toMatchObject({ browser: false })
    expect(ui.browser).toBe(false)
  })
})

describe('the session panel', () => {
  const VP = { w: 1600, h: 1000 }
  const mounted = (it: Item, browser: boolean) =>
    renderInBoard(
      <PanelProvider viewport={() => VP}>
        <Sheet />
      </PanelProvider>,
      board({ data: payload({ items: [it], categories: CATEGORIES }), ui: { open: it.key, browser } }),
    )
  const folds = (it: Item, browser: boolean) =>
    findAll(mounted(it, browser), el => hasClass(el, 'desk')).map(el => canonical([el]))

  test('without a running browser it is the old page’s panel as before, and has no fold', () => {
    const plain = item({ key: 'a', name: 'Alpha', column: 'me', question: 'Sign in?' })
    const stopped = { ...plain, desktop: desktop({ running: false, asks: true }) }
    const before = bothSheets({ items: [plain], open: 'a' })
    expect(before.react).toBe(before.old)
    expect(bothSheets({ items: [stopped], open: 'a' }).react).toBe(before.react)
    expect(folds(plain, true)).toEqual([])
    expect(folds(stopped, true)).toEqual([])
  })

  test('a running browser: the fold above the conversation, open when the opening asked for it, folded else', () => {
    const it = item({ key: 'a', name: 'Alpha', column: 'work', desktop: desktop() })
    const [open] = folds(it, true)
    expect(open).toContain('aria-expanded="true"')
    expect(open).toContain('Take control')
    const [folded] = folds(it, false)
    expect(folded).toContain('aria-expanded="false"')
    expect(folded).not.toContain('Take control')
  })
})
