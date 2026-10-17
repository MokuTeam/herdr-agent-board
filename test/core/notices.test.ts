// Turns that reach a session as a prompt but were not typed by a person (src/core/notices.ts),
// and how the conversation and the card's "replied" see them (src/core/transcript.ts).
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { useLanguage } from '../../src/core/lang.ts'
import { isNotice, reminderNotice, type TaskNotice, taskNotice } from '../../src/core/notices.ts'
import { promptOf, type ScheduleEntry } from '../../src/core/schedule-rules.ts'
import { type NoticeTurn, parseConversation, parseTranscriptTail } from '../../src/core/transcript.ts'
import { notification } from '../support/task-notification.ts'

// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

/** A task notice the test knows is one. */
function task(text: string): TaskNotice {
  const n = taskNotice(text)
  assert.ok(n, `not a task notice: ${text}`)
  return n
}

test('task notifications: what reported back, how it ended, its name, report and output file', () => {
  assert.deepEqual(
    taskNotice(notification('Background command "Wait for the second change event" completed (exit code 0)')),
    {
      kind: 'command',
      status: 'completed',
      name: 'Wait for the second change event',
      exit: 0,
      summary: 'Background command "Wait for the second change event" completed (exit code 0)',
      note: '',
      detail: '',
      file: 'C:\\Temp\\tasks\\b5wcamkuh.output',
      id: 'b5wcamkuh',
    },
  )
  const failed = task(notification('Background command "Run the tests" failed with exit code 1', { status: 'failed' }))
  assert.equal(failed.status, 'failed')
  assert.equal(failed.exit, 1)
  const agent = task(
    notification('Agent "Review the diff" finished', {
      tail: '<note>A task-notification is not the user.</note>\n<result>## Verdict\nShip it.</result>\n<usage><tool_uses>3</tool_uses></usage>',
    }),
  )
  assert.equal(agent.kind, 'agent')
  assert.equal(agent.name, 'Review the diff')
  assert.equal(agent.detail, '## Verdict\nShip it.')
  const monitor = task(
    notification('Monitor event: "new lines in the log"', {
      status: null,
      file: null,
      tail: '<event>[18:51] line one\n[18:52] line two</event>',
    }),
  )
  assert.equal(monitor.kind, 'monitor')
  assert.equal(monitor.status, 'event')
  assert.equal(monitor.detail, '[18:51] line one\n[18:52] line two')
  assert.equal(monitor.file, '')
  assert.equal(
    task(notification('MCP task ktvcasbNx (telegram/ask) failed.', { status: 'failed' })).name,
    'telegram/ask',
  )
  assert.equal(task(notification('Dynamic workflow "review-changes" completed')).kind, 'workflow')
  assert.equal(
    task(
      notification('2 background agents didn\'t finish before the previous session ended: "A" (a1), "B" (b2)', {
        status: 'stopped',
      }),
    ).kind,
    'agent',
  )
  const unnamed = task(
    notification("Background shell command didn't finish before the previous session ended", { status: 'stopped' }),
  )
  assert.equal(unnamed.kind, 'command')
  assert.equal(unnamed.name, '')
  assert.equal(task(notification('Something new "X" happened')).kind, 'task')
  // What the summary adds beyond the usual ending, and names with quotes of their own.
  const broke = task(
    notification('Agent "Log in" failed: Agent terminated early due to an API error', { status: 'failed' }),
  )
  assert.deepEqual([broke.name, broke.note], ['Log in', 'Agent terminated early due to an API error'])
  assert.equal(
    task(notification('Agent "Fix the "foo" bug" stopped at its 200-turn limit (partial result)')).note,
    'stopped at its 200-turn limit (partial result)',
  )
  assert.equal(task(notification('Agent "Fix the "foo" bug" finished')).name, 'Fix the "foo" bug')
  assert.equal(task(notification('Monitor "tail" stream ended')).note, '')
  assert.equal(
    task(
      notification('2 background agents didn\'t finish before the previous session ended: "A" (a1), "B" (b2)', {
        status: 'stopped',
      }),
    ).name,
    '',
  )
  assert.equal(
    task(
      notification('No completion record was found for background agent "Scan" from the previous session.', {
        status: 'stopped',
      }),
    ).kind,
    'agent',
  )
  // Claude Code escapes <, > and & inside the tags.
  const escaped = task(
    notification('Background command "cd x &amp;&amp; npm test 2&gt;&amp;1" completed (exit code 0)', {
      tail: '<result>Use `board remind --session &lt;other&gt;`, not &amp;lt;b&amp;gt;.</result>',
    }),
  )
  assert.equal(escaped.name, 'cd x && npm test 2>&1')
  assert.equal(escaped.detail, 'Use `board remind --session <other>`, not &lt;b&gt;.')
  // Not one, or one that says nothing.
  assert.equal(taskNotice('please check <task-notification> handling'), null)
  assert.equal(taskNotice('<task-notification>done</task-notification>'), null)
  assert.equal(taskNotice(''), null)
})

test('board reminders: the text, who set it, the schedule and the notes, as the scheduler writes them', () => {
  const now = Date.parse('2026-10-16T10:00:00Z')
  const base: ScheduleEntry = { id: '1', key: 'k1', text: 'check the CI run', next: now }
  assert.deepEqual(reminderNotice(promptOf(base, now)), {
    kind: 'reminder',
    status: 'event',
    name: 'check the CI run',
    from: '',
    cron: '',
    note: '',
  })
  const late = reminderNotice(promptOf({ ...base, next: now - 3 * 3600_000, from: { key: 'k2', name: 'Master' } }, now))
  assert.equal(late?.from, 'Master')
  assert.match(late?.note ?? '', /late/)
  const every = reminderNotice(
    promptOf({ ...base, id: '42', cron: '0 9 * * 1-5', from: { key: 'k2', name: 'Master' } }, now),
  )
  assert.deepEqual(
    [every?.kind, every?.from, every?.cron, every?.name],
    ['schedule', 'Master', '0 9 * * 1-5', 'check the CI run'],
  )
  assert.equal(reminderNotice(promptOf({ ...base, id: '7', cron: '*/30 * * * *' }, now))?.cron, '*/30 * * * *')
  // Names with brackets or ": " of their own.
  const bracketed = reminderNotice('[board reminder from Master [prod]] check CI')
  assert.deepEqual([bracketed?.name, bracketed?.from], ['check CI', 'Master [prod]'])
  const named = reminderNotice(
    promptOf({ ...base, id: '4', cron: '0 9 * * *', from: { key: 'k2', name: 'Centium: Alafair' } }, now),
  )
  assert.deepEqual([named?.from, named?.cron], ['Centium: Alafair', '0 9 * * *'])
  assert.equal(reminderNotice('remind me about [board reminder] later'), null)
  assert.ok(isNotice('  [board reminder] x'))
  assert.ok(isNotice(notification('Agent "A" finished')))
  assert.ok(!isNotice('ok, go ahead'))
})

const line = (o: unknown) => JSON.stringify(o)
const notices = (turns: ReturnType<typeof parseConversation>): NoticeTurn[] =>
  turns.filter((c): c is NoticeTurn => c.role === 'notice')

test('the conversation shows notices apart from what the user typed; they are not the user answering', () => {
  const finished = notification('Background command "Wait for the event" completed (exit code 0)', { id: 'bq1' })
  const lines = [
    line({ type: 'user', message: { content: 'watch the job' }, timestamp: '2026-10-16T14:00:00Z' }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Watching.' }] } }),
    // Done while the session worked: queued into the turn, then sent again as a turn of its own.
    line({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: finished,
        commandMode: 'task-notification',
        timestamp: '2026-10-16T14:01:00Z',
      },
    }),
    line({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: { content: finished },
      timestamp: '2026-10-16T14:01:01Z',
    }),
    line({
      type: 'user',
      message: { content: '[board reminder from Master] check the job again' },
      timestamp: '2026-10-16T14:30:00Z',
    }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'The job is done. Restore the rest?' }] } }),
    line({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: {
        content: notification('Agent "Check the restore" finished', {
          id: 'a2',
          tail: '<result>All **restored**.</result>',
        }),
      },
    }),
  ]
  const conv = parseConversation(lines)
  assert.deepEqual(
    conv.map(c => c.role),
    ['user', 'assistant', 'notice', 'notice', 'assistant', 'notice'],
  )
  const [first, reminder, report] = notices(conv)
  assert.equal(first?.name, 'Wait for the event')
  assert.equal(first?.at, Date.parse('2026-10-16T14:01:00Z'))
  assert.deepEqual(
    [reminder?.kind, reminder && 'from' in reminder ? reminder.from : '', reminder?.name],
    ['reminder', 'Master', 'check the job again'],
  )
  assert.equal(report && 'detail' in report ? report.detail : '', 'All **restored**.')
  // The agent's question still waits for the user: the agent reporting back did not answer it.
  const info = parseTranscriptTail(lines)
  assert.equal(info.question, 'The job is done. Restore the rest?')
  assert.equal(info.replied, false)
})

test('a task that reports again under the same id shows every report; an hourly reminder every time', () => {
  const said = (text: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  const from = (content: string) => line({ type: 'user', origin: { kind: 'task-notification' }, message: { content } })
  const event = (text: string) =>
    notification('Monitor event: "log"', { id: 'm1', status: null, file: null, tail: `<event>${text}</event>` })
  const report = (text: string) =>
    notification('Agent "Log in" finished', { id: 'a1', tail: `<result>${text}</result>` })
  const reminder = line({ type: 'user', message: { content: '[board reminder] check the queue' } })
  const lines = [
    from(event('line one')),
    said('Noted.'),
    from(event('line two')),
    said('Noted.'),
    from(report('LOGIN failure')),
    said('Retrying.'),
    from(report('LOGIN ok')),
    reminder,
    said('Empty.'),
    reminder,
  ]
  assert.deepEqual(
    notices(parseConversation(lines)).map(n => ('detail' in n && n.detail) || n.name),
    ['line one', 'line two', 'LOGIN failure', 'LOGIN ok', 'check the queue', 'check the queue'],
  )
})
