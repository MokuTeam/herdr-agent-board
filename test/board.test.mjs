import assert from 'node:assert/strict'
import { test } from 'node:test'
import { useLanguage } from '../src/core/lang.ts'
import { markdown } from '../web/markdown.js'

// The board's texts follow the system language by default: the tests pin English.
useLanguage('en')

test('markdown: blocks and inline markup, nothing executable gets through', () => {
  const html = markdown('## Summary\n\n**Done**, see `x`.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n  - two\n\n```\n<b>x</b>\n```')
  assert.match(html, /<h4>Summary<\/h4>/)
  assert.match(html, /<b>Done<\/b>, see <code>x<\/code>\./)
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/)
  assert.match(html, /<ul><li>one<ul><li>two<\/li><\/ul><\/li><\/ul>/)
  assert.match(html, /<pre><code>&lt;b&gt;x&lt;\/b&gt;<\/code><\/pre>/)
  const evil = markdown('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://ok.example/p)')
  assert.ok(!/<img|href="javascript/i.test(evil))
  assert.match(evil, /<a class="ext" href="https:\/\/ok\.example\/p" target="_blank" rel="noopener noreferrer">b<\/a>/)
  assert.equal(markdown('snake_case_name and the path C:\a_b\c_d.txt'), '<p>snake_case_name and the path C:\a_b\c_d.txt</p>')
})
