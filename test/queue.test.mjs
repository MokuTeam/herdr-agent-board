import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sandbox, until } from './fixtures/sandbox.mjs'
import { queuedPrompts, sessionThread } from '../src/claude.mjs'
import { holds, messageKey, newestAt, sentKey, unsettled } from '../web/outbox.js'

// Transcript lines as Claude Code 2.1 writes them (shapes copied from real transcripts, texts invented).
const T0 = Date.parse('2026-10-19T14:54:00.000Z')
const ts = s => new Date(T0 + s * 1000).toISOString()
const q = (s, operation, content, more = {}) => ({ type: 'queue-operation', operation, timestamp: ts(s), sessionId: 's1', ...(content === undefined ? {} : { content }), ...more })
const user = (s, content, more = {}) => ({ type: 'user', isSidechain: false, timestamp: ts(s), message: { role: 'user', content }, origin: { kind: 'human' }, ...more })
const said = (s, text) => ({ type: 'assistant', isSidechain: false, timestamp: ts(s), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const call = (s, id, name, input) => ({ type: 'assistant', isSidechain: false, timestamp: ts(s), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const result = (s, id) => ({ type: 'user', isSidechain: false, timestamp: ts(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const absorbed = (s, prompt, from) => ({ type: 'attachment', isSidechain: false, timestamp: ts(s), attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' }, timestamp: ts(from) } })
const system = (s, subtype) => ({ type: 'system', isSidechain: false, subtype, timestamp: ts(s) })
const jsonl = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n'
const queued = (lines, opts) => queuedPrompts(jsonl(lines), opts).map(m => m.text)

const busy = [user(0, 'busy 60'), call(1, 'b1', 'Bash', { command: 'node -e "setTimeout(()=>{},60000)"' })]

test('a message sent while the session works waits in its queue until the turn takes it', () => {
  const sent = q(10, 'enqueue', 'also check the logs')
  assert.deepEqual(queuedPrompts(jsonl([...busy, sent])), [{ text: 'also check the logs', at: T0 + 10_000 }])
  // The turn is over: it comes next as a user line of its own.
  assert.deepEqual(queued([...busy, sent, result(60, 'b1'), said(61, 'done'), q(61, 'dequeue'), system(61, 'turn_duration'), user(61, 'also check the logs')]), [])
  // Taken into the running turn: removed, and kept as a queued command (the thread shows that one).
  assert.deepEqual(queued([...busy, sent, q(30, 'remove', 'also check the logs', { reason: 'absorbed_mid_turn' }), absorbed(30, 'also check the logs', 10)]), [])
  // Pulled back into the input box (the up arrow): gone from the thread.
  assert.deepEqual(queued([...busy, sent, q(12, 'popAll', 'also check the logs')]), [])
  // Only the dequeue so far: its user line comes a moment later, it still waits.
  assert.deepEqual(queued([...busy, sent, q(60, 'dequeue')]), ['also check the logs'])
})

test('a dequeue takes the one its user line names, whatever else waits', () => {
  const lines = [...busy, q(10, 'enqueue', 'first'), q(11, 'enqueue', 'second'), q(60, 'dequeue'), q(60, 'dequeue'), user(60, 'first')]
  assert.deepEqual(queued(lines), ['second'])
  assert.deepEqual(queued([...lines, user(60, 'second')]), [])
  // Esc on the turn: the queued message goes as the next prompt, after Claude Code's own marker.
  const esc = [...busy, q(10, 'enqueue', 'one'), q(12, 'dequeue'), user(12, [{ type: 'text', text: '[Request interrupted by user for tool use]' }], { origin: undefined })]
  assert.deepEqual(queued(esc), ['one'])
  assert.deepEqual(queued([...esc, user(12, 'one')]), [])
  // A queued slash command comes back written otherwise: the oldest one went.
  const slash = [...busy, q(10, 'enqueue', '/rename probe'), q(11, 'enqueue', 'then this'), q(60, 'dequeue'), user(60, '<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args>probe</command-args>')]
  assert.deepEqual(queued(slash), ['then this'])
})

test('pasted text, images and two messages typed in a row come as one queued entry', () => {
  const content = '[Image #1]\n\n<pasted_content id="7952">\nFirst line\nSecond line\nFiles:\n</pasted_content id="7952">\n\nplain one'
  const lines = [...busy, q(10, 'enqueue', content)]
  assert.deepEqual(queued(lines), [content])
  // Absorbed with its image: the attachment holds the text and the image as blocks.
  const blocks = [{ type: 'text', text: content }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]
  assert.deepEqual(queued([...lines, q(30, 'remove', content, { reason: 'absorbed_mid_turn' }), absorbed(30, blocks, 10)]), [])
  assert.deepEqual(queued([...lines, q(60, 'dequeue'), user(60, blocks)]), [])
})

test('task notifications, other sessions, reminders and scheduled prompts are not the user\'s queue', () => {
  const lines = [
    ...busy,
    q(2, 'enqueue', '<task-notification>\n<task-id>b9</task-id>\n<status>completed</status>\n<summary>Background command "tests" completed (exit code 0)</summary>\n</task-notification>'),
    q(3, 'enqueue', '<cross-session-message from="uds:\\\\.\\pipe\\LOCAL\\cc-msg-1">How far?</cross-session-message>'),
    q(4, 'enqueue', '<agent-message from="a6b6">hand-back</agent-message>'),
    q(5, 'enqueue', '<channel source="telegram" message_id="327">Are you there?</channel>'),
    q(6, 'enqueue', '[Cross-session delivery notice] Your message to another session was held by that session.'),
    q(7, 'enqueue', '[board reminder] check the CI run'),
    q(8, 'enqueue', '[telegram message_id=404]\nfrom the phone'),
    q(9, 'enqueue', '<system-reminder>only a reminder</system-reminder>'),
  ]
  // A message from Telegram is the user's own; the rest have a line of their own, or none.
  assert.deepEqual(queued(lines), ['from the phone'])
  // A CronCreate prompt that fires while the turn runs, and one that fired before (a meta line).
  const cron = [call(0, 'c1', 'CronCreate', { cron: '*/10 * * * *', prompt: 'Monitor cycle.' }), result(0, 'c1'), user(1, 'Wake-up check.', { isMeta: true, origin: undefined }), ...busy, q(10, 'enqueue', 'Monitor cycle.'), q(11, 'enqueue', 'Wake-up check.')]
  assert.deepEqual(queued(cron), [])
  // "Background agent … was stopped by the user" is queued as the agents are killed.
  assert.deepEqual(queued([...busy, q(10, 'enqueue', 'Background agent "Review" was stopped by the user.'), { ...system(10, 'agents_killed') }]), [])
})

test('a queue goes with its Claude process and is empty whenever Claude said its turn was over', () => {
  const lines = [...busy, q(10, 'enqueue', 'left behind'), q(70, 'enqueue', 'new one')]
  assert.deepEqual(queued(lines, { since: T0 + 60_000 }), ['new one'])
  assert.deepEqual(queued(lines, { idleSince: T0 + 60_000 }), ['new one'])
})

test('the thread and the queue come from one read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-queue-'))
  const file = join(dir, 's1.jsonl')
  writeFileSync(file, jsonl([...busy, q(10, 'enqueue', 'later please')]))
  const { conversation, queued: waiting } = sessionThread(file, 40)
  assert.deepEqual(conversation.map(m => m.role), ['user', 'tool'])
  assert.deepEqual(waiting.map(m => m.text), ['later please'])
  assert.deepEqual(sessionThread(join(dir, 'none.jsonl')), { conversation: [], queued: [] })
})

test('the board\'s message is found in what the transcript shows', () => {
  // Claude Code's paste wrapper, image marks, paths (sometimes changed on the way), blank lines.
  assert.equal(messageKey('[Image #1]\n\n<pasted_content id="7952">\nFirst  line\n\nSecond\nFiles:\nC:\\w\\pluginsgent-board\\a.txt\n</pasted_content id="7952">'), 'First line Second Files:')
  const key = sentKey('First line\n\nSecond', 'Files:')
  assert.equal(key, 'First line Second')
  assert.ok(holds('[Image #1]\n\n<pasted_content id="7952">\nFirst line\nSecond\nFiles:\n</pasted_content id="7952">\n\nplain one', key))
  assert.ok(holds('[Image #1]\n\n<pasted_content id="7952">\nFirst line\nSecond\nFiles:\n</pasted_content id="7952">\n\nplain one', sentKey('plain one', 'Files:')))
  assert.ok(!holds('First line Secondary', key)) // words, not letters
  assert.ok(!holds('anything', ''))
  // Only files: the line that names them.
  assert.equal(sentKey('', 'Files:'), 'Files:')
  assert.ok(holds('[Image #2]\nFiles:', sentKey('', 'Files:')))
  // A long message comes clipped.
  const long = 'word '.repeat(700).trim()
  assert.ok(holds(`${long.slice(0, 2999)}…`, sentKey(long, 'Files:')))
})

test('the board\'s bubble stays until the transcript shows the message after it was sent', () => {
  const entry = (id, text, state = 'sending', more = {}) => ({ id, text, key: sentKey(text, 'Files:'), after: T0 + 5_000, state, sentAt: 0, ...more })
  const list = [entry('a', 'ok'), entry('b', 'second thing', 'sent', { sentAt: 1000 }), entry('c', 'broken', 'failed')]
  // An older "ok" is not this one.
  assert.deepEqual(unsettled(list, { conversation: [{ role: 'user', text: 'ok', at: T0 }] }, 2000).map(e => e.id), ['a', 'b', 'c'])
  // In the queue now, or a user line already (an idle session takes it at once).
  assert.deepEqual(unsettled(list, { queued: [{ text: 'ok', at: T0 + 6_000 }], conversation: [{ role: 'user', text: 'second thing', at: T0 + 7_000 }] }, 2000).map(e => e.id), ['c'])
  // An assistant's words are not the message.
  assert.deepEqual(unsettled(list, { conversation: [{ role: 'assistant', text: 'ok', at: T0 + 6_000 }] }, 2000).map(e => e.id), ['a', 'b', 'c'])
  // Sent, but never seen in the transcript: it goes after a while; a failed one stays.
  assert.deepEqual(unsettled(list, {}, 40_000).map(e => e.id), ['a', 'c'])
  assert.equal(newestAt({ conversation: [{ at: 5 }, { at: 9 }], queued: [{ at: 7 }] }), 9)
  assert.equal(newestAt(null), 0)
})

async function unusedPort() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('the sheet\'s data carries the queue of a running Claude only', { timeout: 20_000 }, async t => {
  const box = sandbox(t)
  const claude = join(box.env.HOME, '.claude')
  const project = join(claude, 'projects', 'C--w-case')
  mkdirSync(project, { recursive: true })
  mkdirSync(join(claude, 'sessions'), { recursive: true })
  const lines = jsonl([...busy, q(10, 'enqueue', 'also the logs')])
  for (const id of ['s1', 's2', 's3']) writeFileSync(join(project, `${id}.jsonl`), lines)
  // s1 works; s2 said it was idle after the message came (the queue is gone with it); s3 has no Claude process.
  writeFileSync(join(claude, 'sessions', 'a.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', kind: 'interactive', startedAt: T0, status: 'busy', statusUpdatedAt: T0 }))
  writeFileSync(join(claude, 'sessions', 'b.json'), JSON.stringify({ pid: process.pid, sessionId: 's2', kind: 'interactive', startedAt: T0, status: 'idle', statusUpdatedAt: T0 + 30_000 }))
  const panes = ['s1', 's2', 's3'].map((id, i) => ({ pane_id: `p${i}`, agent: 'claude', agent_session: { value: id }, agent_status: 'working', cwd: 'C:\\w\\case' }))
  box.state({ 'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } } })
  const port = await unusedPort()
  const proc = box.run('server', { port, categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, refreshSec: 3600 })
  await until(() => proc.messages.some(m => m.ready))
  const detail = async key => (await fetch(`http://127.0.0.1:${port}/api/session/${key}`, { signal: AbortSignal.timeout(5000) })).json()
  for (const deadline = Date.now() + 8000; (await (await fetch(`http://127.0.0.1:${port}/api/board`)).json()).items.length < 3; ) {
    if (Date.now() > deadline) throw new Error('No board with the three sessions')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.deepEqual((await detail('s1')).queued, [{ text: 'also the logs', at: T0 + 10_000 }])
  assert.deepEqual((await detail('s2')).queued, [])
  assert.deepEqual((await detail('s3')).queued, [])
})
