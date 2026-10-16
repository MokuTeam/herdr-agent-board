// The parity helper itself: what it treats as the same markup, and what not.
import { expect, test } from 'bun:test'
import { canonical, parseHtml } from './support/markup.ts'

const same = (a: string, b: string) => expect(canonical(parseHtml(a))).toBe(canonical(parseHtml(b)))
const differ = (a: string, b: string) => expect(canonical(parseHtml(a))).not.toBe(canonical(parseHtml(b)))

test('attribute order, class order, style spacing, indentation and entities do not matter', () => {
  same('<p id="x" class="b a">Hi</p>', '<p class="a b" id="x">Hi</p>')
  same('<span style="--c: var(--green); "></span>', '<span style="--c:var(--green)"></span>')
  same('<div>\n  <b>1</b>\n</div>', '<div><b>1</b></div>')
  same('<p title="it&#x27;s">a &amp; b</p>', `<p title="it's">a &amp; b</p>`)
  same('<svg><path d="M1"/></svg>', '<svg><path d="M1"></path></svg>')
  same('<input disabled>', '<input disabled="">')
  same('<p>a<!-- -->b</p>', '<p>ab</p>')
})

test('tags, attributes, values and text do', () => {
  differ('<p>Hi</p>', '<div>Hi</div>')
  differ('<p id="x">Hi</p>', '<p>Hi</p>')
  differ('<p class="a">Hi</p>', '<p class="a b">Hi</p>')
  differ('<p class="">Hi</p>', '<p>Hi</p>')
  differ('<p><b>1</b> sessions</p>', '<p><b>1</b>sessions</p>')
  differ('<button hidden></button>', '<button></button>')
  differ('<div><span></span><b></b></div>', '<div><b></b><span></span></div>')
})

test('void elements close themselves; a whole page parses', () => {
  const nodes = parseHtml(
    '<!doctype html><html><head><meta charset="utf-8"><link rel="icon"></head><body><input id="a"><p>x</p></body></html>',
  )
  expect(canonical(nodes)).toBe(
    [
      '<html>',
      '  <head>',
      '    <meta charset="utf-8">',
      '    <link rel="icon">',
      '  </head>',
      '  <body>',
      '    <input id="a">',
      '    <p>x</p>',
      '  </body>',
      '</html>',
    ].join('\n'),
  )
})
