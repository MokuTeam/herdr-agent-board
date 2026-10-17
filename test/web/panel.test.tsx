// The React side-panel shell against today's: the three asides of web/index.html after web/panel.js
// made them panels (the edges, the place button's glyph, data-dock) and app.js filled the texts —
// run by the old code itself in a fake DOM (support/panel-sides.tsx) — and what <Panel>,
// <SidePanels> and <App> render with react-dom/server, in English and Russian.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import { App } from '../../web/src/App.tsx'
import { Panel } from '../../web/src/components/panel/Panel.tsx'
import { SidePanels, type SidePanelsProps } from '../../web/src/components/SidePanels.tsx'
import type { Schedule } from '../../web/src/hooks/useSchedule.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import {
  addButtonTypes,
  byId,
  canonical,
  type Element,
  find,
  hasClass,
  type Node,
  OLD_PAGE_ONLY,
  setAttr,
  stripAttrs,
} from './support/markup.ts'
import { oldScheduleBody } from './support/old-schedule.ts'
import { KINDS, oldSide, titleOf } from './support/panel-sides.tsx'

const VP = { w: 1600, h: 1000 }
const IDS = ['sheet', 'cats-sheet', 'sched-sheet']

/** The aside with only the head kept in .sheet-inner (the bodies are the panels' own: sheet, categories-panel and schedule tests). */
function shell(aside: Element): string {
  const copy: Element = {
    ...aside,
    children: aside.children.map(c =>
      c.kind === 'element' && hasClass(c, 'sheet-inner')
        ? { ...c, children: c.children.filter(n => n.kind === 'element' && n.tag === 'header') }
        : c,
    ),
  }
  return canonical([copy])
}

/** Today's asides as the page starts: panel.js's Panel on each, then applyTexts. */
async function oldAsides(lang: string): Promise<Map<string, Node[]>> {
  const side = await oldSide({ viewport: VP, ids: IDS, lang })
  try {
    return new Map(
      IDS.map(id => {
        const nodes: Node[] = [structuredCloneNode(side.aside(id).node)]
        stripAttrs(nodes, OLD_PAGE_ONLY)
        addButtonTypes(nodes)
        return [id, nodes]
      }),
    )
  } finally {
    side.dispose()
  }
}

function structuredCloneNode(node: Element): Element {
  return {
    ...node,
    attrs: new Map(node.attrs),
    children: node.children.map(c => (c.kind === 'element' ? structuredCloneNode(c) : { ...c })),
  }
}

function inPanels(node: ReactNode, lang = 'en') {
  return renderInBoard(<PanelProvider viewport={() => VP}>{node}</PanelProvider>, board(), lang)
}

const asideOf = (nodes: Node[], id: string): Element => byId(nodes, id)

const RESTING: Schedule = { armed: null, held: null, cancel() {}, mode() {}, disarm() {} }
/** The categories and schedule panels asked open or not, at nothing in particular. */
const panelsOf = (open: boolean): SidePanelsProps => ({
  categories: { open, focus: null, onClose() {}, onOpen() {} },
  schedule: { open, focus: null, onClose() {}, schedule: RESTING },
})

describe.each(['en', 'ru'])('the shell in %s', lang => {
  const t = translator(lang)
  test('<Panel> draws each aside as panel.js made it: grip, head with the place and close buttons, the edges', async () => {
    const old = await oldAsides(lang)
    for (const id of IDS) {
      const kind = KINDS[id] ?? 'categories'
      const react = inPanels(
        <Panel id={id} kind={kind} open={false} onClose={() => {}} title={titleOf(kind, t)} />,
        lang,
      )
      expect(shell(asideOf(react, id))).toBe(shell(asideOf(old.get(id) ?? [], id)))
    }
  })
  test('<SidePanels> mounts the three in the page’s order, each with its body container', async () => {
    const old = await oldAsides(lang)
    // At start app.js makes the session's name focusable (it is renamed where it is).
    setAttr(byId(old.get('sheet') ?? [], 'sheet-name'), 'tabindex', '0')
    const react = inPanels(<SidePanels {...panelsOf(false)} />, lang)
    const asides = react.filter((n): n is Element => n.kind === 'element')
    expect(asides.map(a => a.attrs.get('id'))).toEqual(IDS)
    for (const id of IDS) expect(shell(asideOf(react, id))).toBe(shell(asideOf(old.get(id) ?? [], id)))
    const inner = (id: string) => find([asideOf(react, id)], el => hasClass(el, 'sheet-inner')).children
    // The session sheet's own parts (their markup: sheet.test.tsx).
    expect(inner('sheet').map(n => (n.kind === 'element' ? (n.attrs.get('id') ?? n.attrs.get('class')) : ''))).toEqual([
      'sheet-head',
      'sheet-properties-toggle',
      'sheet-card',
      'sheet-question',
      'sheet-body',
      'composer',
    ])
    // The categories (no lanes yet): the list, the form's place and "New category", as web/index.html has them.
    const oldInner = (id: string) =>
      find([asideOf(old.get(id) ?? [], id)], el => hasClass(el, 'sheet-inner')).children.filter(
        n => n.kind === 'element' && n.tag !== 'header',
      )
    expect(canonical(inner('cats-sheet').slice(1))).toBe(canonical(oldInner('cats-sheet')))
    // The schedule draws what it has from the start; the old page drew it when opened: nothing scheduled.
    const sched = find([asideOf(react, 'sched-sheet')], el => el.attrs.get('id') === 'sched-body')
    const data = payload({ lang: lang === 'ru' ? 'ru' : 'en' })
    expect(canonical(sched.children)).toBe(canonical(oldScheduleBody({ lang, data, now: Date.now() })))
  })
})

test('<App> puts the panels after the page and before the usage popover, as web/index.html does', () => {
  const react = inPanels(<App />)
  const top = react
    .filter((n): n is Element => n.kind === 'element')
    .map(el => el.attrs.get('id') ?? el.attrs.get('class'))
  expect(top).toEqual(['page', 'sheet', 'cats-sheet', 'sched-sheet', 'limits-pop', 'toasts'])
})

test('a wide, low panel reads side by side by the stylesheet alone: the aside is its size container, .sheet-inner the grid', () => {
  const css = readFileSync(join(import.meta.dir, '..', '..', 'web', 'app.css'), 'utf8')
  expect(css).toMatch(/\n\.sheet \{[^}]*container: sheet \/ size;/)
  const wide = css.slice(css.indexOf('@container sheet (min-width: 680px) and (min-aspect-ratio: 5 / 4) {'))
  expect(wide).toMatch(
    /^@container sheet [^{]*\{\s*\.sheet-inner \{ display: grid;[^}]*\}\s*\.sheet-head \{ grid-column: 1 \/ -1;/,
  )
  for (const id of IDS) {
    const aside = asideOf(inPanels(<SidePanels {...panelsOf(true)} />), id)
    expect(hasClass(aside, 'sheet')).toBe(true)
    const inner = aside.children.find((c): c is Element => c.kind === 'element' && hasClass(c, 'sheet-inner'))
    const head = inner?.children.find((c): c is Element => c.kind === 'element')
    expect(head?.tag).toBe('header')
    expect(head && hasClass(head, 'sheet-head')).toBe(true)
  }
})

test('a panel’s own tools come before the place button', () => {
  const react = inPanels(
    <Panel
      id="sheet"
      kind="session"
      open={false}
      onClose={() => {}}
      title="x"
      tools={<button type="button" id="own" />}
    />,
  )
  const aside = asideOf(react, 'sheet')
  const tools = find([aside], el => hasClass(el, 'sheet-tools')).children
  expect(
    tools.map(n =>
      n.kind === 'element' ? (n.attrs.get('id') ?? [...n.attrs.keys()].find(k => k.startsWith('data-'))) : '',
    ),
  ).toEqual(['own', 'data-layout', 'sheet-close'])
})
