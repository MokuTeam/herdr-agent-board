// The session sheet on a phone (#417, web/styles/sheet-phone.css): the sheet, the conversation and
// the bubble give the message the screen's width, and a table of times and amounts keeps every
// token whole and scrolls inside its bubble. Layout is not here (no engine in the suite; the live
// check in the pull request measured it in a browser): the sheets the page links are read in its
// order, top-level rules and those of the phone's query (max-width: 760px). @container blocks are
// left out: the wide, low layout they hold needs a sheet 680px wide, more than a phone's 560px. What
// wins is the last declaration in that source order among the selectors a test names as reaching
// the element; no specificity is compared, so each list names only selectors where the later one
// is also at least as specific (checked by hand for every property here).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { markdown } from '../../web/src/models/markdown.ts'

const WEB = join(import.meta.dir, '..', '..', 'web')
const read = (path: string) => readFileSync(join(WEB, path), 'utf8')
const PHONE = '(max-width: 760px)'

interface Rule {
  selectors: string[]
  decls: Map<string, string>
  phone: boolean
}

/** Splits at commas outside parentheses: `a, :is(b, c)` is two. */
const splitTop = (text: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts.filter(Boolean)
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const
/** A rule's declarations, a padding shorthand as its four sides. */
const declsOf = (body: string): Map<string, string> => {
  const decls = new Map<string, string>()
  for (const part of body.split(';')) {
    const colon = part.indexOf(':')
    if (colon < 0) continue
    const prop = part.slice(0, colon).trim()
    const value = part.slice(colon + 1).trim()
    if (prop === 'padding') {
      const v = value.split(/\s+/)
      const four = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]]
      for (const [k, side] of SIDES.entries()) decls.set(`padding-${side}`, four[k] as string)
    } else decls.set(prop, value)
  }
  return decls
}

/** A sheet's style rules: top-level, in @supports, and in a media query the phone's width matches. */
const rulesOf = (css: string, phone = false): Rule[] => {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Rule[] = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open < 0) break
    const head = src.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    for (; j < src.length && depth; j++) depth += src[j] === '{' ? 1 : src[j] === '}' ? -1 : 0
    const body = src.slice(open + 1, j - 1)
    if (head.startsWith('@media')) {
      if (splitTop(head.slice('@media'.length)).includes(PHONE)) out.push(...rulesOf(body, true))
    } else if (head.startsWith('@supports')) out.push(...rulesOf(body, phone))
    else if (!head.startsWith('@')) out.push({ selectors: splitTop(head), decls: declsOf(body), phone })
    i = j
  }
  return out
}

/** The sheets the page links, in its order; a phone's own page adds pwa.css after them (core/pwa.ts). */
const PAGE_SHEETS = [...read('index.html').matchAll(/href="styles\/([^"]+\.css)"/g)].map(m => m[1] as string)
const cascade = (sheets: string[]) => sheets.flatMap(sheet => rulesOf(read(join('styles', sheet))))

/** What wins for `prop` on an element the `selectors` reach: on a phone, or at a desktop's width. */
const value = (rules: Rule[], selectors: string[], prop: string, phone: boolean): string | undefined => {
  let found: string | undefined
  for (const rule of rules)
    if ((phone || !rule.phone) && rule.selectors.some(s => selectors.includes(s)) && rule.decls.has(prop))
      found = rule.decls.get(prop)
  return found
}

/** A length at a viewport `vw` px wide: px, calc() and min() of them. */
const px = (length: string | undefined, vw: number): number => {
  const expr = String(length)
    .replace(/(\d+(?:\.\d+)?)vw/g, (_, n: string) => String((Number(n) * vw) / 100))
    .replace(/px/g, '')
    .replace(/calc\(/g, '(')
    .replace(/min\(/g, 'Math.min(')
  if (!/^[\d\s.+\-*/(),Mathmin]+$/.test(expr)) throw new Error(`not a length here: ${length}`)
  return Number(new Function(`return ${expr}`)())
}
const percent = (length: string | undefined): number => {
  const m = /^(\d+(?:\.\d+)?)%$/.exec(String(length))
  if (!m) throw new Error(`not a percentage: ${length}`)
  return Number(m[1]) / 100
}

/** What reaches each part of the session sheet. */
const FRAME = ['.sheet', '#sheet']
const PANE = ['.sheet-body', '#sheet .sheet-body']
const BUBBLE = ['.msg', '#sheet .msg']
const AGENT_BUBBLE = [...BUBBLE, '.msg.assistant', '#sheet .msg:not(.user)']
const OWNER_BUBBLE = [...BUBBLE, '.msg.user']
const LIST = ['.md ul', '#sheet .md ul']
const CELL = ['.md td', '#sheet .md td']
const CELL_CODE = ['.msg code', '#sheet .md :is(th, td) code']

/** Where a message's text runs on a screen `vw` px wide: the frame, the pane, an agent's bubble. */
function textColumn(rules: Rule[], vw: number, phone: boolean) {
  const frame = px(value(rules, FRAME, 'width', phone), vw)
  const margin = phone ? px(value(rules, FRAME, 'right', phone), vw) : 0
  const pane = px(value(rules, PANE, 'padding-left', phone), vw) + px(value(rules, PANE, 'padding-right', phone), vw)
  const bubbleMax = percent(value(rules, AGENT_BUBBLE, 'max-width', phone)) * (frame - pane)
  const inside =
    px(value(rules, BUBBLE, 'padding-left', phone), vw) + px(value(rules, BUBBLE, 'padding-right', phone), vw)
  return { frame, margin, pane, inside, text: bubbleMax - inside }
}

describe('the session sheet on a phone (#417)', () => {
  const page = cascade(PAGE_SHEETS)

  test('at 390 px the sheet, the pane and the bubble keep to the phone’s sizes, and a message runs close to the screen’s width', () => {
    const at390 = textColumn(page, 390, true)
    // The phone's other windows sit 8px inside the screen (the quick look, New session); the head and
    // the message box keep 16px; the open question's box 10px.
    expect(at390.margin).toBeLessThanOrEqual(8)
    expect(at390.frame).toBe(390 - 2 * at390.margin)
    expect(at390.pane).toBeLessThanOrEqual(2 * 16)
    expect(at390.inside).toBeLessThanOrEqual(2 * 10)
    // Upstream's ran in 263px of 390 (67%): 12px, 22px and 18px, 88% of the row, 12px.
    expect(at390.text / 390).toBeGreaterThanOrEqual(0.82)
    // The pane's gutters are the message box's, the open question's and the helpers', so the bubbles
    // line up with the box under them.
    expect(value(page, PANE, 'padding-left', true)).toBe('16px')
    expect(value(page, PANE, 'padding-right', true)).toBe('16px')
    // The owner's bubble keeps its inset from the far side; a bulleted list loses less to its indent,
    // a numbered one keeps room for "10." (it would be cut in a folded message).
    expect(value(page, OWNER_BUBBLE, 'max-width', true)).toBe('88%')
    expect(px(value(page, LIST, 'padding-left', true), 390)).toBeLessThanOrEqual(16)
    expect(value(page, ['.md ol', '#sheet .md ol'], 'padding-left', true)).toBe('20px')
    // At 360 px too.
    expect(textColumn(page, 360, true).text / 360).toBeGreaterThanOrEqual(0.8)
  })

  test('the phone’s own page sits the sheet 8px from the top and the bottom too, clear of the notch', () => {
    const phonePage = cascade([...PAGE_SHEETS, 'pwa.css'])
    expect(value(phonePage, FRAME, 'top', true)).toBe('calc(8px + env(safe-area-inset-top))')
    expect(value(phonePage, FRAME, 'bottom', true)).toBe('calc(8px + env(safe-area-inset-bottom))')
    expect(value(phonePage, FRAME, 'right', true)).toBe('8px')
  })

  test('a message with a four column table of times and amounts: no cell breaks inside a token, the table scrolls inside the message, the page does not scroll sideways', () => {
    const text = [
      '| Day | Lane | Start | Amount | Note |',
      '|-----|------|-------|-------:|------|',
      '| 2026-11-12 | atlas | 15:01 | 270.00 | ben’s review |',
      '| 2026-11-13 | cleo-tools | 09:30 | 1,240.50 | the long call with anna |',
    ].join('\n')
    const html = markdown(text)
    // Its own scroller around the table; a short cell is whole, a longer one of words is not.
    expect(html).toStartWith('<div class="table"><table>')
    for (const token of ['2026-11-12', 'atlas', '15:01', 'cleo-tools', 'ben’s review'])
      expect(html).toContain(`<td class="whole">${token}</td>`)
    for (const amount of ['270.00', '1,240.50'])
      expect(html).toContain(`<td class="whole" style="text-align:right">${amount}</td>`)
    expect(html).toContain('<td>the long call with anna</td>')
    // A cell wraps between words only: not inside one, as the bubble's `anywhere` let it (a cell then
    // shrank to a letter, and 15:01 showed as 15:0 over 1). Code in a cell too.
    expect(value(page, BUBBLE, 'overflow-wrap', true)).toBe('anywhere')
    expect(value(page, CELL, 'overflow-wrap', true)).toBe('normal')
    expect(value(page, CELL, 'word-break', true)).toBe('normal')
    expect(value(page, CELL_CODE, 'overflow-wrap', true)).toBe('normal')
    // A short cell not at all: a date or a lane would still break after its hyphen. A longer one keeps
    // a measure, not a word to a line, when the table is squeezed: the table scrolls first.
    expect(value(page, ['#sheet .md .whole'], 'white-space', true)).toBe('nowrap')
    expect(value(page, ['#sheet .md :is(th, td):not(.whole)'], 'min-width', true)).toBe('10em')
    // Wider than the bubble, the table scrolls inside it, and the bubble never leaves the pane.
    expect(value(page, ['.md .table'], 'overflow-x', true)).toBe('auto')
    expect(percent(value(page, AGENT_BUBBLE, 'max-width', true))).toBeLessThanOrEqual(1)
    // So the page itself does not: the pane scrolls and the sheet clips, inside the screen.
    expect(value(page, PANE, 'overflow', true)).toBe('auto')
    expect(value(page, ['.sheet-inner'], 'overflow', true)).toBe('hidden')
    expect(px(value(page, FRAME, 'width', true), 390)).toBeLessThanOrEqual(390)
    // Its edge shows where there is more of it: a fade driven by its own sideways scroll.
    const fade = rulesOf(read('styles/sheet-phone.css')).find(r => r.selectors.includes('#sheet .md .table'))
    expect(fade?.phone).toBe(true)
    expect(fade?.decls.get('animation-timeline')).toBe('scroll(self inline), scroll(self inline)')
    // As wide as what is left to scroll, up to 24px: a near fit keeps its last digits clear.
    expect(fade?.decls.get('animation-range')).toBe('0px 24px, calc(100% - 24px) 100%')
    expect(fade?.decls.get('mask-image')).toContain('var(--table-fade-end)')
    // A code block's long line scrolls inside the block, as it did.
    expect(value(page, ['.md pre'], 'white-space', true)).toBe('pre')
    expect(value(page, ['.md pre'], 'overflow', true)).toBe('auto')
  })

  test('the desktop is as it was: every new rule is the phone’s, and a wide window reads upstream’s sizes', () => {
    const own = rulesOf(read('styles/sheet-phone.css'))
    expect(own.length).toBeGreaterThan(0)
    expect(own.filter(rule => !rule.phone)).toEqual([])
    // pwa.css (the phone's own page, also a desk's browser at any width): only its phone query moved.
    expect(rulesOf(read('styles/pwa.css')).filter(r => !r.phone && r.selectors.includes('.sheet'))).toEqual([])
    // What a desktop reads: upstream's frame, gutters, bubble and list, and the bubble's wrap in a cell.
    expect(value(page, FRAME, 'width', false)).toBe('560px')
    expect(value(page, PANE, 'padding-left', false)).toBe('22px')
    expect(value(page, PANE, 'padding-right', false)).toBe('18px')
    expect(value(page, BUBBLE, 'padding-left', false)).toBe('12px')
    expect(value(page, AGENT_BUBBLE, 'max-width', false)).toBe('88%')
    expect(value(page, LIST, 'padding-left', false)).toBe('20px')
    expect(value(page, CELL, 'overflow-wrap', false)).toBeUndefined()
    expect(value(page, [...CELL, '#sheet .md .whole', '.md .whole', '.whole'], 'white-space', false)).toBeUndefined()
    expect(value(page, ['.md .table'], 'mask-image', false)).toBeUndefined()
  })
})
