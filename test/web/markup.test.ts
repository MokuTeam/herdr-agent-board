// The parity helper itself: what it treats as the same markup, and what not; which attributes the
// old page's alone it drops, and where a stylesheet keeps them; how it reads the stylesheets.
import { expect, test } from 'bun:test'
import { jsxCarriers, templateCarriers } from './support/attribute-carriers.ts'
import { canonical, OLD_PAGE_ONLY, parseHtml, stripAttrs } from './support/markup.ts'
import { attributeReads, parseComplex, rulesOf, selectorsOf } from './support/stylesheets.ts'

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

test('texts split by react-dom/server read as one, also between elements', () => {
  same('<p><b>Ask:</b> <!-- -->Deploy?</p>', '<p><b>Ask:</b> Deploy?</p>')
  differ('<p><b>Ask:</b><!-- -->Deploy?</p>', '<p><b>Ask:</b> Deploy?</p>')
})

test('with `spaces`, a space between two elements counts; without, it is indentation', () => {
  const spaced = (a: string, b: string) => [a, b].map(html => canonical(parseHtml(html), { spaces: true }))
  const [tagged, glued] = spaced('<p><b>Ask:</b> <span>H</span>Q</p>', '<p><b>Ask:</b><span>H</span>Q</p>')
  expect(tagged).not.toBe(glued)
  expect(tagged).toBe(['<p>', '  <b>Ask:</b>', "  ' '", '  <span>H</span>', '  Q', '</p>'].join('\n'))
  same('<p><b>Ask:</b> <span>H</span>Q</p>', '<p><b>Ask:</b><span>H</span>Q</p>')
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

test('the old page’s own attributes go, but not where a stylesheet selects by them', () => {
  // app.css: `.pill-toggle.icon-only > span[data-i18n]` hides the label beside the icon.
  const nodes = parseHtml(
    '<div class="controls"><button class="pill-toggle icon-only" data-i18n-title="tb.catsTitle"><svg></svg><span data-i18n="tb.cats">Categories</span><span class="n" data-sig="1"></span></button>' +
      '<button class="pill-toggle"><span data-i18n="attention.next">Next</span></button><h1 data-i18n="tb.title">Agents</h1></div>',
  )
  stripAttrs(nodes, OLD_PAGE_ONLY)
  expect(canonical(nodes)).toBe(
    [
      '<div class="controls">',
      '  <button class="icon-only pill-toggle">',
      '    <svg></svg>',
      '    <span data-i18n="tb.cats">Categories</span>',
      '    <span class="n"></span>',
      '  </button>',
      '  <button class="pill-toggle">',
      '    <span>Next</span>',
      '  </button>',
      '  <h1>Agents</h1>',
      '</div>',
    ].join('\n'),
  )
})

test('the stylesheets read as selectors: rules in at-rules too, each of a list, the attributes they select by', () => {
  const css = `/* a { b: c } */
    .a[hidden], .b > span[data-x="1"] { color: red }
    @media (max-width: 9px) { :root:not([data-theme="light"]) .c { color: blue } }
    @container tools (max-width: 10px) { .d:has(.e:not([open])) .f { x: y } }
    @keyframes spin { from { a: b } to { a: c } }`
  expect(selectorsOf(css)).toEqual([
    '.a[hidden], .b > span[data-x="1"]',
    ':root:not([data-theme="light"]) .c',
    '.d:has(.e:not([open])) .f',
  ])
  expect(parseComplex('.b > span[data-x="1"]')).toEqual({
    compounds: [
      { tag: null, id: null, classes: ['b'], attrs: [], pseudos: [] },
      { tag: 'span', id: null, classes: [], attrs: [{ name: 'data-x', op: '=', value: '1' }], pseudos: [] },
    ],
    combinators: ['>'],
  })
  const reads = attributeReads(rulesOf('t.css', css)).map(r => [
    r.selector,
    r.attr.name,
    r.compound.classes.join('.') || r.compound.tag || (r.compound.pseudos[0]?.name ?? ''),
  ])
  expect(reads).toEqual([
    ['.a[hidden]', 'hidden', 'a'],
    ['.b > span[data-x="1"]', 'data-x', 'span'],
    [':root:not([data-theme="light"]) .c', 'data-theme', 'root'],
    ['.d:has(.e:not([open])) .f', 'open', 'e'],
  ])
})

test('what code writes on an element: a template’s HTML, choices in it, JSX with its classes and attributes', () => {
  const js = `const x = \`<button class="sched-x\${ask ? ' on' : ''}"\${ask ? ' data-confirm' : ''} data-id="\${id}" \${rest}>\``
  const [button] = templateCarriers('a.js', js)
  expect(button && { ...button, classes: [...button.classes], attrs: [...button.attrs] }).toEqual({
    where: 'a.js:1',
    tag: 'button',
    classes: ['sched-x', 'on'],
    anyClass: false,
    attrs: [
      ['data-confirm', ''],
      ['data-id', null],
    ],
    anyAttr: true,
  })
  const tsx = [
    "const className = classNames('card', busy && 'busy')",
    'return (',
    '  // a comment before it',
    '  <article',
    '    // and inside it',
    '    className={className}',
    '    data-col={item.column}',
    '    hidden',
    '  >',
    '    <Badge className="x" aria-label="y" />',
  ].join('\n')
  const [article, badge] = jsxCarriers('C.tsx', tsx)
  expect(article && [article.where, article.tag, [...article.classes], article.anyClass, [...article.attrs]]).toEqual([
    'C.tsx:4',
    'article',
    ['card', 'busy'],
    false,
    [
      ['data-col', null],
      ['hidden', ''],
    ],
  ])
  expect(badge && [badge.tag, [...badge.classes], [...badge.attrs]]).toEqual([null, ['x'], [['aria-label', 'y']]])
})
