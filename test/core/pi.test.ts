import { expect, test } from 'bun:test'
import {
  isPiItem,
  isPiSessionFile,
  parsePiConversation,
  parsePiTail,
  piSessionId,
  piToolDetail,
  piToolPath,
} from '../../src/core/pi.ts'

// A pi session file as pi writes it: a header, then entries that each name their parent.
const T0 = Date.parse('2026-10-20T08:00:00.000Z')
let clock = 0
let last: string | null = null
type Entry = Record<string, unknown>
function entry(type: string, fields: Entry, parent: string | null | undefined = last, id = `e${++clock}`): string {
  last = id
  const timestamp = new Date(T0 + clock * 1000).toISOString()
  return JSON.stringify({ type, id, parentId: parent ?? null, timestamp, ...fields })
}
const header = (): string => {
  clock = 0
  last = null
  return JSON.stringify({ type: 'session', version: 3, id: '01a1', timestamp: new Date(T0).toISOString(), cwd: '/w' })
}
const user = (text: string, parent?: string | null) =>
  entry('message', { message: { role: 'user', content: [{ type: 'text', text }], timestamp: T0 + clock } }, parent)
const said = (content: unknown[], usage: Entry = {}) =>
  entry('message', {
    message: { role: 'assistant', content, provider: 'claude-bridge-work', model: 'claude-opus-5-5', usage },
  })
const result = (toolCallId: string) =>
  entry('message', {
    message: { role: 'toolResult', toolCallId, toolName: 'bash', content: [{ type: 'text', text: 'ok' }] },
  })
const text = (t: string) => ({ type: 'text', text: t })
const call = (id: string, name: string, args: Entry) => ({ type: 'toolCall', id, name, arguments: args })

test('a pi session key is its file, absolute and .jsonl; the id is in its name', () => {
  const file = '/home/me/.pi/agent/sessions/--home-me--/2026-10-20T05-10-02-695Z_01a157b7-72c7-75a8.jsonl'
  expect(isPiSessionFile(file)).toBe(true)
  expect(isPiSessionFile('C:\\Users\\me\\.pi\\agent\\sessions\\--C--w--\\2026_01a1.jsonl')).toBe(true)
  expect(isPiSessionFile('030bc85e-c173-4999-b250-c85a4d5595bd')).toBe(false)
  expect(isPiSessionFile('pane-w1:p2')).toBe(false)
  expect(isPiSessionFile('sessions/x.jsonl')).toBe(false)
  expect(piSessionId(file)).toBe('01a157b7-72c7-75a8')
  expect(piSessionId('C:\\s\\2026-10-20T05-10-02-695Z_abc.jsonl')).toBe('abc')
  expect(piSessionId('030bc85e-c173-4999-b250-c85a4d5595bd')).toBe('')
  expect(isPiItem({ agent: 'pi', session: file })).toBe(true)
  // Claude's sessions, and a pi pane herdr reports no session file for, are not read as pi's.
  expect(isPiItem({ agent: 'claude', session: file })).toBe(false)
  expect(isPiItem({ agent: 'pi', session: null })).toBe(false)
})

test("what a pi tool call is about: pi's own tools, then the usual fields", () => {
  expect(piToolDetail('bash', { command: '\n  git status\n  git log' })).toBe('git status')
  expect(piToolDetail('edit', { path: '/w/src/a.ts', edits: [] })).toBe('a.ts')
  expect(piToolPath('edit', { path: '/w/src/a.ts' })).toBe('/w/src/a.ts')
  expect(piToolPath('bash', { command: 'ls' })).toBe('')
  expect(piToolDetail('grep', { pattern: 'TODO' })).toBe('TODO')
  expect(piToolDetail('mcp__mempalace__mempalace_search', { query: 'pi board' })).toBe('pi board')
  expect(piToolDetail('bash', null)).toBe('')
})

test('the card: the last prompt, the last words and the question in them, the last tool, the context', () => {
  const lines = [
    header(),
    entry('model_change', { provider: 'claude-bridge-work', modelId: 'claude-opus-5-5' }),
    user('fix the build'),
    said([text('Looking.'), call('t1', 'bash', { command: 'bun test' })], { input: 2, cacheRead: 1000, cacheWrite: 8 }),
    result('t1'),
    said([{ type: 'thinking', thinking: 'hm' }, text('Fixed it. Shall I push?')], {
      input: 3,
      output: 50,
      cacheRead: 2000,
      cacheWrite: 10,
    }),
  ]
  expect(parsePiTail(lines)).toEqual({
    name: '',
    title: '',
    prompt: 'fix the build',
    lastText: 'Fixed it. Shall I push?',
    question: 'Fixed it. Shall I push?',
    replied: false,
    tool: { id: 't1', name: 'bash', label: 'bash', detail: 'bun test', pending: false },
    context: 2013,
  })
  // The user answered: the question is no longer open.
  expect(parsePiTail([...lines, user('yes')])).toMatchObject({ prompt: 'yes', replied: true })
})

test('a tool call without its result yet is pending', () => {
  const lines = [header(), user('go'), said([call('t9', 'read', { path: '/w/README.md' })])]
  expect(parsePiTail(lines).tool).toEqual({ id: 't9', name: 'read', label: 'read', detail: 'README.md', pending: true })
})

test('a board reminder typed into the session is not the user answering it', () => {
  const lines = [header(), user('fix it'), said([text('Shall I push?')]), user('[board reminder] check the CI run')]
  expect(parsePiTail(lines)).toMatchObject({ prompt: 'fix it', question: 'Shall I push?', replied: false })
})

test('the name: the latest /name, an empty one clears it, wherever it is on the branch', () => {
  const named = [header(), user('go'), entry('session_info', { name: 'Fix CI' }), said([text('Done.')])]
  expect(parsePiTail(named).name).toBe('Fix CI')
  expect(parsePiTail([...named, entry('session_info', { name: 'Ship it' })]).name).toBe('Ship it')
  expect(parsePiTail([...named, entry('session_info', {})]).name).toBe('')
  expect(parsePiTail([header(), user('go')]).name).toBe('')
})

test('a branch left behind with /tree is not the session: only the way back from the last entry is', () => {
  const lines = [
    header(),
    user('first', null),
    said([text('Option A, then?')]),
    user('no, the other way'),
    said([text('Doing A.')]),
  ]
  // Back to "first" (e1) with /tree, and on from there.
  last = 'e1'
  lines.push(said([text('Option B it is.')]), user('good'))
  const info = parsePiTail(lines)
  expect(info.prompt).toBe('good')
  expect(info.lastText).toBe('Option B it is.')
  expect(parsePiConversation(lines).map(t => ('text' in t ? t.text : t.role))).toEqual([
    'first',
    'Option B it is.',
    'good',
  ])
})

test('entries written with another key order are read all the same', () => {
  const odd = (fields: Entry) => JSON.stringify({ id: `o${++clock}`, timestamp: '', ...fields })
  const lines = [
    header(),
    odd({ parentId: null, type: 'message', message: { role: 'user', content: 'plain string prompt' } }),
    odd({ parentId: `o${clock}`, type: 'message', message: { role: 'assistant', content: [text('Hi.')] } }),
  ]
  expect(parsePiTail(lines)).toMatchObject({ prompt: 'plain string prompt', lastText: 'Hi.' })
})

test('nothing to read: an empty file, broken lines, a header only', () => {
  expect(parsePiTail([])).toMatchObject({ prompt: '', lastText: '', tool: null })
  expect(parsePiTail([header(), '{not json', ''])).toMatchObject({ prompt: '', lastText: '', tool: null })
  expect(parsePiConversation([header()])).toEqual([])
})

test('the sheet: prompts, words and tool calls in order, a reminder as a notice, thinking left out', () => {
  const lines = [
    header(),
    entry('message', { message: { role: 'system', content: '', sections: { preamble: 'You are…' } } }),
    user('fix the build'),
    said([{ type: 'thinking', thinking: 'secret' }, text('Looking.'), call('t1', 'bash', { command: 'bun test' })]),
    result('t1'),
    said([call('t2', 'edit', { path: '/w/a.ts' })]),
    user('[board reminder] check the CI run'),
  ]
  const turns = parsePiConversation(lines)
  expect(turns.map(t => t.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'notice'])
  expect(turns[0]).toMatchObject({ role: 'user', text: 'fix the build' })
  expect(turns[1]).toMatchObject({ role: 'assistant', text: 'Looking.' })
  expect(turns[2]).toMatchObject({ role: 'tool', label: 'bash', detail: 'bun test', path: '', done: true })
  expect(turns[3]).toMatchObject({ role: 'tool', label: 'edit', detail: 'a.ts', path: '/w/a.ts', done: false })
  expect(turns[4]).toMatchObject({ role: 'notice', kind: 'reminder' })
  // The newest turns when there are more than asked for.
  expect(parsePiConversation(lines, 2).map(t => t.role)).toEqual(['tool', 'notice'])
})
