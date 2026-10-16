import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inline, looksLikePath, markdown } from '../web/markdown.js'

test('paths in the chat: links, code and running text become candidates; the rest stays text', () => {
  assert.match(inline('[notes](herdr-reveal:C:/Work/My%20Notes/a.md)'), /^<a class="fs" data-path="herdr-reveal:C:\/Work\/My%20Notes\/a\.md">notes<\/a>$/)
  assert.match(inline('see `src/server.mjs:42`'), /<code class="fs-cand" data-path="src\/server\.mjs:42">src\/server\.mjs:42<\/code>/)
  assert.match(inline('saved to C:\\Work\\out\\report_v2.csv.'), /<span class="fs-cand" data-path="C:\\Work\\out\\report_v2\.csv">C:\\Work\\out\\report_v2\.csv<\/span>\.$/)
  assert.match(inline('logs in /var/log/app/today.log'), /data-path="\/var\/log\/app\/today\.log"/)
  assert.match(inline('`~/notes/todo.md`'), /data-path="~\/notes\/todo\.md"/)
  // Not paths: commands, versions, fractions, words with a slash, web links.
  for (const text of ['`npm test`', '`v1.2.3`', '1/2 done', 'and/or', '`foo.bar()`', '`src/**/*.js`']) assert.ok(!/data-path/.test(inline(text)), text)
  assert.match(inline('see https://example.com/a/b and [docs](https://x.dev)'), /<a class="ext" href="https:\/\/example\.com\/a\/b"[^>]*>https:\/\/example\.com\/a\/b<\/a> and <a class="ext" href="https:\/\/x\.dev"/)
  assert.ok(!/fs-cand/.test(inline('see https://example.com/a/b')))
  // Emphasis rules leave paths alone; quotes cannot break out of the attribute.
  assert.match(inline('C:\\a_b\\c_d_e.txt and _this_'), /data-path="C:\\a_b\\c_d_e\.txt">C:\\a_b\\c_d_e\.txt<\/span> and <i>this<\/i>/)
  assert.ok(!/data-path="[^"]*"[^>]*onmouseover/.test(inline('`C:/x" onmouseover="alert(1)`')))
  assert.match(markdown('- see `README.md`'), /<li>see <code class="fs-cand" data-path="README\.md">/)
  // The chat keeps an agent's line breaks; a document in the quick look reads as Markdown does.
  assert.equal(markdown('one\ntwo'), '<p>one<br>two</p>')
  assert.equal(markdown('one\ntwo\n\n- a\n  b', { soft: true }), '<p>one two</p><ul><li>a b</li></ul>')
  assert.ok(looksLikePath('\\\\server\\share\\x.txt') && looksLikePath('file:///C:/x.txt') && !looksLikePath('https://x.dev/a'))
})
