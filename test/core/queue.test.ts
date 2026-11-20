// The user's messages in Claude Code's queue, read from the transcript (upstream's
// test/queue.test.mjs at b5a96b8, its queuedPrompts part).
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { type QueueWindow, queuedPrompts } from '../../src/core/queue.ts'
import {
  absorbed,
  busy,
  call,
  jsonl,
  type Line,
  q,
  result,
  said,
  system,
  T0,
  ts,
  user,
} from '../support/queue-fixtures.ts'

const queued = (lines: Line[], opts?: QueueWindow) => queuedPrompts(jsonl(lines), opts).map(m => m.text)

test('a message sent while the session works waits in its queue until the turn takes it', () => {
  const sent = q(10, 'enqueue', 'also check the logs')
  assert.deepEqual(queuedPrompts(jsonl([...busy, sent])), [{ text: 'also check the logs', at: T0 + 10_000 }])
  // The turn is over: it comes next as a user line of its own.
  assert.deepEqual(
    queued([
      ...busy,
      sent,
      result(60, 'b1'),
      said(61, 'done'),
      q(61, 'dequeue'),
      system(61, 'turn_duration'),
      user(61, 'also check the logs'),
    ]),
    [],
  )
  // Taken into the running turn: removed, and kept as a queued command (the thread shows that one).
  assert.deepEqual(
    queued([
      ...busy,
      sent,
      q(30, 'remove', 'also check the logs', { reason: 'absorbed_mid_turn' }),
      absorbed(30, 'also check the logs', 10),
    ]),
    [],
  )
  // Pulled back into the input box (the up arrow): gone from the thread.
  assert.deepEqual(queued([...busy, sent, q(12, 'popAll', 'also check the logs')]), [])
  // Only the dequeue so far: its user line comes a moment later, it still waits.
  assert.deepEqual(queued([...busy, sent, q(60, 'dequeue')]), ['also check the logs'])
})

// Code Mode (#424): background code's result goes through the queue as an <event nonce=…> envelope
// and reaches Claude as a tool result (the Poll tool), never as a user line.
const event = (n: number, kind = 'repl-eval') =>
  `<event nonce="nX${n}" kind="${kind}" at="${ts(n)}" eval="${n}" ms="1683" status="settled">\n<result>${n} files</result>\n</event>`
const polled = (s: number, envelope: string): Line => ({
  type: 'attachment',
  isSidechain: false,
  timestamp: ts(s),
  attachment: { type: 'poll_events', envelopes: [envelope], kinds: ['repl-eval'] },
})

test("Code Mode's background results are not the user's queued messages", () => {
  const real = q(15, 'enqueue', 'also check the logs')
  // Waiting, taken into the running turn (remove) or at its end (dequeue): only the real one shows.
  assert.deepEqual(queued([...busy, q(10, 'enqueue', event(10)), real, q(20, 'enqueue', event(20, 'monitor'))]), [
    'also check the logs',
  ])
  assert.deepEqual(
    queued([...busy, q(10, 'enqueue', event(10)), real, q(11, 'remove', event(10)), polled(11, event(10))]),
    ['also check the logs'],
  )
  const dequeued = [
    ...busy,
    q(10, 'enqueue', event(10)),
    q(10, 'dequeue'),
    polled(10, event(10)),
    result(10, 'p1'),
    real,
  ]
  assert.deepEqual(queued(dequeued), ['also check the logs'])
  // The event's dequeue owes no user line: the real one goes only when its own comes.
  assert.deepEqual(queued([...dequeued, q(60, 'dequeue'), user(60, 'also check the logs')]), [])
  // Nor does a line typed otherwise take the waiting one in its stead.
  assert.deepEqual(queued([...dequeued, user(20, 'typed elsewhere')]), ['also check the logs'])
  const slash = [
    ...busy,
    q(10, 'enqueue', event(10)),
    q(10, 'dequeue'),
    result(10, 'p1'),
    q(15, 'enqueue', '/rename probe'),
    q(16, 'enqueue', 'then this'),
  ]
  assert.deepEqual(queued(slash), ['/rename probe', 'then this'])
  // A typed line that only looks like one (no nonce) is still the user's.
  for (const typed of ['<event kind="x"> is the tag', '<event-log nonce="x"> too'])
    assert.deepEqual(queued([...busy, q(10, 'enqueue', typed)]), [typed])
})

// Claude Code 2.1.329 (#445) queues the envelope without its nonce, and adds that only when it
// hands the event to Claude.
const bare = (n: number, kind = 'repl-eval', body = `<result>${n} files</result>`) =>
  `<event kind="${kind}" at="${ts(n)}" eval="${n}" ms="306" status="settled">\n${body}\n</event>`

test("Code Mode's background results queued without a nonce are not the user's messages either", () => {
  const real = q(15, 'enqueue', 'also check the logs')
  const refused = bare(12, 'repl-eval', '<refused>Bash: denied</refused>\n<result>0</result>')
  const monitor = `<event kind="monitor" at="${ts(20)}" pending="1">\n<line>build ok</line>\n</event>`
  const status = `<event kind="repl-status" at="${ts(21)}" pending="1">\r\nstill running: #3\r\n</event>\r\n`
  // Waiting, then taken into the running turn (remove): only the real one shows.
  const waiting = [...busy, q(10, 'enqueue', bare(10)), q(12, 'enqueue', refused), real, q(20, 'enqueue', monitor)]
  assert.deepEqual(queued([...waiting, q(21, 'enqueue', status)]), ['also check the logs'])
  assert.deepEqual(
    queued([
      ...waiting,
      q(22, 'remove', bare(10)),
      polled(22, bare(10)),
      q(23, 'remove', refused),
      q(24, 'remove', monitor),
    ]),
    ['also check the logs'],
  )
  // At the turn's end (dequeue): it is the one taken, and owes no user line.
  const dequeued = [...busy, q(10, 'enqueue', bare(10)), q(10, 'dequeue'), result(10, 'p1'), real]
  assert.deepEqual(queued(dequeued), ['also check the logs'])
  assert.deepEqual(queued([...dequeued, user(20, 'typed elsewhere')]), ['also check the logs'])
  assert.deepEqual(queued([...dequeued, q(60, 'dequeue'), user(60, 'also check the logs')]), [])
  // The old form with its nonce is still left out.
  assert.deepEqual(queued([...busy, q(10, 'enqueue', event(10)), real]), ['also check the logs'])
})

test("a typed message that quotes or mimics an event tag is still the user's", () => {
  for (const typed of [
    'why does <event kind="x"> show up here?',
    'the chat shows <event kind="repl-eval" at="2026-11-20T06:58:27.985Z"> as mine',
    `<event kind="repl-eval" at="${ts(10)}"> came in, what is it?`,
    '<event kind="repl-eval" at="yesterday">\n</event>',
    `<event at="${ts(10)}">\nno kind\n</event>`,
    `<event-log kind="x" at="${ts(10)}">\n</event>`,
  ])
    assert.deepEqual(queued([...busy, q(10, 'enqueue', typed)]), [typed])
})

test('a dequeue takes the one its user line names, whatever else waits', () => {
  const lines = [
    ...busy,
    q(10, 'enqueue', 'first'),
    q(11, 'enqueue', 'second'),
    q(60, 'dequeue'),
    q(60, 'dequeue'),
    user(60, 'first'),
  ]
  assert.deepEqual(queued(lines), ['second'])
  assert.deepEqual(queued([...lines, user(60, 'second')]), [])
  // Esc on the turn: the queued message goes as the next prompt, after Claude Code's own marker.
  const esc = [
    ...busy,
    q(10, 'enqueue', 'one'),
    q(12, 'dequeue'),
    user(12, [{ type: 'text', text: '[Request interrupted by user for tool use]' }], { origin: undefined }),
  ]
  assert.deepEqual(queued(esc), ['one'])
  assert.deepEqual(queued([...esc, user(12, 'one')]), [])
  // A queued slash command comes back written otherwise: the oldest one went.
  const slash = [
    ...busy,
    q(10, 'enqueue', '/rename probe'),
    q(11, 'enqueue', 'then this'),
    q(60, 'dequeue'),
    user(
      60,
      '<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args>probe</command-args>',
    ),
  ]
  assert.deepEqual(queued(slash), ['then this'])
})

test('pasted text, images and two messages typed in a row come as one queued entry', () => {
  const content =
    '[Image #1]\n\n<pasted_content id="7952">\nFirst line\nSecond line\nFiles:\n</pasted_content id="7952">\n\nplain one'
  const lines = [...busy, q(10, 'enqueue', content)]
  // Shown as the thread shows it: the pasted text without its tags.
  assert.deepEqual(queued(lines), ['[Image #1]\n\nFirst line\nSecond line\nFiles:\n\nplain one'])
  // Absorbed with its image: the attachment holds the text and the image as blocks.
  const blocks = [
    { type: 'text', text: content },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ]
  assert.deepEqual(
    queued([...lines, q(30, 'remove', content, { reason: 'absorbed_mid_turn' }), absorbed(30, blocks, 10)]),
    [],
  )
  assert.deepEqual(queued([...lines, q(60, 'dequeue'), user(60, blocks)]), [])
})

test("task notifications, other sessions, reminders and scheduled prompts are not the user's queue", () => {
  const lines = [
    ...busy,
    q(
      2,
      'enqueue',
      '<task-notification>\n<task-id>b9</task-id>\n<status>completed</status>\n<summary>Background command "tests" completed (exit code 0)</summary>\n</task-notification>',
    ),
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
  const cron = [
    call(0, 'c1', 'CronCreate', { cron: '*/10 * * * *', prompt: 'Monitor cycle.' }),
    result(0, 'c1'),
    user(1, 'Wake-up check.', { isMeta: true, origin: undefined }),
    ...busy,
    q(10, 'enqueue', 'Monitor cycle.'),
    q(11, 'enqueue', 'Wake-up check.'),
  ]
  assert.deepEqual(queued(cron), [])
  // "Background agent … was stopped by the user" is queued as the agents are killed.
  assert.deepEqual(
    queued([
      ...busy,
      q(10, 'enqueue', 'Background agent "Review" was stopped by the user.'),
      { ...system(10, 'agents_killed') },
    ]),
    [],
  )
})

test('a queue goes with its Claude process and is empty whenever Claude said its turn was over', () => {
  const lines = [...busy, q(10, 'enqueue', 'left behind'), q(70, 'enqueue', 'new one')]
  assert.deepEqual(queued(lines, { since: T0 + 60_000 }), ['new one'])
  assert.deepEqual(queued(lines, { idleSince: T0 + 60_000 }), ['new one'])
})

test('lines it cannot read and a sidechain are passed over; a long message comes clipped', () => {
  const long = 'word '.repeat(700).trim()
  const text = `not json\n${JSON.stringify(q(10, 'enqueue', 'side', { isSidechain: true }))}\n${jsonl([...busy, q(11, 'enqueue', long)])}`
  const [only] = queuedPrompts(text)
  assert.equal(only?.text, `${long.slice(0, 2999)}…`)
  assert.deepEqual(queuedPrompts(undefined), [])
})
