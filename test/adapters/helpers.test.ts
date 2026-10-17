import { beforeAll, onTestFinished, test } from 'bun:test'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { clearHelperCache, countTools, helperDetail, helpersOf } from '../../src/adapters/helpers.ts'
import { summarize } from '../../src/core/helpers.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { line, sessionDir, T0 } from '../support/helper-fixtures.ts'

beforeAll(() => useLanguage('en'))

function session() {
  const s = sessionDir()
  onTestFinished(() => s.remove())
  clearHelperCache()
  return s
}

test('every helper of a session: subagents, forks, teammates, workflow runs, nested agents', () => {
  const s = session()
  s.helper(
    'adone1',
    { agentType: 'general-purpose', description: 'Find the owner', toolUseId: 'toolu_a', requestShape: 'background' },
    [line.user(0, 'Find the owner of case 1.'), line.said(5, 'It is Dana.')],
  )
  s.helper(
    'afork2',
    {
      agentType: 'fork',
      isFork: true,
      name: 'audit-a',
      description: 'Audit slice a',
      toolUseId: 'toolu_b',
      requestShape: 'background',
    },
    [
      line.call(10, 'toolu_b', 'Agent', { subagent_type: 'fork' }),
      line.user(11, [
        { type: 'tool_result', tool_use_id: 'toolu_b', content: 'Fork started' },
        { type: 'text', text: '<fork-boilerplate>x</fork-boilerplate>\nYour directive: Audit slice a.' },
      ]),
      line.call(12, 'g1', 'Glob', { pattern: '*' }),
    ],
  )
  s.helper(
    'amate-3',
    {
      agentType: 'design-check',
      name: 'design-check',
      taskKind: 'in_process_teammate',
      color: 'green',
      description: 'Check the design',
    },
    [
      line.user(20, '<teammate-message teammate_id="team-lead" summary="Check it">Is it sound?</teammate-message>'),
      line.said(21, 'Sound.'),
    ],
  )
  // A helper that started one of its own: the parent's turn is over, its child still works.
  s.helper('aparent4', { agentType: 'general-purpose', description: 'Nested parent', toolUseId: 'toolu_c' }, [
    line.user(30, 'Start a child.'),
    line.said(31, 'Started; waiting.'),
  ])
  s.helper(
    'achild5',
    {
      agentType: 'general-purpose',
      description: 'Nested child',
      toolUseId: 'toolu_d',
      parentAgentId: 'aparent4',
      spawnDepth: 2,
    },
    [line.user(32, 'Start one more.'), line.said(33, 'Started; waiting.')],
  )
  // ...and a grandchild: whatever order the folder lists them in, the whole line stays at work.
  s.helper(
    'a0grand6',
    { agentType: 'general-purpose', description: 'Nested grandchild', parentAgentId: 'achild5', spawnDepth: 3 },
    [line.user(34, 'Sleep.'), line.call(35, 's1', 'Bash', { command: 'sleep 90' })],
  )
  // A finished workflow run with two agents, and one that runs (its name from its script file).
  s.helper(
    'aw1',
    { agentType: 'workflow-subagent', description: 'audit:home', workflowPhase: 'Audit' },
    [
      line.user(40, '[Workflow harness — computed task] x:\n  Audit home.'),
      line.call(41, 'o1', 'StructuredOutput', {}),
      line.result(42, 'o1', 'ok'),
    ],
    'subagents/workflows/wf_done-1',
  )
  s.write('subagents/workflows/wf_done-1/journal.jsonl', [{ type: 'launched' }])
  s.write('workflows/wf_done-1.json', {
    runId: 'wf_done-1',
    taskId: 'wtask1',
    workflowName: 'polish-audit',
    status: 'completed',
    summary: 'Audit of every screen',
    startTime: T0 + 40000,
    durationMs: 9000,
    totalTokens: 52000,
    totalToolCalls: 7,
    agentCount: 1,
  })
  s.helper(
    'aw2',
    { agentType: 'workflow-subagent', description: 'probe:a', workflowPhase: 'Probe' },
    [line.user(50, 'x'), line.call(51, 'q', 'Bash', { command: 'sleep 40' })],
    'subagents/workflows/wf_live-2',
  )
  s.write('workflows/scripts/probe-parallel-wf_live-2.js', [])

  const live = helpersOf(s.transcript, { alive: true, since: 0 })
  const by = (id: string) => {
    const h = live.helpers.find(x => x.id === id)
    if (!h) throw new Error(`no helper ${id}`)
    return h
  }
  assert.deepEqual(
    live.helpers.map(h => h.id),
    ['aw2', 'aw1', 'a0grand6', 'achild5', 'aparent4', 'amate-3', 'afork2', 'adone1'],
  ) // newest first
  assert.deepEqual(
    [by('adone1').status, by('adone1').result, by('adone1').prompt],
    ['done', 'It is Dana.', 'Find the owner of case 1.'],
  )
  assert.deepEqual(
    [by('afork2').kind, by('afork2').status, by('afork2').prompt, by('afork2').now?.label],
    ['fork', 'running', 'Audit slice a.', 'Glob'],
  )
  assert.deepEqual(
    [by('amate-3').kind, by('amate-3').status, by('amate-3').from, by('amate-3').color],
    ['teammate', 'idle', 'team-lead', 'green'],
  )
  assert.deepEqual([by('aparent4').status, by('aparent4').waiting], ['running', 1])
  assert.equal(by('achild5').parent, 'aparent4')
  assert.deepEqual([by('achild5').status, by('a0grand6').status], ['running', 'running'])
  assert.deepEqual(
    [by('aw1').kind, by('aw1').workflow, by('aw1').status, by('aw1').prompt],
    ['workflow', 'wf_done-1', 'done', 'Audit home.'],
  )
  assert.deepEqual(
    live.workflows.map(w => [w.id, w.name, w.status, w.agents]),
    [
      ['wf_live-2', 'probe-parallel', 'running', 1],
      ['wf_done-1', 'polish-audit', 'done', 1],
    ],
  )
  assert.deepEqual(
    [live.workflows[1]?.tokens, live.workflows[1]?.taskId, live.workflows[1]?.endedAt],
    [52000, 'wtask1', T0 + 49000],
  )

  const card = summarize(live)
  assert.deepEqual([card?.running, card?.total, card?.workflows], [5, 8, 1])
  assert.deepEqual(
    card?.live.map(h => h.label),
    ['probe:a', 'Nested grandchild', 'Nested child', 'Nested parent'],
  )
  assert.ok((card?.at ?? 0) > 0)

  // The session's process is gone (it sleeps): nothing of it works any more.
  const asleep = helpersOf(s.transcript, { alive: false })
  assert.deepEqual(
    asleep.helpers.filter(h => h.status === 'running'),
    [],
  )
  assert.equal(asleep.workflows[0]?.status, 'stopped')
  assert.equal(summarize(asleep)?.running, 0)
  assert.equal(summarize({ helpers: [], workflows: [] }), null)
  assert.deepEqual(helpersOf(null), { helpers: [], workflows: [] })

  // It finishes: read again because the file changed.
  s.append('subagents/agent-afork2.jsonl', [line.result(13, 'g1', 'a.txt'), line.said(14, 'Slice a is clean.')])
  const after = helpersOf(s.transcript, { alive: true, since: 0 }).helpers.find(h => h.id === 'afork2')
  assert.deepEqual([after?.status, after?.result], ['done', 'Slice a is clean.'])
})

test('one helper for its window: its conversation and its own tool calls only', async () => {
  const s = session()
  const path = s.helper('afork2', { agentType: 'fork', isFork: true, toolUseId: 'toolu_b' }, [
    line.call(10, 'toolu_b', 'Agent', { subagent_type: 'fork', description: "the parent's call" }),
    line.user(11, [
      { type: 'tool_result', tool_use_id: 'toolu_b', content: 'Fork started' },
      { type: 'text', text: '<fork-boilerplate>x</fork-boilerplate>\nYour directive: Count.' },
    ]),
    line.call(12, 'g1', 'Glob', { pattern: '*' }),
    line.result(13, 'g1', 'a.txt'),
  ])
  const d = await helperDetail(s.transcript, 'afork2', { alive: true, since: 0 })
  assert.equal(d?.helper.tools, 1) // the parent's call that made it is not the fork's
  assert.equal(d && 'path' in d.helper, false) // no file paths for the page
  assert.deepEqual(
    d?.conversation.map(m => m.role),
    ['user', 'tool'],
  )
  const first = d?.conversation[0]
  assert.equal(first?.role === 'user' && first.text, 'Count.')
  assert.equal(await helperDetail(s.transcript, 'nope', {}), null)
  assert.equal(await helperDetail(s.transcript, '../../x', {}), null)
  // Counted on from where it stopped, each call once.
  s.append('subagents/agent-afork2.jsonl', [line.call(14, 'g2', 'Read', { file_path: 'a.txt' }), line.blob(15)])
  // Two at once count each call once; a line still being written waits for its end.
  assert.deepEqual(await Promise.all([countTools(path, 'toolu_b'), countTools(path, 'toolu_b')]), [2, 2])
  const half = JSON.stringify(line.call(16, 'g3', 'Grep', { pattern: 'x' }))
  appendFileSync(path, half.slice(0, 30))
  assert.equal(await countTools(path, 'toolu_b'), 2)
  appendFileSync(path, `${half.slice(30)}\n`)
  assert.equal(await countTools(path, 'toolu_b'), 3)
})
