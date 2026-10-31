// An agent's own browser on its card (Card.tsx): a small mark only while it runs, "Open its
// browser" under the question when the agent asks for it there, both opening the session with its
// Browser fold (data-act="browser": Board.tsx, the board's `open` with `browser`). A card without
// one, or with one stopped, is drawn exactly as before, and so is its session panel.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    // Not the class of a terminal's screen (app.css .screen: its grey box and padding hid the icon).
    expect(react).not.toMatch(/<svg[^>]*class="[^"]*\bscreen\b/)
    expect(react).toContain('title="Its browser is running: open it"')
    const ru = bothCards({ items: [it], lang: 'ru' }, 'a').react
    expect(ru).toContain('title="Его браузер запущен: открыть"')
  })

  test('the agent asks for it: "Open its browser" under its question, nowhere else', () => {
    const asks = item({ key: 'a', name: 'Alpha', column: 'me', question: 'Sign in to GitHub for me', attention: 'ask' })
    const { react } = card({ ...asks, desktop: desktop({ asks: true }) })
    expect(marks(react)).toBe(2)
    expect(react).toMatch(/<div class="ask desk-asking">.*Sign in to GitHub for me.*<button[^>]*data-act="browser"/s)
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

describe('a browser ask, while the agent works on', () => {
  // As the board sends it then (services/desktop.ts card): under "needs you", the ask its question.
  const ask = 'Sign in to GitHub as acme-bot'
  const asking = item({
    key: 'a',
    name: 'Alpha',
    status: 'working',
    column: 'me',
    attention: 'ask',
    question: ask,
    desktop: desktop({ asks: true, ask }),
  })

  test('the card is a question under "needs you": "In its browser:" and what to do, "Open its browser" under it', () => {
    const { react } = card(asking)
    expect(react).toContain('data-col="me"')
    expect(react).toMatch(
      /<div class="ask-q">\s*<b>In its browser:<\/b>\s*Sign in to GitHub as acme-bot\s*<\/div>\s*<button[^>]*data-act="browser"/,
    )
    const ru = bothCards({ items: [asking], lang: 'ru' }, 'a').react
    expect(ru).toMatch(
      /<div class="ask-q">\s*<b>В его браузере:<\/b>\s*Sign in to GitHub as acme-bot\s*<\/div>\s*<button[^>]*data-act="browser"/,
    )
  })

  test('a long ask clamps its text on its own: "Open its browser" is outside the clamp, under it, wrapped card text too', () => {
    const long =
      'Тест 5: найди в поиске Википедии «Bishkek», открой статью и нажми «Вернуть», когда она откроется; потом напиши мне в чат, что увидел в первом абзаце, и ничего больше не трогай'
    const it = { ...asking, question: long, desktop: desktop({ asks: true, ask: long }) }
    // the box holds the clamped text and, beside it rather than in it, the button
    expect(bothCards({ items: [it], lang: 'ru' }, 'a').react).toMatch(
      /<div class="ask desk-asking">\s*<div class="ask-q">\s*<b>В его браузере:<\/b>\s*Тест 5[^<]*<\/div>\s*<button class="button desk-ask" data-act="browser"[^>]*>[\s\S]*?<span>Открыть его браузер<\/span>\s*<\/button>\s*<\/div>/,
    )
    // the page's sheets: .ask clamps its whole box (app.css); the browser's ask unclamps it and
    // clamps its text instead (desktop.css), wrapped card text too (card-wrap.css, after its .ask rule)
    const read = (name: string) => readFileSync(join(import.meta.dir, '..', '..', 'web', name), 'utf8')
    expect(read('styles/app.css')).toMatch(/^\.ask \{[^}]*-webkit-line-clamp: 3;[^}]*overflow: hidden;/m)
    const css = read('styles/desktop.css')
    expect(css).toContain('.ask.desk-asking { display: block; -webkit-line-clamp: none; }')
    expect(css).toMatch(
      /^\.desk-asking \.ask-q \{ display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;/m,
    )
    const wrap = read('styles/card-wrap.css')
    const unclamp = ':root[data-card-text="wrap"] .card .ask.desk-asking { -webkit-line-clamp: none; }'
    expect(wrap.indexOf(unclamp)).toBeGreaterThan(wrap.indexOf('.card .ask:not(.qa-card)'))
    const page = read('index.html')
    expect(page.indexOf('styles/desktop.css')).toBeGreaterThan(page.indexOf('styles/app.css'))
  })

  const panel = (it: Item, lang: string) =>
    renderInBoard(
      <PanelProvider viewport={() => ({ w: 1600, h: 1000 })}>
        <Sheet />
      </PanelProvider>,
      board({ data: payload({ items: [it], categories: CATEGORIES }), ui: { open: 'a' } }),
      lang,
    )
  const asked = (it: Item, lang = 'en') =>
    findAll(panel(it, lang), el => hasClass(el, 'asked')).map(el => canonical([el]))

  test('a board ask that is not the browser’s reads as before, with a browser or without', () => {
    const plain = item({ key: 'a', name: 'Alpha', column: 'me', attention: 'ask', question: 'Which branch?' })
    for (const it of [plain, { ...plain, desktop: desktop() }, { ...plain, desktop: desktop({ running: false }) }]) {
      expect(card(it).react).toMatch(/<div class="ask">\s*<b>Asks:<\/b>\s*Which branch\?\s*<\/div>/)
      expect(asked(it)[0]).toMatch(/<b>ASKS<\/b>\s*Which branch\?/)
    }
  })

  test('the session panel’s "needs you" says it too, in both languages', () => {
    const [en] = asked(asking)
    expect(en).toMatch(/<b>IN ITS BROWSER<\/b>\s*Sign in to GitHub as acme-bot/)
    const [ru] = asked(asking, 'ru')
    expect(ru).toMatch(/<b>В ЕГО БРАУЗЕРЕ<\/b>\s*Sign in to GitHub as acme-bot/)
  })
})

describe('"Open its browser" stands out', () => {
  const read = (name: string) => readFileSync(join(import.meta.dir, '..', '..', 'web', 'styles', name), 'utf8')
  test('filled in the ask’s orange on the card and in the panel; outlined in it in the Terminal style, hovered too', () => {
    const css = read('desktop.css')
    expect(css).toContain('.button.desk-ask { background: var(--orange); color: #fff; font-weight: 600; }')
    // nothing over the fill on the card, nor in the panel
    expect(css).not.toMatch(/^\.ask \.desk-ask \{[^}]*background/m)
    expect(css).not.toMatch(/^\.asked \.desk-ask \{[^}]*background/m)
    const terminal = read('look-terminal.css')
    const outline =
      ':root[data-look="terminal"] .button.desk-ask:hover:not(:disabled) { background: none; box-shadow: inset 0 0 0 1px var(--orange); color: var(--orange); font-weight: 700; }'
    expect(terminal).toContain(outline)
    // after the Terminal style's own hover, of the same weight
    expect(terminal.indexOf(outline)).toBeGreaterThan(
      terminal.indexOf(':root[data-look="terminal"] .button:not(.primary):hover:not(:disabled)'),
    )
  })
})
