import { beforeAll, test } from 'bun:test'
import assert from 'node:assert/strict'
import { backgroundTasks, describe, headInfo, helperStatus, type TailEnd, tailInfo } from '../../src/core/helpers.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { parseConversation } from '../../src/core/transcript.ts'
import { jsonl, line, T0 } from '../support/helper-fixtures.ts'

beforeAll(() => useLanguage('en'))

test('the start of a helper transcript: when it started and its task, skipping what is not one', () => {
  const head = headInfo(
    jsonl([
      { type: 'fork-context-ref', agentId: 'a1' },
      line.call(0, 'parent-call', 'Agent', { subagent_type: 'fork' }),
      line.user(1, [
        { type: 'tool_result', tool_use_id: 'parent-call', content: 'Fork started' },
        { type: 'text', text: '<fork-boilerplate>x</fork-boilerplate>\nYour directive: Count the files.' },
      ]),
    ]),
  )
  assert.equal(head.startedAt, T0)
  assert.equal(head.prompt, 'Count the files.')
})

test('the end of a helper transcript: its last words, the call that runs, how it stopped', () => {
  const said = tailInfo(
    jsonl([
      line.user(0, 'Go.'),
      line.call(1, 't1', 'Read', { file_path: 'C:/x/notes.md' }),
      line.result(2, 't1', 'ok'),
      line.said(3, 'All fine.'),
      line.blob(4),
    ]),
  )
  assert.equal(said.last, 'end')
  assert.equal(said.result, 'All fine.')
  assert.equal(said.tokens, 2 + 1000 + 20000 + 300) // as Claude Code counts a subagent's tokens
  assert.equal(said.endedAt, T0 + 3000)
  assert.equal(said.now, null)

  const busy = tailInfo(
    jsonl([line.user(0, 'Go.'), line.call(1, 't1', 'Bash', { command: 'npm test', description: 'Run the tests' })]),
  )
  assert.equal(busy.last, 'tool')
  assert.deepEqual(busy.now, { name: 'Bash', label: 'Bash', detail: 'Run the tests' })

  const thinking = tailInfo(jsonl([line.call(1, 't1', 'Grep', { pattern: 'x' }), line.result(2, 't1', 'none')]))
  assert.equal(thinking.last, 'waiting')
  assert.equal(thinking.after, 'Grep')

  assert.equal(
    tailInfo(
      jsonl([
        line.call(1, 't1', 'Bash', {}),
        line.result(2, 't1', 'x'),
        line.user(3, '[Request interrupted by user for tool use]'),
      ]),
    ).last,
    'interrupted',
  )
  const error = line.said(5, 'API Error', 'stop_sequence')
  ;(error.message as Record<string, unknown>).model = '<synthetic>'
  assert.equal(tailInfo(jsonl([line.user(0, 'Go.'), error])).last, 'error')
  // A workflow agent ends by handing back its structured output.
  assert.equal(
    tailInfo(jsonl([line.call(1, 's1', 'StructuredOutput', { a: 1 }), line.result(2, 's1', 'ok')])).last,
    'end',
  )
})

test('a helper whose turn ended with a background command still out is not done', () => {
  const started = line.result(
    2,
    'b1',
    'Command running in background with ID: bg42. Output is being written to: C:\\Temp\\bg42.output',
  )
  const text = jsonl([
    line.call(1, 'b1', 'Bash', { command: 'sleep 60', run_in_background: true }),
    started,
    line.said(3, 'Waiting for the sleep.'),
  ])
  assert.equal(backgroundTasks(text), 1)
  assert.deepEqual([tailInfo(text).last, tailInfo(text).waiting], ['background', 1])
  // The same words in a file it read are no background command.
  const read = jsonl([
    line.call(1, 'r1', 'Read', { file_path: 'test.mjs' }),
    line.result(2, 'r1', "assert(x, 'Command running in background with ID: bg42')"),
    line.said(3, 'Read it.'),
  ])
  assert.deepEqual([backgroundTasks(read), tailInfo(read).last], [0, 'end'])
  // One it stopped itself never reports back: no longer out.
  const stopped =
    text +
    jsonl([
      line.call(4, 'ts', 'TaskStop', { task_id: 'bg42' }),
      line.result(5, 'ts', 'Stopped'),
      line.said(6, 'Stopped the wait.'),
    ])
  assert.deepEqual([backgroundTasks(stopped), tailInfo(stopped).last], [0, 'end'])
  // In a helper's transcript the notification is a meta line, a banner before its tag.
  const banner = line.user(
    4,
    '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n\n<task-notification>\n<task-id>bg42</task-id>\n<status>completed</status>\n<summary>Background command "sleep" completed (exit code 0)</summary>\n</task-notification>',
    { isMeta: true, origin: { kind: 'task-notification' } },
  )
  const woke = text + jsonl([banner, line.said(5, 'ok')])
  assert.deepEqual([backgroundTasks(woke), tailInfo(woke).last], [0, 'end'])
  // ...and the helper's conversation shows it as a notice.
  const own = jsonl([line.user(0, 'Wait.')]) + woke
  assert.deepEqual(
    parseConversation(own.trim().split('\n'), 40, { sidechain: true }).flatMap(m =>
      m.role === 'notice' ? [[m.kind, 'id' in m ? m.id : '']] : [],
    ),
    [['command', 'bg42']],
  )
  // Its notification came back: done once it has said its last word.
  const back =
    text +
    jsonl([
      line.user(4, '<task-notification>\n<task-id>bg42</task-id>\n<status>completed</status>\n</task-notification>'),
      line.said(5, 'ok'),
    ])
  assert.equal(tailInfo(back).last, 'end')
})

test('how a helper stands: at work only while its session runs and wrote to it', () => {
  const s = (last: TailEnd, more: Partial<Parameters<typeof helperStatus>[0]> = {}) =>
    helperStatus({ tail: { last }, kind: 'agent', alive: true, since: 1000, mtimeMs: 5000, now: 6000, ...more })
  assert.equal(s('tool'), 'running')
  assert.equal(s('waiting'), 'running')
  assert.equal(s('end'), 'done')
  assert.equal(s('end', { kind: 'teammate' }), 'idle') // a teammate waits for its next message
  assert.equal(s('end', { kind: 'teammate', alive: false }), 'done')
  assert.equal(s('interrupted'), 'stopped')
  assert.equal(s('error'), 'failed')
  assert.equal(s('tool', { meta: { stoppedByUser: true } }), 'stopped')
  assert.equal(s('tool', { meta: { finished: true } }), 'done')
  // The session slept or restarted: what the old process left half done does not run.
  assert.equal(s('tool', { alive: false }), 'stopped')
  assert.equal(s('tool', { since: 9000 }), 'stopped')
  assert.equal(s('background'), 'running')
  assert.equal(s('background', { meta: { finished: true } }), 'running')
  assert.equal(s('background', { now: 5000 + 3_600_001 }), 'done') // the notification went elsewhere
  assert.equal(s('tool', { now: 5000 + 6 * 3_600_001 }), 'stopped') // hung for six hours
})

test('what a helper is, from its meta file', () => {
  assert.deepEqual(
    describe('a1', {
      agentType: 'code-reviewer',
      description: 'Review the diff',
      toolUseId: 'toolu_1',
      requestShape: 'background',
      model: 'inherit',
    }),
    {
      id: 'a1',
      kind: 'agent',
      type: 'code-reviewer',
      name: '',
      description: 'Review the diff',
      color: '',
      model: '',
      background: true,
      parent: null,
      toolUseId: 'toolu_1',
      workflow: null,
      phase: '',
    },
  )
  assert.equal(describe('a2', { agentType: 'fork', isFork: true, name: 'audit-a' }).kind, 'fork')
  const mate = describe('amate-1', {
    agentType: 'design-check',
    name: 'design-check',
    taskKind: 'in_process_teammate',
    color: 'blue',
    customAgentType: 'code-reviewer',
    spawnedAgentType: 'general-purpose',
  })
  assert.deepEqual([mate.kind, mate.type, mate.name, mate.color], ['teammate', 'code-reviewer', 'design-check', 'blue'])
  assert.equal(describe('a3', { color: 'url(x)' }).color, '') // only a plain color name reaches the page
  const wf = describe(
    'a4',
    { agentType: 'workflow-subagent', description: 'audit:home', workflowPhase: 'Audit' },
    { run: 'wf_1' },
  )
  assert.deepEqual([wf.kind, wf.type, wf.workflow, wf.phase], ['workflow', '', 'wf_1', 'Audit'])
  assert.equal(describe('a5', { parentAgentId: 'a1', spawnDepth: 2 }).parent, 'a1')
})
