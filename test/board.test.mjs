import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brief, waitReminder } from '../src/brief.mjs'
import { t, useLanguage } from '../src/core/lang.ts'
import { markdown } from '../web/markdown.js'

// The board's texts follow the system language by default: the tests pin English.
useLanguage('en')

const cfg = {
  categories: [
    { id: 'acme', title: 'Acme', paths: ['C:\\Clients'] },
    { id: 'beta', title: 'Beta', paths: ['C:\\Beta'] },
    { id: 'globex', title: 'Globex', paths: ['C:\\Clients\\Globex'] },
    { id: 'personal', title: 'Personal', paths: ['C:\\Home'] },
    { id: 'other', title: 'Other', paths: [] },
  ],
}

test('brief names the guessed lane and the known ids; reminder quotes the wait', () => {
  const text = brief(cfg, null, 'C:\\Clients\\Globex')
  assert.match(text, /Now: globex \(guessed/)
  assert.match(text, /acme \(Acme\), beta \(Beta\)/)
  assert.match(text, /Card texts in English/)
  assert.match(brief(cfg, { category: 'beta', wait: 'CI' }, 'C:\\X'), /Now: beta\..*Card now: waiting "CI"/s)
  assert.match(brief(cfg, null, 'C:\\X'), /not set, set it now/)
  assert.match(waitReminder({ wait: 'client reply' }), /"client reply"/)
})

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

test('the board switches language in place: the brief follows', () => {
  try {
    useLanguage('ru')
    assert.match(brief(cfg, null, 'C:\\X'), /Card texts in Russian/)
    assert.equal(t('lane.other'), 'Прочее')
  } finally {
    useLanguage('en')
  }
})
