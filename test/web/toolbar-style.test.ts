// What the toolbar's stylesheet (#347, web/styles/toolbar.css) does with the attributes the page draws
// (`data-rows`, `data-over`, `data-folded`, `data-moving`, `.measuring`), read from its text: layout is
// not in jsdom, and the rows must not wrap at any width. The rules in the page's other sheets that wrap
// the row stay upstream's; this sheet answers each of them with a rule of more weight.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')
const css = read('web/styles/toolbar.css')
const app = read('web/styles/app.css')
const plain = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the first rule whose selector is exactly `selector`; null for none. */
function rule(sheet: string, selector: string): Record<string, string> | null {
  const text = plain(sheet)
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(text)
  if (!found) return null
  const out: Record<string, string> = {}
  for (const decl of (found[1] ?? '').split(';')) {
    const at = decl.indexOf(':')
    if (at > 0) out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim()
  }
  return out
}

describe('no row of the toolbar wraps', () => {
  test('nothing in the sheet wraps, and the row is told it does not', () => {
    expect(plain(css)).not.toMatch(/flex-wrap:\s*wrap/)
    expect(rule(css, '.toolbar .toolbar-row')).toMatchObject({ 'flex-wrap': 'nowrap' })
    expect(rule(css, '.toolbar .toolbar-row::after')).toMatchObject({ display: 'none' })
  })

  test('upstream wraps the row at narrow widths; each of its rules has an answer of more weight here', () => {
    // app.css (pinned to upstream): the container queries at 1200 and 560 px.
    expect(plain(app)).toMatch(/\.toolbar-row \{ flex-wrap: wrap; gap: 0 6px; \}/)
    expect(plain(app)).toMatch(/\.toolbar-row::after \{ content: ""; order: 2; flex: 0 0 100%; \}/)
    expect(plain(app)).toMatch(/\.titles \{ order: 0; flex: 1 1 auto; margin-right: 10px; \}/)
    // `.toolbar .toolbar-row` (two classes) over `.toolbar-row` (one). `.titles` (the page's name for screen
    // readers, and the summary) draws no box, so its flex, order and margin apply to nothing; the summary,
    // its only thing in the row, answers for itself.
    expect(rule(css, '.toolbar .titles')).toMatchObject({ display: 'contents' })
    expect(rule(css, '.toolbar .summary')).toMatchObject({ flex: 'none', order: '0', margin: '0' })
    expect(rule(css, '.toolbar #next-attention, .toolbar .limits')).toMatchObject({ 'margin-top': '0', order: '0' })
    expect(rule(css, '.toolbar .live')).toMatchObject({ 'margin-top': '0', order: '0' })
    expect(rule(css, '.toolbar .controls')).toMatchObject({ display: 'contents' })
  })

  test('the toolbar’s sheet is linked after upstream’s, so a rule of equal weight is ours', () => {
    const links = [...read('web/index.html').matchAll(/href="styles\/([^"]+)"/g)].map(m => m[1])
    expect(links.indexOf('toolbar.css')).toBeGreaterThan(links.indexOf('app.css'))
    expect(links.indexOf('toolbar.css')).toBeGreaterThan(links.indexOf('segments.css'))
    expect(links.indexOf('toolbar.css')).toBeLessThan(links.indexOf('look-terminal.css'))
  })

  test('the two-row layout is a grid of two lines: the actions (after the summary, where there is one), then the filters on a line of their own', () => {
    // No gap between the columns: the summary's own margin is the gap after it, so while it is hidden
    // (no box, an empty first column) the actions have the whole row.
    expect(rule(css, '.toolbar-fit[data-rows] .toolbar-row')).toMatchObject({
      display: 'grid',
      'grid-template-columns': 'auto minmax(0, 1fr)',
      gap: '0',
    })
    expect(rule(css, '.toolbar-fit[data-rows] .summary')).toMatchObject({
      'grid-column': '1',
      'grid-row': '1',
      margin: '0 8px 0 0',
    })
    expect(rule(css, '.toolbar-fit[data-rows] .toolbar-actions')).toMatchObject({ 'grid-column': '2', 'grid-row': '1' })
    expect(rule(css, '.toolbar-fit[data-rows] .toolbar-filters')).toMatchObject({
      'grid-column': '1 / -1',
      'grid-row': '2',
    })
  })

  test('the breakpoint is the page’s measurement, not a container query of the sheet', () => {
    expect(plain(css)).not.toMatch(/@container/)
  })
})

describe('what leaves the row and what is folded', () => {
  test('an action in More is hidden, but not while the row is being measured', () => {
    expect(rule(css, '.toolbar-actions:not(.measuring) > [data-over]')).toMatchObject({ display: 'none' })
    expect(rule(css, '.toolbar-actions.measuring > *')).toMatchObject({ flex: 'none !important' })
    expect(rule(css, '.toolbar-actions.measuring')).toMatchObject({ 'justify-content': 'flex-start' })
  })

  test('in one row the actions are as wide as they are, at the end of it, and the filters give way to them', () => {
    // A zero basis there would leave them what the filters do not take, and the filters would never fold.
    expect(rule(css, '.toolbar-fit:not([data-rows]) .toolbar-actions')).toMatchObject({
      flex: '0 0 auto',
      'margin-left': 'auto',
    })
    expect(rule(css, '.toolbar-filters')).toMatchObject({ flex: '0 1 auto', 'min-width': '0' })
  })

  test('the Terminal look draws the filters button’s count as a plain figure', () => {
    expect(rule(read('web/styles/look-terminal.css'), ':root[data-look="terminal"] #toolbar-peek.on .n')).toMatchObject(
      {
        background: 'none',
      },
    )
  })

  test('the actions take what is left of the row, whatever they hold, and the first (Next) may shrink', () => {
    expect(rule(css, '.toolbar-actions')).toMatchObject({
      flex: '1 1 0',
      'min-width': '0',
      'justify-content': 'flex-end',
    })
    expect(rule(css, '.toolbar-actions > #next-attention')).toMatchObject({ flex: '0 1 auto', 'min-width': '0' })
    expect(rule(css, '#next-attention > span')).toMatchObject({ 'text-overflow': 'ellipsis' })
  })

  test('there is no title to tap: nothing in the sheet makes the title a pointer', () => {
    expect(plain(css)).not.toMatch(/\.titles\s*\{[^}]*cursor/)
    expect(plain(css)).not.toMatch(/\.folded \.titles/)
  })

  test('folded filters have no height and no gap above them, cannot be reached, and may move while they fold', () => {
    const folded = rule(css, '.toolbar-fit[data-rows] .toolbar-filters[data-folded]:not([data-moving])')
    expect(folded).toMatchObject({
      height: '0',
      'margin-top': '0',
      overflow: 'hidden',
      visibility: 'hidden',
      opacity: '0',
    })
    expect(rule(css, '.toolbar-fit[data-rows] .toolbar-filters[data-moving]')).toMatchObject({ overflow: 'hidden' })
    // The open filters clip nothing: a focus ring and a shadow are theirs to draw.
    expect(rule(css, '.toolbar-fit[data-rows] .toolbar-filters')).toMatchObject({ 'margin-top': '8px' })
    expect(rule(css, '.toolbar-fit[data-rows] .toolbar-filters')?.overflow).toBeUndefined()
  })

  test('only the two-row toolbar folds: one row has no such rule', () => {
    for (const line of plain(css)
      .split('\n')
      .filter(l => l.includes('[data-folded]')))
      expect(line).toContain('.toolbar-fit[data-rows]')
  })
})

describe('a phone’s width (#599)', () => {
  test('every rule of it is under `data-narrow`, which the page sets in two rows only', () => {
    const lines = plain(css)
      .split('\n')
      .filter(l => l.includes('[data-narrow]'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines.filter(l => l.includes('{') || l.trim().endsWith(',')))
      expect(line.trim().startsWith('.toolbar-fit[data-narrow]')).toBe(true)
    // Nothing else in the sheet looks for a phone: the wider toolbars go down the rules they had.
    expect(plain(css)).not.toMatch(/@media[^{]*width/)
  })

  test('the actions start where the row does; More, or Settings while More is hidden, keeps its end', () => {
    expect(rule(css, '.toolbar-fit[data-narrow] .toolbar-actions')).toEqual({ 'justify-content': 'flex-start' })
    expect(
      rule(
        css,
        '.toolbar-fit[data-narrow] #toolbar-more,\n.toolbar-fit[data-narrow] #toolbar-more[data-over] + #settings',
      ),
    ).toEqual({ 'margin-left': 'auto' })
    // Measuring is as in two rows: it starts at the row's start already, every action whole.
    expect(rule(css, '.toolbar-actions.measuring')).toMatchObject({ 'justify-content': 'flex-start' })
  })

  test('the filters go two to a line in halves; search has a line of its own after two pickers, else the half beside the last', () => {
    expect(rule(css, '.toolbar-fit[data-narrow] .toolbar-filters')).toEqual({
      display: 'grid',
      'grid-template-columns': 'repeat(2, minmax(0, 1fr))',
      gap: '8px 6px',
    })
    expect(rule(css, '.toolbar-fit[data-narrow] .toolbar-filters[data-picks="2"] > .search')).toEqual({
      'grid-column': '1 / -1',
    })
    expect(rule(css, '.toolbar-fit[data-narrow] .toolbar-filters > .search')).toEqual({ 'max-width': 'none' })
    expect(rule(css, '.toolbar-fit[data-narrow] .toolbar-filters > .segment-pick')).toMatchObject({ width: '100%' })
  })

  test('the segments keep their max-width there: it is the room that folds them into a pill', () => {
    for (const line of plain(css)
      .split('\n')
      .filter(l => l.includes('[data-narrow]')))
      expect(line).not.toMatch(/\.segmented/)
  })

  test('"All" on show has no count on a phone; a choice of its own keeps it', () => {
    expect(rule(css, '.toolbar-fit[data-narrow] .segment-pick.all .n')).toEqual({ display: 'none' })
    expect(rule(css, '.toolbar-fit[data-narrow] .segment-pick .n')).toMatchObject({ flex: 'none' })
  })

  test('the folded filters fold on a phone as in two rows: no rule of it touches the fold', () => {
    for (const line of plain(css)
      .split('\n')
      .filter(l => l.includes('[data-narrow]')))
      expect(line).not.toMatch(/data-folded|data-moving/)
  })
})

describe('one size and one shape', () => {
  test('every control of the toolbar is 28 px high with the same radius', () => {
    expect(
      rule(
        css,
        '.toolbar .pill-toggle,\n.toolbar .setup-note,\n.toolbar .search,\n.toolbar .segmented,\n.toolbar .limits',
      ),
    ).toMatchObject({ height: '28px', 'border-radius': '9px' })
  })

  test('the segments fill the height of their control', () => {
    expect(rule(css, '.toolbar .segmented button')).toMatchObject({ 'align-self': 'stretch', padding: '0 12px' })
  })
})

describe('motion and materials', () => {
  test('reduced motion draws no transition of ours, and reduced transparency a solid ring on the dot', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.toolbar-more, #toolbar-peek \{ transition: none; \}/,
    )
    expect(css).toMatch(
      /@media \(prefers-reduced-transparency: reduce\) \{[^}]*\.more-dot \{ box-shadow: 0 0 0 2px var\(--bg\); \}/,
    )
  })

  test('a touch screen does not keep the press: the button is not left scaled', () => {
    expect(css).toMatch(/@media \(hover: none\) \{[^}]*transform: none;/)
  })
})
