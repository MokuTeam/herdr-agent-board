// The Terminal style's sheet (web/styles/look-terminal.css, #161) changes nothing on a Classic page:
// every rule it has, inside @media and @container too, applies only under <html data-look="terminal">,
// it declares nothing global (no @keyframes, @font-face, @property, @import, ...), no other sheet
// reads data-look, and it is linked last, so its variables win the ties with the other sheets'.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rulesOf } from './support/stylesheets.ts'

const WEB = join(import.meta.dir, '..', '..', 'web')
const SHEET = 'look-terminal.css'
const css = readFileSync(join(WEB, 'styles', SHEET), 'utf8')
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

describe('the Terminal style styles nothing on a Classic page', () => {
  const rules = rulesOf(SHEET, css)

  test('every rule is under :root[data-look="terminal"], those in @media and @container too', () => {
    // A broken reader would find nothing and pass everything.
    expect(rules.length).toBeGreaterThan(300)
    expect(rules.some(r => r.selector.includes('.col-label'))).toBe(true) // in @container page
    expect(rules.some(r => r.selector.includes('.toast.with-action'))).toBe(true) // in @media
    const loose = rules.map(r => r.selector).filter(s => !firstCompound(s).startsWith(':root[data-look="terminal"]'))
    expect(loose).toEqual([])
    // The first compound only narrows <html> further (a theme, a doubled test for weight).
    const heads = new Set(rules.map(r => firstCompound(r.selector)))
    expect([...heads].sort()).toEqual([
      ':root[data-look="terminal"]',
      ':root[data-look="terminal"]:not([data-theme="light"])',
      ':root[data-look="terminal"][data-look="terminal"]',
      ':root[data-look="terminal"][data-theme="dark"]',
    ])
  })

  test('it declares nothing global: only @media and @container group its rules', () => {
    const atRules = new Set([...bare.matchAll(/@([\w-]+)/g)].map(m => m[1]))
    expect([...atRules].sort()).toEqual(['container', 'media'])
  })

  test('no other sheet reads data-look, and this one is linked last', () => {
    const others = readdirSync(join(WEB, 'styles')).filter(f => f.endsWith('.css') && f !== SHEET)
    expect(others.length).toBeGreaterThan(15)
    for (const sheet of others)
      expect([sheet, readFileSync(join(WEB, 'styles', sheet), 'utf8').includes('data-look')]).toEqual([sheet, false])
    const linked = [...readFileSync(join(WEB, 'index.html'), 'utf8').matchAll(/href="styles\/([\w-]+\.css)"/g)].map(
      m => m[1],
    )
    expect(linked.at(-1)).toBe(SHEET)
    expect(linked.filter(s => s === SHEET)).toHaveLength(1)
  })
})
