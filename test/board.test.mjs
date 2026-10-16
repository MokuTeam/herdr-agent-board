import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brief, waitReminder } from '../src/brief.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanPrompt, conversation, toolDetail, toolLabel, trailingQuestion, transcriptInfo } from '../src/claude.mjs'
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

test('prompts are cleaned for one line', () => {
  assert.equal(cleanPrompt('[telegram message_id=5 ts=1] hi\nhow is it going'), 'hi how is it going')
  assert.equal(cleanPrompt('❯ ready to test'), 'ready to test')
  assert.equal(cleanPrompt('<command-name>/x</command-name> go'), '/x go')
})

test('brief names the guessed lane and the known ids; reminder quotes the wait', () => {
  const text = brief(cfg, null, 'C:\\Clients\\Globex')
  assert.match(text, /Now: globex \(guessed/)
  assert.match(text, /acme \(Acme\), beta \(Beta\)/)
  assert.match(text, /Card texts in English/)
  assert.match(brief(cfg, { category: 'beta', wait: 'CI' }, 'C:\\X'), /Now: beta\..*Card now: waiting "CI"/s)
  assert.match(brief(cfg, null, 'C:\\X'), /not set, set it now/)
  assert.match(waitReminder({ wait: 'client reply' }), /"client reply"/)
})

test('tool labels and details read like a sentence', () => {
  assert.equal(toolLabel('mcp__plugin_slack_slack__slack_read_channel'), 'slack · read_channel')
  assert.equal(toolLabel('mcp__claude_ai_Gmail__search_threads'), 'Gmail · search_threads')
  assert.equal(toolLabel('Bash'), 'Bash')
  assert.equal(toolDetail('Bash', { command: 'npm test', description: 'Run tests' }), 'Run tests')
  assert.equal(toolDetail('Bash', { command: '\n  git status\nmore' }), 'git status')
  assert.equal(toolDetail('Edit', { file_path: 'C:/Work/x/y/notes.md' }), 'notes.md')
  assert.equal(toolDetail('SendMessage', { to: 'uds:\\.\pipe\LOCAL\cc-msg-1' }), '→ another session')
  assert.equal(toolDetail('mcp__x__y', { query: 'invoice 42' }), 'invoice 42')
})

test('transcript tail: title, last prompt, last words, pending tool; sidechains ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-'))
  const file = join(dir, 's.jsonl')
  const line = o => JSON.stringify(o)
  writeFileSync(
    file,
    [
      line({ type: 'ai-title', aiTitle: 'Receipt import' }),
      line({ type: 'last-prompt', lastPrompt: '[telegram message_id=1] load the receipts' }),
      line({ type: 'user', message: { content: 'load the receipts' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking the file.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:/a/checks.csv' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      line({ type: 'assistant', message: { model: 'claude-x', usage: { input_tokens: 12, cache_creation_input_tokens: 3000, cache_read_input_tokens: 150000, output_tokens: 90 }, content: [{ type: 'text', text: 'The file is fine, asking.' }, { type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: { questions: [{ question: 'Import 10/23?' }] } }] } }),
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
      // Sent while it worked: absorbed into the turn, kept as a queued command.
      line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'also the 10/24 file', commandMode: 'prompt', origin: { kind: 'human' }, timestamp: '2026-10-15T21:50:13.839Z' } }),
      line({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<cross-session-message from="x">hi</cross-session-message>', commandMode: 'prompt', origin: { kind: 'peer' } } }),
      line({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>', commandMode: 'task-notification' } }),
    ].join('\n'),
  )
  const info = transcriptInfo(file)
  assert.equal(info.title, 'Receipt import')
  assert.equal(info.prompt, 'load the receipts')
  assert.equal(info.lastText, 'The file is fine, asking.')
  assert.equal(info.context, 153012) // what the last request carried, cache included; output not
  // No options: a form the board cannot answer, so no questions for it.
  assert.deepEqual(info.tool, { id: 't2', name: 'AskUserQuestion', label: 'AskUserQuestion', detail: 'Import 10/23?', pending: true, questions: null })

  const conv = conversation(file)
  assert.deepEqual(conv.map(c => c.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'user'])
  assert.equal(conv[2].done, true)
  assert.equal(conv[4].done, false)
  assert.equal(conv[5].text, 'also the 10/24 file')
  assert.equal(conv[5].at, Date.parse('2026-10-15T21:50:13.839Z'))
  assert.ok(!conv.some(c => c.text === 'subagent noise'))
})

test('a message ending in a question: its last sentence or two, markup ignored', () => {
  assert.equal(trailingQuestion('The draft is ready. Send it?'), 'The draft is ready. Send it?')
  assert.equal(trailingQuestion('Done.\n\n**OK or edit?**'), 'OK or edit?')
  assert.equal(trailingQuestion('Done. Nothing needed.'), '')
  assert.equal(trailingQuestion('Code:\n```js\nif (a?) b\n```\nThat is all.'), '')
  assert.equal(trailingQuestion('Options:\n1. A\n2. B\n\nWhich one?'), 'Which one?')
  assert.equal(trailingQuestion('Готово. Отправлять?'), 'Готово. Отправлять?') // any script
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
