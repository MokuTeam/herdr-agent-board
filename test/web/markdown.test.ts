import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inline, looksLikePath, markdown } from '../../web/src/models/markdown.ts'
import { oldSource } from './support/old-app.ts'

test('paths in the chat: links, code and running text become candidates; the rest stays text', () => {
  assert.match(
    inline('[notes](herdr-reveal:C:/Work/My%20Notes/a.md)'),
    /^<a class="fs" data-path="herdr-reveal:C:\/Work\/My%20Notes\/a\.md">notes<\/a>$/,
  )
  assert.match(
    inline('see `src/server.mjs:42`'),
    /<code class="fs-cand" data-path="src\/server\.mjs:42">src\/server\.mjs:42<\/code>/,
  )
  assert.match(
    inline('saved to C:\\Work\\out\\report_v2.csv.'),
    /<span class="fs-cand" data-path="C:\\Work\\out\\report_v2\.csv">C:\\Work\\out\\report_v2\.csv<\/span>\.$/,
  )
  assert.match(inline('logs in /var/log/app/today.log'), /data-path="\/var\/log\/app\/today\.log"/)
  assert.match(inline('`~/notes/todo.md`'), /data-path="~\/notes\/todo\.md"/)
  // Not paths: commands, versions, fractions, words with a slash, web links.
  for (const text of ['`npm test`', '`v1.2.3`', '1/2 done', 'and/or', '`foo.bar()`', '`src/**/*.js`'])
    assert.ok(!/data-path/.test(inline(text)), text)
  assert.match(
    inline('see https://example.com/a/b and [docs](https://x.dev)'),
    /<a class="ext" href="https:\/\/example\.com\/a\/b"[^>]*>https:\/\/example\.com\/a\/b<\/a> and <a class="ext" href="https:\/\/x\.dev"/,
  )
  assert.ok(!/fs-cand/.test(inline('see https://example.com/a/b')))
  // Emphasis rules leave paths alone; quotes cannot break out of the attribute.
  assert.match(
    inline('C:\\a_b\\c_d_e.txt and _this_'),
    /data-path="C:\\a_b\\c_d_e\.txt">C:\\a_b\\c_d_e\.txt<\/span> and <i>this<\/i>/,
  )
  assert.ok(!/data-path="[^"]*"[^>]*onmouseover/.test(inline('`C:/x" onmouseover="alert(1)`')))
  assert.match(markdown('- see `README.md`'), /<li>see <code class="fs-cand" data-path="README\.md">/)
  // The chat keeps an agent's line breaks; a document in the quick look reads as Markdown does.
  assert.equal(markdown('one\ntwo'), '<p>one<br>two</p>')
  assert.equal(markdown('one\ntwo\n\n- a\n  b', { soft: true }), '<p>one two</p><ul><li>a b</li></ul>')
  assert.ok(
    looksLikePath('\\\\server\\share\\x.txt') && looksLikePath('file:///C:/x.txt') && !looksLikePath('https://x.dev/a'),
  )
})

test('markdown: blocks and inline markup, nothing executable gets through', () => {
  const html = markdown(
    '## Summary\n\n**Done**, see `x`.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n  - two\n\n```\n<b>x</b>\n```',
  )
  assert.match(html, /<h4>Summary<\/h4>/)
  assert.match(html, /<b>Done<\/b>, see <code>x<\/code>\./)
  assert.match(
    html,
    /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/,
  )
  assert.match(html, /<ul><li>one<ul><li>two<\/li><\/ul><\/li><\/ul>/)
  assert.match(html, /<pre><code>&lt;b&gt;x&lt;\/b&gt;<\/code><\/pre>/)
  const evil = markdown('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://ok.example/p)')
  assert.ok(!/<img|href="javascript/i.test(evil))
  assert.match(evil, /<a class="ext" href="https:\/\/ok\.example\/p" target="_blank" rel="noopener noreferrer">b<\/a>/)
  assert.equal(
    markdown('snake_case_name and the path C:a_bc_d.txt'),
    '<p>snake_case_name and the path C:a_bc_d.txt</p>',
  )
})

// ---------------------------------------------------------------- against the old renderer

type Renderer = {
  markdown: (src: unknown, opts?: { soft?: boolean }) => string
  inline: (text: unknown) => string
  looksLikePath: (text: unknown) => boolean
}

const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function'

/** web/markdown.js as the parity baseline has it (git show 94fdde6:web/markdown.js once it is gone). */
async function oldRenderer(): Promise<Renderer> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-markdown-'))
  try {
    const file = join(dir, 'markdown.js')
    writeFileSync(file, oldSource('web/markdown.js'))
    const mod: Record<string, unknown> = await import(pathToFileURL(file).href)
    const { markdown, inline, looksLikePath } = mod
    if (!isFunction(markdown) || !isFunction(inline) || !isFunction(looksLikePath)) throw new Error('no renderer')
    return {
      markdown: (src, opts) => String(Reflect.apply(markdown, undefined, [src, opts])),
      inline: text => String(Reflect.apply(inline, undefined, [text])),
      looksLikePath: text => Reflect.apply(looksLikePath, undefined, [text]) === true,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const CORPUS = [
  '',
  '   ',
  'plain text',
  '# One\n## Two ##\n###### Six\n####### seven',
  'para one\nline two\n\npara two',
  '- a\n- b\n  - b1\n    - b11\n  - b2\n\n- c',
  '* star\n+ plus\n• bullet',
  '1. one\n2) two\n\n3. three',
  '3. starts at three\n4. four',
  '- item\n  continued\n  more',
  '| left | mid | right |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| a `b` | **c** | [d](https://d.dev) |',
  'a | b\n--|--\nc | d',
  '```js\nconst a = "<x>" && b\n```\nafter',
  '~~~\ntilde fence\n~~~',
  '```\nnever closed',
  '> quoted\n> > nested\n> - list in quote',
  '---\n***\n_ _ _',
  '**bold** __bold__ *it* _it_ ~~gone~~ snake_case_name 2*3*4',
  '[web](https://a.b/c?d=1&e=2) [mail](mailto:x@y.z) [js](javascript:alert(1)) [rel](./docs/a.md) [word](nothing)',
  'bare https://example.com/path?q=1, then (https://x.dev/y). end',
  'C:\\Users\\me\\file.txt and C:/Users/me/other.txt; \\\\server\\share\\doc.pdf',
  '~/notes/todo.md and ~\\win\\path.txt and /usr/local/bin/tool and /etc/hosts',
  'see «/a/b/c.txt» and [/x/y/z.md] and (/q/r)',
  '`C:\\code\\path.ts:12:3` and `npm run build` and `../up/one.js` and `./here.md`',
  '`herdr-reveal:C:/x/y` `file:///tmp/a.txt` `https://not.a/path`',
  '<script>alert(1)</script> & "quotes" \'single\'',
  '"><img src=x onerror=alert(1)> `"><b>`',
  'line one\r\nline two\r\n\r\n- crlf item\r\n',
  'trailing punctuation C:\\a\\b.txt. and /a/b/c.md, and ~/x/y.md!',
  'name.ext README.md package.json:12 a.b.c',
  'paragraph\n# heading right after\n- list right after\n> quote right after',
]

test('the ported renderer writes what the old one wrote, for chat and documents alike', async () => {
  const old = await oldRenderer()
  for (const src of CORPUS) {
    assert.equal(markdown(src), old.markdown(src), JSON.stringify(src))
    assert.equal(markdown(src, { soft: true }), old.markdown(src, { soft: true }), JSON.stringify(src))
    for (const line of src.split(/\r?\n/)) {
      assert.equal(inline(line), old.inline(line), JSON.stringify(line))
      assert.equal(looksLikePath(line), old.looksLikePath(line), JSON.stringify(line))
    }
  }
  assert.equal(markdown(null), old.markdown(null))
  assert.equal(inline(undefined), old.inline(undefined))
})
