// The cards' polish over upstream's sheets (web/styles/cards.css, #94): every name starts at the
// same place, and a phone keeps no hover behind after a tap.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sheet = (name: string) => readFileSync(join(import.meta.dir, '..', '..', 'web', 'styles', name), 'utf8')
const px = (css: string, rule: RegExp, prop: string): number => {
  const body = rule.exec(css)?.[1] ?? ''
  return Number(new RegExp(String.raw`(?:^|[;\s])${prop}:\s*([\d.]+)px`).exec(body)?.[1])
}

test('the dot of an awake card takes the moon’s width, so names line up across the column', () => {
  const app = sheet('app.css')
  const moon = px(app, /^\.moon \{([^}]*)\}/m, 'width')
  const dot = px(app, /^\.dot \{([^}]*)\}/m, 'width')
  const margin = px(sheet('cards.css'), /^\.card-top > \.dot \{([^}]*)\}/m, 'margin-inline')
  expect([moon, dot]).toEqual([13, 8])
  expect(dot + 2 * margin).toBe(moon)
})

test('a narrow card leaves its head to the name: the clock a bare glyph, tighter gaps, the wait in two lines (#114)', () => {
  const css = sheet('cards.css')
  expect(css).toContain('.card { container: card / inline-size; }')
  const narrow = /@container card \(max-width: 250px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  expect(narrow).toContain('.card-top { gap: 6px; }')
  expect(narrow).toContain('.card-top .alarm { padding: 0; background: none; }')
  expect(narrow).toContain('.card-top .alarm > span { display: none; }')
  expect(narrow).toMatch(/\.card \.chip span \{[^}]*-webkit-line-clamp: 2;[^}]*white-space: normal;/)
  // Only inside the query: a wider card keeps upstream's head as it was.
  expect(px(sheet('app.css'), /^\.card-top \{([^}]*)\}/m, 'gap')).toBe(8)
})

test('on a screen without hover a tap leaves the age, the clock and no hover buttons; cards flash no square highlight', () => {
  const css = sheet('cards.css')
  const touch = /@media \(hover: none\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  expect(touch).toContain('.card:hover:not(:focus-visible) .card-actions { opacity: 0;')
  expect(touch).toContain('.card:hover .age, .card:hover .alarm { opacity: 1; }')
  expect(css).toContain('.card { -webkit-tap-highlight-color: transparent; }')
  expect(sheet('../index.html')).toContain('<link rel="stylesheet" href="styles/cards.css">')
})
