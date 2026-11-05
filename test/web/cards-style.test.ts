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

// The name wins the head (#324; web/src/models/card-head.ts, hooks/useHeadFit.ts).
const rule = (css: string, selector: string): string => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    if ((m[1] ?? '').split(',').some(s => s.trim() === selector)) return (m[2] ?? '').trim()
  return ''
}

test('in a card’s head nothing beside the name is cut: the profile tag and the state word keep their width (#324)', () => {
  const css = sheet('cards.css')
  // Upstream's profile tag shrinks to "D…" (max-width 45%, 60% when wrong) and the state word ends
  // at 92px; on a card neither shrinks, so only the name can, and the steps decide what gives way.
  expect(rule(sheet('profiles.css'), '.profile-tag')).toContain('flex: 0 1 auto;')
  expect(rule(css, '.card .card-top > .profile-tag')).toBe('flex: none; max-width: none;')
  expect(rule(css, '.card .card-top > .card-status')).toBe('max-width: none;')
  // Three classes: it outranks `.profile-tag.wrong` (two), whichever sheet comes later.
  expect(rule(sheet('profiles.css'), '.profile-tag.wrong')).toContain('max-width: 60%;')
})

test('each step gives way as the model says: the state word unseen but read, the profile its mark, the clock its glyph (#324)', () => {
  const css = sheet('cards.css')
  const status = rule(css, '.card-top[data-give~="status"] > .card-status')
  expect(status).toContain('position: absolute;')
  expect(status).toContain('clip-path: inset(50%);')
  expect(status).not.toContain('display: none')
  // The profile's words, out of sight the same way (not font-size 0, which some screen readers drop).
  const words = rule(css, '.card-top[data-give~="profile"] > .profile-tag > .tag-text')
  expect(words).toContain('position: absolute;')
  expect(words).toContain('clip-path: inset(50%);')
  expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('font-size: 0')
  expect(rule(css, '.card-top[data-give~="profile"] > .profile-tag::before')).toContain(
    'content: attr(data-mark) / "";',
  )
  expect(rule(css, '.card-top[data-give~="alarm"] > .alarm > span')).toBe('display: none;')
  // In the Terminal style the mark is in its brackets, "[D]", a wrong one "[!]" rather than "![!]":
  // these outrank the style's own tag rules (more classes and attributes).
  const terminal = sheet('look-terminal.css')
  expect(
    rule(terminal, ':root[data-look="terminal"] .card-top[data-give~="profile"] > .profile-tag::before'),
  ).toContain('content: "[" attr(data-mark) / "";')
  expect(rule(terminal, ':root[data-look="terminal"] .profile-tag.wrong::before')).toContain('content: "![";')
})

test('a name cut in the middle keeps its end, and wraps as one text where card text wraps (#324)', () => {
  const css = sheet('cards.css')
  expect(rule(css, '.card-top > .name.split')).toBe('display: flex;')
  expect(rule(css, '.name-head')).toBe('min-width: 0; overflow: hidden; text-overflow: ellipsis;')
  expect(rule(css, '.name-tail')).toContain('flex: none;')
  // The Terminal style's "› " before a selected name keeps its space in the two-part name.
  expect(rule(css, '.card-top > .name.split::before')).toBe('white-space: pre;')
  const wrap = sheet('card-wrap.css')
  expect(rule(wrap, ':root[data-card-text="wrap"] .card .name.split')).toBe('display: block;')
  expect(rule(wrap, ':root[data-card-text="wrap"] .card .name-tail')).toBe('display: inline;')
})
