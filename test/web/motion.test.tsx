// What the board draws while sessions work (#109, web/styles/motion.css): a glyph that turns turns
// in an HTML box of its own, never as the SVG (Chromium animates an SVG element on the main thread,
// a frame of the whole page each time), and a card's hidden hover buttons carry no glass.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import { HelperIcon } from '../../web/src/components/helpers/glyphs.tsx'
import { SpinGlyph } from '../../web/src/components/icons.tsx'
import { SpinQa } from '../../web/src/components/questions/QuestionForm.tsx'
import { item } from './support/board.tsx'
import { drawBoth } from './support/board-scene.tsx'
import { type Element, findAll, hasClass, type Node, reactMarkup } from './support/markup.ts'
import { parseComplex, Tree } from './support/stylesheets.ts'

const WEB = join(import.meta.dir, '..', '..', 'web')
const sheet = (name: string) => readFileSync(join(WEB, 'styles', name), 'utf8')
/** The page's sheets in the order web/index.html links them. */
const SHEETS = [...readFileSync(join(WEB, 'index.html'), 'utf8').matchAll(/href="styles\/([\w-]+\.css)"/g)].map(
  m => m[1] ?? '',
)

interface Rule {
  sheet: string
  selector: string
  body: string
}

/** A sheet's rules with their declarations, but those for reduced motion (they stop loops, not start them). */
function rulesOf(name: string, css = sheet(name)): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open < 0) break
    const prelude = text.slice(i, open).trim()
    let depth = 0
    let close = open
    for (; close < text.length; close++) {
      if (text[close] === '{') depth++
      else if (text[close] === '}' && --depth === 0) break
    }
    const body = text.slice(open + 1, close)
    if (prelude.startsWith('@media')) {
      if (!prelude.includes('prefers-reduced-motion')) rules.push(...rulesOf(name, body))
    } else if (!prelude.startsWith('@'))
      for (const selector of prelude.split(/,(?![^(]*\))/))
        rules.push({ sheet: name, selector: selector.trim().replace(/\s+/g, ' '), body })
    i = close + 1
  }
  return rules
}

const animation = (body: string) => /(?:^|;)\s*animation\s*:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? null

/** Whether the rule's subject is an SVG element: an `svg` or a glyph's `.spin`. */
function onSvg(selector: string): boolean {
  const subject = parseComplex(selector).compounds.at(-1)
  return subject?.tag === 'svg' || !!subject?.classes.includes('spin')
}

const svgsIn = (nodes: Node[]) => findAll(nodes, el => el.tag === 'svg')

/** Every SVG in the markup sits alone in a `span.turn`. */
function turnsInBoxes(nodes: Node[]): void {
  const tree = new Tree(nodes)
  const svgs = svgsIn(nodes)
  expect(svgs.length).toBeGreaterThan(0)
  for (const svg of svgs) {
    const box = tree.parentOf(svg) as Element | null
    expect(box?.tag).toBe('span')
    expect(box && hasClass(box, 'turn')).toBe(true)
    expect(box?.children.filter(c => c.kind === 'element')).toEqual([svg])
  }
}

describe('a glyph that turns turns in a box of its own', () => {
  test('the spinners: a card’s, the helpers’, the questions’', () => {
    for (const glyph of [<SpinGlyph key="card" />, <HelperIcon key="helper" name="spin" />, <SpinQa key="qa" />]) {
      const nodes = reactMarkup(glyph)
      turnsInBoxes(nodes)
      const box = findAll(nodes, el => el.tag === 'span')[0]
      expect(box && hasClass(box, 'spinning')).toBe(true)
    }
  })

  test('on the board: the tool at work, and the arrows of a restart under way', () => {
    const MIN = 60_000
    const working = item({
      key: 'w',
      status: 'working',
      column: 'work',
      activity: Date.now() - MIN,
      tool: { id: 't1', name: 'Bash', label: 'Bash', detail: 'bun test', pending: true },
    })
    const restarting = item({
      key: 'r',
      status: 'idle',
      column: 'idle',
      session: 'sess-r',
      agent: 'claude',
      activity: Date.now() - MIN,
    })
    const restart: ScheduleEntry = {
      id: 'x',
      key: 'r',
      kind: 'restart',
      idle: true,
      by: 'agent',
      text: '',
      next: Date.now(),
      step: 'wake',
    }
    const { react } = drawBoth({ items: [working, restarting], schedules: [restart] })
    const now = findAll(react, el => hasClass(el, 'now'))
    expect(now.map(el => el.attrs.get('class'))).toEqual(['now', 'now restart on'])
    for (const line of now) turnsInBoxes([line.children.find((c): c is Element => c.kind === 'element') as Node])
  })

  test('no sheet leaves an endless animation on an SVG element: motion.css, linked after them, stops each', () => {
    const motion = rulesOf('motion.css')
    const stopped = new Set(motion.filter(r => animation(r.body) === 'none').map(r => r.selector))
    const looping = SHEETS.filter(s => s !== 'motion.css')
      .flatMap(s => rulesOf(s))
      .filter(r => onSvg(r.selector) && animation(r.body)?.includes('infinite'))
    expect(looping.map(r => r.selector)).toEqual([
      '.now.restart.on svg',
      '.spin',
      '.sched-mini .when.on svg',
      '.folder-state[data-state="wait"] svg',
      '.ln-spin svg',
    ])
    for (const r of looping) {
      expect([r.selector, stopped.has(r.selector)]).toEqual([r.selector, true])
      expect(SHEETS.indexOf('motion.css')).toBeGreaterThan(SHEETS.indexOf(r.sheet))
    }
    // What turns instead is a box, at the glyph's own pace.
    for (const r of motion.filter(r => animation(r.body)?.includes('infinite'))) expect(onSvg(r.selector)).toBe(false)
  })
})

test('a card’s hover buttons take their glass only while they show, and keep it while they fade', () => {
  const button = rulesOf('motion.css').filter(r => r.selector.endsWith('.card-actions button'))
  expect(button.map(r => r.selector)).toEqual([
    '.card-actions button',
    '.card:hover .card-actions button',
    '.card:focus-visible .card-actions button',
  ])
  const [hidden, shown] = [button[0]?.body ?? '', button[1]?.body ?? '']
  expect(hidden).toMatch(/(?:^|;)\s*backdrop-filter: none;/)
  expect(hidden).toContain('backdrop-filter 0s linear 160ms')
  expect(shown).toMatch(/(?:^|;)\s*backdrop-filter: blur\(8px\);/)
  expect(shown).toContain('transition-delay: 0s')
  // app.css keeps upstream's glass on every button; motion.css comes after it.
  expect(rulesOf('app.css').find(r => r.selector === '.card-actions button')?.body).toContain(
    'backdrop-filter: blur(8px)',
  )
  expect(SHEETS.indexOf('motion.css')).toBeGreaterThan(SHEETS.indexOf('app.css'))
})
