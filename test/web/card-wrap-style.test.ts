// Card text that wraps (web/styles/card-wrap.css, #183) changes nothing while cards are cut short:
// every rule it has applies only under <html data-card-text="wrap">, it declares nothing global, no
// other sheet reads data-card-text, and it reads no style (data-look), so it is the same in the
// Classic and the Terminal style. Where the Terminal style cuts a field to one line, the wrap rule
// outranks it, though look-terminal.css is linked after it. And what it promises: the name whole,
// beside the dot; the other lines up to three; the tool at work left on its one line.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Complex, rulesOf, type StyleRule } from './support/stylesheets.ts'

const WEB = join(import.meta.dir, '..', '..', 'web')
const SHEET = 'card-wrap.css'
const ROOT = ':root[data-card-text="wrap"]'
const sheet = (name: string) => readFileSync(join(WEB, 'styles', name), 'utf8')
const css = sheet(SHEET)
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The first compound of a selector, as written: up to the first combinator outside brackets. */
function firstCompound(selector: string): string {
  let depth = 0
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) return selector.slice(0, i)
  }
  return selector
}

/** A selector's specificity as [ids, classes / attributes / pseudo-classes, types]. */
function specificity(complex: Complex): [number, number, number] {
  const sum: [number, number, number] = [0, 0, 0]
  for (const c of complex.compounds) {
    if (c.id) sum[0]++
    sum[1] += c.classes.length + c.attrs.length
    if (c.tag && c.tag !== '*') sum[2]++
    for (const p of c.pseudos) {
      if (p.name === 'where') continue
      if (!p.args) {
        sum[1]++
        continue
      }
      // :not(), :is() and :has() weigh as their heaviest argument.
      const heaviest = p.args.map(specificity).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0]
      if (heaviest) for (const i of [0, 1, 2] as const) sum[i] += heaviest[i]
    }
  }
  return sum
}

const outranks = (a: [number, number, number], b: [number, number, number]): boolean =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]

/** The declarations of the rule whose selector list holds exactly `selector`. */
function declarations(source: string, selector: string): Record<string, string> {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map(s => s.trim())
    if (!selectors.includes(selector)) continue
    return Object.fromEntries(
      (m[2] ?? '')
        .split(';')
        .map(d => d.trim())
        .filter(Boolean)
        .map(d => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]),
    )
  }
  return {}
}

describe('wrapped card text styles nothing while cards are cut short', () => {
  const rules = rulesOf(SHEET, css)

  test(`every rule is under ${ROOT}, and only that`, () => {
    // A broken reader would find nothing and pass everything.
    expect(rules.length).toBeGreaterThan(15)
    expect(rules.some(r => r.selector.includes('.card-top'))).toBe(true)
    expect([...new Set(rules.map(r => firstCompound(r.selector)))]).toEqual([ROOT])
  })

  test('it declares nothing global and groups nothing: no at-rules at all', () => {
    expect([...bare.matchAll(/@([\w-]+)/g)].map(m => m[1])).toEqual([])
  })

  test('it reads no style, no other sheet reads data-card-text, and it is linked after the cards and before Terminal', () => {
    expect(bare.includes('data-look')).toBe(false)
    expect(bare.includes('data-theme')).toBe(false)
    const others = readdirSync(join(WEB, 'styles')).filter(f => f.endsWith('.css') && f !== SHEET)
    expect(others.length).toBeGreaterThan(15)
    for (const other of others) expect([other, sheet(other).includes('data-card-text')]).toEqual([other, false])
    const linked = [...readFileSync(join(WEB, 'index.html'), 'utf8').matchAll(/href="styles\/([\w-]+\.css)"/g)].map(
      m => m[1],
    )
    expect(linked.filter(s => s === SHEET)).toHaveLength(1)
    expect(linked.indexOf(SHEET)).toBeGreaterThan(linked.indexOf('cards.css'))
    expect(linked.indexOf(SHEET)).toBeLessThan(linked.indexOf('look-terminal.css'))
  })
})

describe('what wrapping does (#183)', () => {
  const rules = rulesOf(SHEET, css)
  const terminal = rulesOf('look-terminal.css', sheet('look-terminal.css'))
  const rule = (selector: string): StyleRule => {
    const found = rules.find(r => r.selector === selector)
    if (!found) throw new Error(`no rule ${selector}`)
    return found
  }

  test('the name wraps whole, breaks long words inside the card, and fits beside the dot or the moon', () => {
    const name = declarations(css, `${ROOT} .card .name`)
    expect(name['white-space']).toBe('normal')
    expect(name['overflow-wrap']).toBe('anywhere')
    // The dot or the moon takes 13px (cards-style.test.ts), the head's gap at most 8px (app.css;
    // 6px narrow, 1ch in the Terminal style): the name fits beside it on its first line.
    expect(name['max-width']).toBe('calc(100% - 21px)')
    const head = declarations(css, `${ROOT} .card .card-top`)
    expect([head['flex-wrap'], head.height]).toEqual(['wrap', 'auto'])
    // The dot and the moon stay by the first line: centered on its 20px (an 8px dot, a 13px moon).
    expect(name['line-height']).toBe('20px')
    expect(declarations(css, `${ROOT} .card-top > .dot`)).toMatchObject({
      'align-self': 'flex-start',
      'margin-top': '6px',
    })
    expect(declarations(css, `${ROOT} .card-top > .moon`)).toMatchObject({
      'align-self': 'flex-start',
      'margin-top': '3.5px',
    })
    // The clock and the age to the right, wherever they land.
    expect(declarations(css, `${ROOT} .card-top > .age`)['margin-inline-start']).toBe('auto')
  })

  test('what it does, asks, waits for and said last: up to three lines; the tool at work stays one line', () => {
    for (const field of ['.what', '.said', '.ask:not(.qa-card)', '.qa-card-q', '.qa-card-opts', '.chip span'])
      expect([field, declarations(css, `${ROOT} .card ${field}`)['-webkit-line-clamp']]).toEqual([field, '3'])
    expect(rules.some(r => /\.now|\.tool|\.detail/.test(r.selector))).toBe(false)
  })

  test('in the Terminal style, the wrap rules outrank the ones that cut a field to one line or fix the head’s height', () => {
    const pairs: [string, string][] = [
      [`${ROOT} .card .card-top`, ':root[data-look="terminal"] .card-top'],
      [`${ROOT} .card .name`, ':root[data-look="terminal"] .name'],
      [`${ROOT} .card .what`, ':root[data-look="terminal"] .what'],
      [`${ROOT} .card .said`, ':root[data-look="terminal"] .said'],
      [`${ROOT} .card .ask:not(.qa-card)`, ':root[data-look="terminal"] .ask'],
      [`${ROOT} .card .qa-card-q`, ':root[data-look="terminal"] .qa-card-q'],
    ]
    for (const [ours, theirs] of pairs) {
      const style = terminal.find(r => r.selector === theirs)
      expect([theirs, !!style]).toEqual([theirs, true])
      if (!style) continue
      expect([ours, outranks(specificity(rule(ours).complex), specificity(style.complex))]).toEqual([ours, true])
    }
    // The Terminal dot is a box of the line's height with no margin: there the style keeps its own
    // margin (the same weight, linked later), and the dot needs none.
    const dot = terminal.find(r => r.selector === ':root[data-look="terminal"] .card-top > .dot')
    expect(dot && specificity(dot.complex)).toEqual(specificity(rule(`${ROOT} .card-top > .dot`).complex))
  })
})
