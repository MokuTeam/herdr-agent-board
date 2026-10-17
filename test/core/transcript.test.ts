import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { DEFAULT_PROMPT_FILTERS, telegramEnvelope } from '../../src/core/prompt-filters.ts'
import {
  cleanPrompt,
  parseConversation,
  parseTranscriptTail,
  saidIn,
  toolDetail,
  toolLabel,
  toolPath,
  trailingQuestion,
  userText,
} from '../../src/core/transcript.ts'

test('prompts are cleaned for one line', () => {
  assert.equal(cleanPrompt('[telegram message_id=5 ts=1] hi\nhow is it going'), 'hi how is it going')
  assert.equal(cleanPrompt('❯ ready to test'), 'ready to test')
  assert.equal(cleanPrompt('<command-name>/x</command-name> go'), '/x go')
})

test('telegramEnvelope strips a leading envelope only', () => {
  assert.equal(telegramEnvelope('[Telegram message_id=5 ts=1] hi'), 'hi')
  assert.equal(telegramEnvelope('hi [telegram x] there'), 'hi [telegram x] there')
  assert.deepEqual(DEFAULT_PROMPT_FILTERS, [telegramEnvelope])
})

test('without filters the envelope stays; userText takes the same seam', () => {
  assert.equal(cleanPrompt('[telegram id=1] hi', []), '[telegram id=1] hi')
  assert.equal(userText('[telegram id=1] hi', []), '[telegram id=1] hi')
  assert.equal(userText('[telegram id=1] hi'), 'hi')
  assert.equal(userText([{ type: 'text', text: '<system-reminder>x</system-reminder>go' }]), 'go')
})

test('tool labels and details read like a sentence', () => {
  assert.equal(toolLabel('mcp__plugin_slack_slack__slack_read_channel'), 'slack · read_channel')
  assert.equal(toolLabel('mcp__claude_ai_Gmail__search_threads'), 'Gmail · search_threads')
  assert.equal(toolLabel('Bash'), 'Bash')
  assert.equal(toolDetail('Bash', { command: 'npm test', description: 'Run tests' }), 'Run tests')
  assert.equal(toolDetail('Bash', { command: '\n  git status\nmore' }), 'git status')
  assert.equal(toolDetail('Edit', { file_path: 'C:/Work/x/y/notes.md' }), 'notes.md')
  assert.equal(toolDetail('SendMessage', { to: 'uds:.pipeLOCALcc-msg-1' }), '→ another session')
  assert.equal(toolDetail('mcp__x__y', { query: 'invoice 42' }), 'invoice 42')
  assert.equal(toolPath('Read', { file_path: 'C:/a/b.csv' }), 'C:/a/b.csv')
  assert.equal(toolPath('Bash', { command: 'x' }), '')
})

const line = (o: unknown) => JSON.stringify(o)

test('transcript tail: title, last prompt, last words, pending tool; sidechains ignored', () => {
  const lines = [
    line({ type: 'ai-title', aiTitle: 'Receipt import' }),
    line({ type: 'last-prompt', lastPrompt: '[telegram message_id=1] load the receipts' }),
    line({ type: 'user', message: { content: 'load the receipts' } }),
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Checking the file.' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:/a/checks.csv' } },
        ],
      },
    }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    line({
      type: 'assistant',
      message: {
        model: 'claude-x',
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 3000,
          cache_read_input_tokens: 150000,
          output_tokens: 90,
        },
        content: [
          { type: 'text', text: 'The file is fine, asking.' },
          {
            type: 'tool_use',
            id: 't2',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Import 10/23?' }] },
          },
        ],
      },
    }),
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
    // Sent while it worked: absorbed into the turn, kept as a queued command.
    line({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: 'also the 10/24 file',
        commandMode: 'prompt',
        origin: { kind: 'human' },
        timestamp: '2026-10-15T21:50:13.839Z',
      },
    }),
    line({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: '<cross-session-message from="x">hi</cross-session-message>',
        commandMode: 'prompt',
        origin: { kind: 'peer' },
      },
    }),
    line({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: '<task-notification>done</task-notification>',
        commandMode: 'task-notification',
      },
    }),
  ]
  const info = parseTranscriptTail(lines)
  assert.equal(info.title, 'Receipt import')
  assert.equal(info.prompt, 'load the receipts')
  assert.equal(info.lastText, 'The file is fine, asking.')
  assert.equal(info.context, 153012) // what the last request carried, cache included; output not
  // No options: a form the board cannot answer, so no questions for it.
  assert.deepEqual(info.tool, {
    id: 't2',
    name: 'AskUserQuestion',
    label: 'AskUserQuestion',
    detail: 'Import 10/23?',
    pending: true,
    questions: null,
  })

  const conv = parseConversation(lines)
  assert.deepEqual(
    conv.map(c => c.role),
    ['user', 'assistant', 'tool', 'assistant', 'tool', 'user'],
  )
  const [, , read, , ask, queued] = conv
  assert.equal(read?.role === 'tool' && read.done, true)
  assert.equal(ask?.role === 'tool' && ask.done, false)
  assert.equal(queued?.role === 'user' && queued.text, 'also the 10/24 file')
  assert.equal(queued?.at, Date.parse('2026-10-15T21:50:13.839Z'))
  assert.ok(!conv.some(c => (c.role === 'user' || c.role === 'assistant') && c.text === 'subagent noise'))
  assert.equal(parseConversation(lines, 2).length, 2)
})

test('updates kept as thinking (thinkingDisplay "updates") are said like any message; other thinking is not', () => {
  const lines = [
    line({ type: 'user', message: { content: 'is the sandbox free? then merge' } }),
    // As Claude Code 2.1.296+ writes them: an empty thinking block, then the update in one of its own.
    line({
      type: 'assistant',
      thinkingDisplay: 'updates',
      message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }] },
    }),
    line({
      type: 'assistant',
      thinkingDisplay: 'updates',
      message: {
        content: [
          {
            type: 'thinking',
            thinking: 'The sandbox is free again. Starting with the first merge.\n\n',
            signature: 'x',
          },
        ],
      },
    }),
    line({
      type: 'assistant',
      thinkingDisplay: 'updates',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh pr merge 1' } }] },
    }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    // Older versions: thinking the terminal keeps folded away.
    line({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'private reasoning', signature: 'x' }] },
    }),
  ]
  const conv = parseConversation(lines)
  assert.deepEqual(
    conv.map(c => c.role),
    ['user', 'assistant', 'tool'],
  )
  const said = conv[1]
  assert.equal(said?.role === 'assistant' && said.text, 'The sandbox is free again. Starting with the first merge.')
  assert.equal(parseTranscriptTail(lines).lastText, 'The sandbox is free again. Starting with the first merge.')
  assert.equal(saidIn({ thinkingDisplay: 'updates' }, { type: 'text', text: ' hi ' }), 'hi')
  assert.equal(saidIn({}, { type: 'thinking', thinking: 'hidden' }), '')
})

test('a message ending in a question: its last sentence or two, markup ignored', () => {
  assert.equal(trailingQuestion('The draft is ready. Send it?'), 'The draft is ready. Send it?')
  assert.equal(trailingQuestion('Done.\n\n**OK or edit?**'), 'OK or edit?')
  assert.equal(trailingQuestion('Done. Nothing needed.'), '')
  assert.equal(trailingQuestion('Code:\n```js\nif (a?) b\n```\nThat is all.'), '')
  assert.equal(trailingQuestion('Options:\n1. A\n2. B\n\nWhich one?'), 'Which one?')
  assert.equal(trailingQuestion('Готово. Отправлять?'), 'Готово. Отправлять?') // any script
})
