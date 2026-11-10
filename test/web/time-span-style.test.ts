// The Time panel's week and month as they look (#241, web/styles/time.css): in light and in dark
// they take every colour from the board's theme; at a phone's width the month steps its type down
// and nothing has a width of its own that would push past the screen; with reduced motion nothing
// moves (the presses change colour, never place, and their fades go).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const STYLES = join(import.meta.dir, '..', '..', 'web', 'styles')
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const time = readFileSync(join(STYLES, 'time.css'), 'utf8')
const app = strip(readFileSync(join(STYLES, 'app.css'), 'utf8'))
const calendar = strip(readFileSync(join(STYLES, 'calendar.css'), 'utf8'))

/** The week's and month's rules: from their heading to the next part of the sheet. */
const from = time.lastIndexOf('/*', time.indexOf('week and month (#241)'))
const to = time.indexOf('/* A finger: rows and buttons the size of one. */')
const section = strip(time.slice(from, to))
/** Each rule as `selector { body }`, the ones inside an at-rule too. */
const rules = [...section.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
  selector: (m[1] as string).trim(),
  body: m[2] as string,
}))
/** The sheet's reduced motion block. */
const reduced = (() => {
  const at = time.indexOf('@media (prefers-reduced-motion: reduce)')
  const open = time.indexOf('{', at)
  let depth = 0
  for (let i = open; i < time.length; i++) {
    if (time[i] === '{') depth++
    else if (time[i] === '}' && --depth === 0) return strip(time.slice(open + 1, i))
  }
  return ''
})()

test('the week’s and month’s rules are there, after the day’s', () => {
  expect(from).toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  expect(rules.length).toBeGreaterThan(20)
})

test('light and dark: every colour from the board’s theme, which sets it for both', () => {
  // no colour of its own but the white on today's red, as the Calendar's today
  expect(section.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual(['#fff'])
  expect(section).not.toMatch(/\b(rgba?|hsla?|oklch|lab)\(/)
  const own = new Set(['--lane', '--share'])
  const used = [...new Set([...section.matchAll(/var\((--[\w-]+)/g)].map(m => m[1] as string))].filter(v => !own.has(v))
  expect(used.length).toBeGreaterThan(5)
  for (const v of used) {
    const defined = app.match(new RegExp(`${v}\\s*:`, 'g'))?.length ?? 0
    // a colour is defined for light, for dark as the system has it, and for dark as picked;
    // (more where a contrast setting has its own); the accent and the display font are one for both
    if (v === '--accent' || v === '--font-display') expect(defined).toBeGreaterThanOrEqual(1)
    else expect({ v, lightAndDark: defined >= 3 }).toEqual({ v, lightAndDark: true })
  }
})

test('a phone’s width: the month steps down where it is narrow, and no row has a width of its own', () => {
  expect(section).toMatch(/\.time-month\s*\{[^}]*container:\s*time-month\s*\/\s*inline-size/)
  expect(section).toMatch(/@container time-month \(max-width: \d+px\)/)
  // the Calendar's grid: seven columns that give their width up
  expect(calendar).toMatch(/\.cal-month-days\s*\{[^}]*grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\)/)
  // a week's row: its day and its chevron fixed, its middle what is left
  const row = rules.find(r => r.selector === '.time-week-day')?.body ?? ''
  const columns = /grid-template-columns:\s*([^;]+);/.exec(row)?.[1] ?? ''
  expect(columns).toContain('minmax(0, 1fr)')
  const fixed = [...columns.matchAll(/(\d+)px/g)].reduce((n, m) => n + Number(m[1]), 0)
  expect(fixed).toBeLessThanOrEqual(60)
  for (const r of rules) {
    expect({ selector: r.selector, minWidth: /(^|;)\s*min-width:\s*(\d+)px/.exec(r.body)?.[2] ?? '0' }).toEqual({
      selector: r.selector,
      minWidth: expect.stringMatching(/^([0-9]|[1-3][0-9])$/),
    })
    expect(r.body).not.toMatch(/(^|;)\s*width:\s*\d{3,}px/)
  }
})

test('reduced motion: nothing moves, and the fades of the presses go', () => {
  expect(section).not.toMatch(/(^|[;{\s])transform\s*:/)
  expect(section).not.toMatch(/animation\s*:/)
  const fading = rules.filter(r => /transition\s*:\s*(?!none)/.test(r.body)).map(r => r.selector)
  expect(fading.length).toBeGreaterThan(0)
  const off = /([^{}]+)\{\s*transition:\s*none;\s*\}/g
  const stopped = [...reduced.matchAll(off)].flatMap(m => (m[1] as string).split(',').map(s => s.trim()))
  for (const s of fading) expect(stopped).toContain(s)
  // the swipe's list stays where it is
  expect(reduced).toMatch(/\.time-days\s*\{[^}]*transform:\s*none\s*!important/)
})
