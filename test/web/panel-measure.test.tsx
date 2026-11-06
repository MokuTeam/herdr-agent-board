// The side panels in a wide panel (#339, web/styles/panels.css): every panel but the session's
// keeps one column under its head, and its lists and forms keep to a reading measure, centred, the
// title over them and the panel's buttons in its corner; the calendar's grid takes the panel's
// whole width. Opened large on a 2560 px window, the calendar, the schedule and the rest had started
// at a third of the panel (upstream's two columns, made for the session's card) and Time sat at the
// left in a column of its own. The geometry is the stylesheet's alone, so the stylesheet is what is
// pinned here, with the markup that picks it; upstream's sheets stay as they were (styles.test.ts).
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ReactNode } from 'react'
import { CalendarPanel } from '../../web/src/components/calendar/CalendarPanel.tsx'
import { Panel } from '../../web/src/components/panel/Panel.tsx'
import { SidePanels, type SidePanelsProps } from '../../web/src/components/SidePanels.tsx'
import type { Schedule } from '../../web/src/hooks/useSchedule.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, renderInBoard } from './support/board.tsx'
import { byId } from './support/markup.ts'

const web = join(import.meta.dir, '..', '..', 'web')
const css = (name: string) => readFileSync(join(web, 'styles', name), 'utf8')
const stylesheets = readdirSync(join(web, 'styles')).filter(f => f.endsWith('.css'))
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? sources(join(dir, d.name)) : d.name.endsWith('.tsx') ? [join(dir, d.name)] : [],
  )
/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (sheet: string, selector: string): string => {
  const at = sheet.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`))
  return at < 0 ? '' : sheet.slice(sheet.indexOf('{', at) + 1, sheet.indexOf('}', at))
}
/** A panel's rule: every one leaves the session sheet alone and weighs no more than its own selector. */
const panel = (selector: string) => `:where(.sheet:not(#sheet)) ${selector}`

function inPanels(node: ReactNode) {
  return renderInBoard(<PanelProvider viewport={() => ({ w: 2560, h: 1440 })}>{node}</PanelProvider>, board())
}
const RESTING: Schedule = { armed: null, held: null, cancel() {}, mode() {}, disarm() {} }
const panels: SidePanelsProps = {
  categories: { open: false, focus: null, onClose() {}, onOpen() {} },
  schedule: { open: false, focus: null, onClose() {}, schedule: RESTING },
}

test('a panel keeps the reading measure unless it asks for the full width', () => {
  const reading = byId(inPanels(<Panel id="p" kind="todos" open={false} onClose={() => {}} title="x" />), 'p')
  expect(reading.attrs.has('data-measure')).toBe(false)
  const full = byId(
    inPanels(<Panel id="p" kind="calendar" measure="full" open={false} onClose={() => {}} title="x" />),
    'p',
  )
  expect(full.attrs.get('data-measure')).toBe('full')
})

test('the calendar takes the full width; the session, the categories and the schedule say nothing', () => {
  const side = inPanels(<SidePanels {...panels} />)
  for (const id of ['sheet', 'cats-sheet', 'sched-sheet']) expect(byId(side, id).attrs.has('data-measure')).toBe(false)
  const cal = inPanels(<CalendarPanel open={false} onClose={() => {}} />)
  expect(byId(cal, 'cal-sheet').attrs.get('data-measure')).toBe('full')
  // and no other panel asks: a new one keeps the measure until it says otherwise
  const asking = sources(join(web, 'src'))
    .filter(f => /measure=\{?["'`]full/.test(readFileSync(f, 'utf8')))
    .map(f => relative(join(web, 'src'), f).replaceAll('\\', '/'))
  expect(asking).toEqual(['components/calendar/CalendarPanel.tsx'])
})

test('a wide panel keeps one column under its head, over upstream’s two; the session sheet keeps its own layouts', () => {
  const sheet = css('panels.css')
  const wide = /@container sheet \(min-width: 680px\) and \(min-aspect-ratio: 5 \/ 4\) \{([\s\S]*?)\n\}/.exec(
    sheet,
  )?.[1]
  expect(wide?.trim()).toBe(`${panel('.sheet-inner')} { display: flex; }`)
  // upstream's two columns are still there for the session sheet's own rules to build on
  expect(css('app.css')).toContain('@container sheet (min-width: 680px) and (min-aspect-ratio: 5 / 4) {')
  // no rule here reaches the session sheet: each is scoped away from it, or only sets the measure's variables
  const selectors = [...sheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(^|\n)\s*([^@\n{}][^{}\n]*) \{/g)].map(
    m => m[2] ?? '',
  )
  expect(selectors.length).toBe(10)
  for (const s of selectors)
    expect([
      s,
      s.startsWith(':where(.sheet:not(#sheet)) ') || s.startsWith('.sheet') || s === ':where(.sheet) *',
    ]).toEqual([s, true])
  // linked after upstream's sheets and the board's own, before the Terminal style
  const page = readFileSync(join(web, 'index.html'), 'utf8')
  const at = (name: string) => page.indexOf(`<link rel="stylesheet" href="styles/${name}">`)
  expect(at('panels.css')).toBeGreaterThan(at('viewers.css'))
  expect(at('panels.css')).toBeGreaterThan(at('session-head.css'))
  expect(at('look-terminal.css')).toBeGreaterThan(at('panels.css'))
})

test('the column is --measure wide and centred by gutters no narrower than the narrow panel’s', () => {
  const sheet = css('panels.css')
  expect(sheet).toContain('\n.sheet { --measure: 760px; --inset: max(0px, (100% - var(--measure)) / 2); }\n')
  expect(sheet).toContain('\n.sheet[data-measure="full"] { --measure: 100%; }\n')
  // the head: the title over the column, the panel's buttons in its corner
  expect(rule(sheet, panel('.sheet-head'))).toBe(' padding-left: max(22px, var(--inset)); ')
  expect(rule(sheet, panel('.sheet-title'))).toBe(' max-width: var(--measure); ')
  expect(rule(sheet, panel('.sheet-tools'))).toBe(' margin-left: auto; ')
  // the body, and what sits beside it across the panel: their gutters centre the column, the scroll bar at the edge
  const gutters = (before: number, after: number) =>
    ` padding-right: max(${after}px, var(--inset)); padding-left: max(${before}px, var(--inset)); `
  expect(rule(sheet, panel('.sheet-body'))).toBe(gutters(22, 18))
  expect(rule(sheet, panel('.archive-find'))).toBe(gutters(22, 18))
  expect(rule(sheet, panel('.sheet-inner > .composer'))).toBe(gutters(18, 14))
  // the narrow panel's gutters, the ones the measure never goes below
  const app = css('app.css')
  expect(rule(app, '.sheet-body')).toContain('padding: 2px 18px 16px 22px;')
  expect(rule(app, '.archive-find')).toContain('padding: 0 18px 10px 22px;')
  expect(rule(app, '.composer')).toContain('padding: 10px 14px 14px 18px;')
})

test('no panel’s scroll body caps its own width: it would sit at the left, its scroll bar in the middle', () => {
  const bodies = new Set<string>()
  for (const f of sources(join(web, 'src')))
    for (const m of readFileSync(f, 'utf8').matchAll(/["'`]sheet-body ([a-z- ]+)["'`]/g))
      for (const c of (m[1] ?? '').split(' ').filter(Boolean)) bodies.add(c)
  // the ones that capped theirs before #339, and the calendar's
  for (const c of ['time-body', 'time-set-body', 'backup-body', 'cats-body', 'sched-body', 'cal-body'])
    expect(bodies.has(c)).toBe(true)
  const capped = stylesheets.flatMap(name =>
    [...bodies].filter(c => /max-width/.test(rule(css(name), `.${c}`))).map(c => `${name}: .${c}`),
  )
  expect(capped).toEqual([])
})

test('a panel’s scroll areas have the page’s quiet thin bar, not the classic one with arrows', () => {
  expect(css('panels.css')).toContain('\n:where(.sheet) * { scrollbar-width: thin; }\n')
  expect(rule(css('app.css'), 'html')).toContain('scrollbar-width: thin; scrollbar-color: var(--scroll) transparent;')
})
