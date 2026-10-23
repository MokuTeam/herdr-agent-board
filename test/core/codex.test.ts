import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isCodexItem, isCodexSession, parseCodexConversation, parseCodexTail } from '../../src/core/codex.ts'

const row = (type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: '2026-10-20T08:00:00Z', type, payload })
const message = (role: string, text: string, extra = {}) =>
  row('response_item', { type: 'message', role, content: [{ type: 'input_text', text }], ...extra })
const call = (id: string, name = 'exec_command') =>
  row('response_item', { type: 'function_call', call_id: id, name, arguments: '{"cmd":"bun test"}' })
const result = (id: string) => row('response_item', { type: 'function_call_output', call_id: id, output: 'ok' })

test('only Codex panes and UUID session ids select Codex records', () => {
  expect(isCodexItem({ agent: 'codex' })).toBe(true)
  for (const agent of ['claude', 'pi', 'agy', undefined]) expect(isCodexItem({ agent })).toBe(false)
  expect(isCodexSession('01a15a8a-bd97-7701-a7f7-401e4bec3147')).toBe(true)
  for (const id of ['pane-123', '../s', '/s/rollout.jsonl', 's1', '']) expect(isCodexSession(id)).toBe(false)
})

test('card reads prompt, answer, tool completion and input usage without double counting cached input', () => {
  const lines = [
    message('user', 'fix\nthe build'),
    message('assistant', 'Looking.'),
    call('t1'),
    result('t1'),
    message('assistant', 'Fixed it. Shall I push?', { phase: 'final_answer' }),
    row('event_msg', {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 2000, cached_input_tokens: 1800, output_tokens: 100 } },
    }),
  ]
  expect(parseCodexTail(lines)).toMatchObject({
    prompt: 'fix the build',
    lastText: 'Fixed it. Shall I push?',
    question: 'Fixed it. Shall I push?',
    replied: false,
    tool: { id: 't1', name: 'exec_command', detail: 'bun test', pending: false },
    context: 2000,
  })
  expect(parseCodexTail([...lines, message('user', 'yes')])).toMatchObject({ prompt: 'yes', replied: true })
  expect(parseCodexTail([...lines, call('t2')]).tool).toMatchObject({ id: 't2', pending: true })
})

test('thread uses response items once, leaves out reasoning, system context and event copies', () => {
  const lines = [
    row('session_meta', { id: 's1', base_instructions: { text: 'private' } }),
    message('system', 'secret system prompt'),
    message('developer', 'secret developer prompt'),
    message('user', '# AGENTS.md instructions for C:\\Work\\Проект %\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>'),
    message('user', '<environment_context>cwd</environment_context>'),
    message('user', 'also injected', {
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions'] },
    }),
    message('user', 'fix it'),
    row('event_msg', { type: 'user_message', message: 'fix it' }),
    row('event_msg', {
      type: 'item_completed',
      item: { type: 'UserMessage', content: [{ type: 'text', text: 'fix it' }] },
    }),
    row('response_item', { type: 'reasoning', summary: [{ text: 'private thought' }], encrypted_content: 'secret' }),
    message('assistant', 'also private', { channel: 'analysis' }),
    message('assistant', 'Looking.', { phase: 'commentary' }),
    call('t1'),
    result('t1'),
    message('assistant', 'Done.'),
    row('event_msg', { type: 'agent_message', message: 'Done.' }),
    '{"unfinished',
  ]
  expect(
    parseCodexConversation(lines).map(t => [t.role, t.role === 'tool' ? t.detail : 'text' in t ? t.text : '']),
  ).toEqual([
    ['user', 'fix it'],
    ['assistant', 'Looking.'],
    ['tool', 'bun test'],
    ['assistant', 'Done.'],
  ])
  expect(parseCodexConversation(lines, 2).map(t => t.role)).toEqual(['tool', 'assistant'])
  expect(parseCodexConversation(lines)[2]).toMatchObject({ done: true })
})

test('custom tools and notices: output is completion, and a board reminder does not answer a question', () => {
  const lines = [
    message('user', 'fix it'),
    row('response_item', {
      type: 'custom_tool_call',
      call_id: 'c1',
      name: 'apply_patch',
      input: '*** Begin Patch\nmore',
    }),
    row('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' }),
    message('assistant', 'Shall I push?'),
    message('user', '[board reminder] check the build'),
  ]
  expect(parseCodexTail(lines)).toMatchObject({ prompt: 'fix it', replied: false, tool: { pending: false } })
  expect(parseCodexConversation(lines).at(-1)?.role).toBe('notice')
  expect(parseCodexConversation(lines)[1]).toMatchObject({ detail: '*** Begin Patch', done: true })
})

test('unknown message metadata and context combined with a user prompt preserve the prompt', () => {
  const lines = [
    message('user', '<environment_context>cwd</environment_context>\nfix it', {
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['unknown'] },
    }),
  ]
  expect(parseCodexTail(lines).prompt).toBe('fix it')
})

test('recorded injected user-role envelopes do not replace the prompt or answer an open question', () => {
  // Codex 0.142.2, 0.142.5, 0.144.6 and 0.153.4 envelopes; bodies and paths shortened.
  const injected = readFileSync(new URL('../fixtures/codex-injected.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
  expect(injected).toHaveLength(5)
  for (const line of injected) {
    const lines = [message('user', 'fix the build'), message('assistant', 'Shall I push?'), line]
    expect(parseCodexTail(lines)).toMatchObject({ prompt: 'fix the build', question: 'Shall I push?', replied: false })
    expect(parseCodexConversation(lines).map(t => t.role)).toEqual(['user', 'assistant'])
  }
})

test('explicit user.text and mixed classifications preserve real prompts; empty kinds behave like absent kinds', () => {
  for (const kinds of [[], ['user.text'], ['plugins.recommendations', 'user.text'], ['unknown']]) {
    const raw = message('user', 'real request', {
      internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
    })
    expect(parseCodexTail([raw]).prompt).toBe('real request')
  }
  for (const kinds of [['user.text'], ['plugins.recommendations', 'user.text']]) {
    const raw = message('user', '<skill>user supplied content</skill> real request', {
      internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
    })
    expect(parseCodexConversation([raw])[0]).toMatchObject({
      role: 'user',
      text: '<skill>user supplied content</skill> real request',
    })
  }
})

test('the sheet has every message whole; the card keeps its short preview (#174)', () => {
  const prompt = `${'please read this '.repeat(300)}end`
  const answer = `${'here is what I found '.repeat(300)}end`
  const lines = [message('user', prompt), message('assistant', answer)]
  expect(parseCodexConversation(lines).map(t => ('text' in t ? t.text : t.role))).toEqual([prompt, answer])
  expect(parseCodexTail(lines).lastText).toBe(`${answer.slice(0, 699)}…`)
})
