import { describe, expect, test } from 'bun:test'
import { createAgyFooterTracker } from '../../src/adapters/agy-home.ts'
import { formatAgentLines } from '../../src/core/agent-send.ts'
import { parseAgyTail } from '../../src/core/agy.ts'
import {
  BG_TASK_STUCK_DEFAULT_MIN,
  BG_TASK_STUCK_MAX_MIN,
  bgTaskActive,
  bgTaskFromFooter,
  bgTaskStuckMin,
  isBgTaskStuck,
  summarizeBgTasks,
} from '../../src/core/bg-task.ts'
import { agyFooterTasks } from '../../src/core/dialogs/agy-dialogs.ts'
import { nodePart } from '../../src/core/node-items.ts'

const SID = '3b13344e-a0c5-4a94-8f60-b430bd0202d8'
const RULE = '─'.repeat(60)
const step = (data: Record<string, unknown>) => JSON.stringify({ created_at: '2026-11-24T09:00:00Z', ...data })

describe('bg-task core rules (#676)', () => {
  test('bgTaskStuckMin defaults to 30, clamps [1, 1440], and treats 0, false, or non-positive values as off', () => {
    expect(bgTaskStuckMin(undefined)).toBe(BG_TASK_STUCK_DEFAULT_MIN)
    expect(bgTaskStuckMin(null)).toBe(BG_TASK_STUCK_DEFAULT_MIN)
    expect(bgTaskStuckMin('')).toBe(BG_TASK_STUCK_DEFAULT_MIN)
    expect(bgTaskStuckMin('   ')).toBe(BG_TASK_STUCK_DEFAULT_MIN)
    expect(bgTaskStuckMin(true)).toBe(BG_TASK_STUCK_DEFAULT_MIN)
    expect(bgTaskStuckMin('abc')).toBe(BG_TASK_STUCK_DEFAULT_MIN)
    expect(bgTaskStuckMin(Number.NaN)).toBe(BG_TASK_STUCK_DEFAULT_MIN)
    expect(bgTaskStuckMin(0)).toBe(0)
    expect(bgTaskStuckMin('0')).toBe(0)
    expect(bgTaskStuckMin(false)).toBe(0)
    expect(bgTaskStuckMin('false')).toBe(0)
    expect(bgTaskStuckMin('FALSE')).toBe(0)
    expect(bgTaskStuckMin(-5)).toBe(0)
    expect(bgTaskStuckMin('-1')).toBe(0)
    expect(bgTaskStuckMin('45')).toBe(45)
    expect(bgTaskStuckMin(' 15 ')).toBe(15)
    expect(bgTaskStuckMin(0.4)).toBe(1)
    expect(bgTaskStuckMin(45.6)).toBe(46)
    expect(bgTaskStuckMin(5000)).toBe(BG_TASK_STUCK_MAX_MIN)
  })

  test('summarizeBgTasks, bgTaskFromFooter, and isBgTaskStuck track oldest task and threshold', () => {
    const now = Date.parse('2026-11-24T09:45:00Z')
    const t10 = now - 10 * 60_000
    const t45 = now - 45 * 60_000

    expect(summarizeBgTasks([], 30, now)).toBeNull()
    const fresh = summarizeBgTasks(
      [{ id: `${SID}/task-1`, stepIndex: 10, startedAt: t10, detail: 'Run screenshot pass' }],
      30,
      now,
    )
    expect(fresh).toEqual({
      count: 1,
      since: t10,
      detail: 'Run screenshot pass',
      stuckMin: 30,
    })
    expect(isBgTaskStuck(fresh, now)).toBe(false)
    expect(isBgTaskStuck(fresh, t10 + 30 * 60_000)).toBe(true)

    const multi = summarizeBgTasks(
      [
        { id: `${SID}/task-2`, stepIndex: 12, startedAt: t10, detail: 'Newer task' },
        { id: `${SID}/task-1`, stepIndex: 10, startedAt: t45, detail: 'Headless Chrome capture\nsecond line' },
      ],
      30,
      now,
    )
    expect(multi).toEqual({
      count: 2,
      since: t45,
      detail: 'Headless Chrome capture second line',
      stuckMin: 30,
      stuck: true,
    })
    expect(isBgTaskStuck(multi, now)).toBe(true)

    // Threshold 0 disables stuck flag even after 9 hours.
    const disabled = summarizeBgTasks(
      [{ id: `${SID}/task-1`, stepIndex: 10, startedAt: now - 9 * 3600_000, detail: 'Long server' }],
      0,
      now,
    )
    expect(disabled?.stuck).toBeUndefined()
    expect(isBgTaskStuck(disabled, now)).toBe(false)

    expect(bgTaskFromFooter(0, t45, 30, now)).toBeNull()
    const fromFooter = bgTaskFromFooter(1, t45, 30, now)
    expect(fromFooter).toEqual({ count: 1, since: t45, detail: '', stuckMin: 30, stuck: true })
    expect(bgTaskActive(fromFooter)).toBe(true)
    expect(bgTaskActive(null)).toBe(false)
  })
})

describe('Antigravity transcript background task parsing (#676)', () => {
  test('tracks running background task after planner ends its turn and clears on SYSTEM_MESSAGE finish/cancel', () => {
    const startedAt = Date.parse('2026-11-24T09:00:05Z')
    const baseLines = [
      step({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nCapture screenshots\n</USER_REQUEST>' }),
      step({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T09:00:05Z',
        tool_calls: [
          {
            name: 'run_command',
            args: { CommandLine: '"node capture.js"', toolSummary: '"Capture headless screenshots"' },
          },
        ],
      }),
      step({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T09:00:05Z',
        content: [
          'Created At: 2026-11-24T09:00:05Z',
          `Tool is running as a background task with task id: ${SID}/task-2`,
          'Task Description: node capture.js',
          `Task logs are available at: file:///home/anna/.gemini/antigravity-cli/brain/${SID}/.system_generated/tasks/task-2.log`,
        ].join('\n'),
      }),
      step({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T09:00:06Z',
        content: 'Started the screenshot run in the background and waiting for it.',
      }),
    ]

    const active = parseAgyTail(baseLines)
    expect(active.tool?.pending).toBe(false)
    expect(active.lastText).toBe('Started the screenshot run in the background and waiting for it.')
    expect(active.bgTasks).toEqual([
      {
        id: `${SID}/task-2`,
        stepIndex: 2,
        startedAt,
        detail: 'Capture headless screenshots',
      },
    ])

    // Progress reminder ("is still running" / "still running after") keeps the task active.
    const stillRunning = parseAgyTail([
      ...baseLines,
      step({
        step_index: 4,
        type: 'SYSTEM_MESSAGE',
        source: 'SYSTEM',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T09:05:00Z sender=${SID}/task-2 priority=MESSAGE_PRIORITY_HIGH content=Background command is still running after 290s.\n</SYSTEM_MESSAGE>`,
      }),
    ])
    expect(stillRunning.bgTasks).toHaveLength(1)

    // Schedule timer SYSTEM_MESSAGE clears via sender=<taskId>.
    const timerFired = parseAgyTail([
      ...baseLines,
      step({
        step_index: 4,
        type: 'SYSTEM_MESSAGE',
        source: 'SYSTEM',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T09:01:00Z sender=${SID}/task-2 priority=MESSAGE_PRIORITY_HIGH content=Check sibling process.\n</SYSTEM_MESSAGE>`,
      }),
    ])
    expect(timerFired.bgTasks).toBeUndefined()

    // Compact transcript.jsonl SYSTEM_MESSAGE truncated right after sender= still clears bgTasks.
    const truncatedSys = parseAgyTail([
      ...baseLines,
      step({
        step_index: 4,
        type: 'SYSTEM_MESSAGE',
        source: 'SYSTEM',
        truncated_fields: ['content'],
        content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T09:02:00Z sender=${SID}/task-2 priori`,
      }),
    ])
    expect(truncatedSys.bgTasks).toBeUndefined()

    // Completion SYSTEM_MESSAGE clears it.
    const finished = parseAgyTail([
      ...baseLines,
      step({
        step_index: 4,
        type: 'SYSTEM_MESSAGE',
        source: 'SYSTEM',
        content: `<SYSTEM_MESSAGE>\n[Message] sender=${SID}/task-2 content=Task id "${SID}/task-2" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`,
      }),
    ])
    expect(finished.bgTasks).toBeUndefined()

    // Cancellation SYSTEM_MESSAGE clears it.
    const canceled = parseAgyTail([
      ...baseLines,
      step({
        step_index: 4,
        type: 'SYSTEM_MESSAGE',
        source: 'SYSTEM',
        content: `<SYSTEM_MESSAGE>\nTask id "${SID}/task-2" was canceled with result:\nTool execution was canceled\n</SYSTEM_MESSAGE>`,
      }),
    ])
    expect(canceled.bgTasks).toBeUndefined()

    // Completion SYSTEM_MESSAGE embedded inside USER_INPUT also clears it.
    const embeddedFinish = parseAgyTail([
      ...baseLines,
      step({
        step_index: 4,
        type: 'USER_INPUT',
        content: `<USER_REQUEST>\nnext prompt\n</USER_REQUEST>\n<SYSTEM_MESSAGE>\nTask id "${SID}/task-2" finished with result:\nok\n</SYSTEM_MESSAGE>`,
      }),
    ])
    expect(embeddedFinish.bgTasks).toBeUndefined()
  })

  test('ignores IsDaemon commands and reconciles manage_task kill and list outputs', () => {
    const lines = [
      step({
        step_index: 0,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>\nStart dev server and build\n</USER_REQUEST>',
      }),
      step({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T09:00:01Z',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: '"bun dev"', IsDaemon: true, toolSummary: '"Dev server"' } },
          { name: 'run_command', args: { CommandLine: '"bun build"', toolSummary: '"Build bundle"' } },
        ],
      }),
      step({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T09:00:02Z',
        content: `Created At: 2026-11-24T09:00:02Z\nTool is running as a background task with task id: ${SID}/task-2\nTask Description: bun dev`,
      }),
      step({
        step_index: 3,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T09:00:03Z',
        content: `Created At: 2026-11-24T09:00:03Z\nTool is running as a background task with task id: ${SID}/task-3\nTask Description: bun build`,
      }),
    ]

    // Daemon task-2 is ignored from bgTasks and tracked in daemonBgTasks; non-daemon task-3 stays tracked.
    const daemonAndWork = parseAgyTail(lines)
    expect(daemonAndWork.bgTasks).toEqual([
      {
        id: `${SID}/task-3`,
        stepIndex: 3,
        startedAt: Date.parse('2026-11-24T09:00:03Z'),
        detail: 'Build bundle',
      },
    ])
    expect(daemonAndWork.daemonBgTasks).toEqual([
      {
        id: `${SID}/task-2`,
        stepIndex: 2,
        startedAt: Date.parse('2026-11-24T09:00:02Z'),
        detail: 'Dev server',
      },
    ])

    // manage_task kill clears task-3.
    const killed = parseAgyTail([
      ...lines,
      step({ step_index: 4, type: 'GENERIC', status: 'DONE', content: `Task "${SID}/task-3" cancelled.` }),
    ])
    expect(killed.bgTasks).toBeUndefined()

    // manage_task list reporting 0 running clears remaining tasks.
    const emptyList = parseAgyTail([
      ...lines,
      step({
        step_index: 4,
        type: 'GENERIC',
        status: 'DONE',
        content: 'You have 0 background task(s) currently running.',
      }),
    ])
    expect(emptyList.bgTasks).toBeUndefined()

    // manage_task list JSON reconciles task list, extracts stepIndex from taskId, and drops unlisted task-3.
    const reconciled = parseAgyTail([
      ...lines,
      step({
        step_index: 4,
        type: 'GENERIC',
        status: 'DONE',
        content: `You have 1 background task(s) currently running:\n${JSON.stringify([
          { taskId: `${SID}/task-9`, toolSummary: 'Export PDF', startTime: '2026-11-24T09:05:00Z' },
        ])}`,
      }),
    ])
    expect(reconciled.bgTasks).toEqual([
      {
        id: `${SID}/task-9`,
        stepIndex: 9,
        startedAt: Date.parse('2026-11-24T09:05:00Z'),
        detail: 'Export PDF',
      },
    ])
  })

  test('pairs IsDaemon by call_id or command description when results arrive out of order, and keeps SYSTEM_MESSAGE tool order', () => {
    // Out-of-order parallel tool calls with explicit call_id:
    const outOfOrderById = parseAgyTail([
      step({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T09:00:01Z',
        tool_calls: [
          { call_id: 'c-daemon', name: 'run_command', args: { CommandLine: '"bun dev"', IsDaemon: true } },
          { call_id: 'c-work', name: 'run_command', args: { CommandLine: '"bun test"', toolSummary: '"Run tests"' } },
        ],
      }),
      // Result for c-work arrives first!
      step({
        step_index: 2,
        call_id: 'c-work',
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T09:00:02Z',
        content: `Tool is running as a background task with task id: ${SID}/task-2\nTask Description: bun test`,
      }),
      step({
        step_index: 3,
        call_id: 'c-daemon',
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T09:00:03Z',
        content: `Tool is running as a background task with task id: ${SID}/task-3\nTask Description: bun dev`,
      }),
    ])
    expect(outOfOrderById.bgTasks?.map(t => t.id)).toEqual([`${SID}/task-2`])
    expect(outOfOrderById.daemonBgTasks?.map(t => t.id)).toEqual([`${SID}/task-3`])

    // Out-of-order parallel tool calls without call_id fall back to Task Description matching CommandLine:
    const outOfOrderByDesc = parseAgyTail([
      step({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T09:00:01Z',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: '"bun dev"', IsDaemon: true } },
          { name: 'run_command', args: { CommandLine: '"bun test"', toolSummary: '"Run tests"' } },
        ],
      }),
      step({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T09:00:02Z',
        content: `Tool is running as a background task with task id: ${SID}/task-2\nTask Description: bun test`,
      }),
      step({
        step_index: 3,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T09:00:03Z',
        content: `Tool is running as a background task with task id: ${SID}/task-3\nTask Description: bun dev`,
      }),
    ])
    expect(outOfOrderByDesc.bgTasks?.map(t => t.id)).toEqual([`${SID}/task-2`])
    expect(outOfOrderByDesc.daemonBgTasks?.map(t => t.id)).toEqual([`${SID}/task-3`])

    // SYSTEM_MESSAGE preserves pending-tool resolution order (matches origin/main).
    const withSysMsg = parseAgyTail([
      step({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/a.ts"' } }],
      }),
      step({
        step_index: 2,
        type: 'SYSTEM_MESSAGE',
        source: 'SYSTEM',
        status: 'DONE',
        content: '<SYSTEM_MESSAGE>\nReminder\n</SYSTEM_MESSAGE>',
      }),
    ])
    expect(withSysMsg.tool?.pending).toBe(false)
  })
})

describe('agyFooterTasks screen footer parser (#676)', () => {
  test('reads exact status-bar task(s) token only below a complete input box rule and ignores prose', () => {
    const runningAnsi = [
      '● Waiting on Chrome screenshot run',
      '',
      RULE,
      '\x1b[2m> Type a message...\x1b[22m',
      RULE,
      '\x1b[33m1 task(s)\x1b[0m · esc to cancel                Orchestrator · Gemini 4 Neon · high',
    ].join('\n')
    expect(agyFooterTasks(runningAnsi)).toBe(1)

    const pluralScreen = ['Done.', RULE, '> ', RULE, '2 background task(s) · ? for shortcuts'].join('\n')
    expect(agyFooterTasks(pluralScreen)).toBe(2)

    // Partial screen without complete RULE -> > -> RULE box returns null (never guesses from bare rules).
    const partialCapture = [RULE, '3 task(s) · ? for shortcuts'].join('\n')
    expect(agyFooterTasks(partialCapture)).toBeNull()

    // Markdown horizontal rule in agent prose with "1 task(s)" must not match.
    const proseDivider = ['Summary:', RULE, '1 task(s) completed yesterday', RULE].join('\n')
    expect(agyFooterTasks(proseDivider)).toBeNull()

    // Prose on subsequent footer line or "tasks" without literal task(s) does not match.
    const proseFooter = [
      'Earlier message mentioned 4 tasks above the prompt rule.',
      RULE,
      '> ',
      RULE,
      'esc to cancel                                     Orchestrator · Gemini 4 Neon · high',
      '2 task(s) mentioned on a stray extra line',
    ].join('\n')
    expect(agyFooterTasks(proseFooter)).toBe(0)

    const dialogScreen = ['Pick one', RULE, '> ', RULE, '↑↓ to navigate · enter to select · esc to close'].join('\n')
    expect(agyFooterTasks(dialogScreen)).toBeNull()
    expect(agyFooterTasks('plain text without rules')).toBeNull()
  })

  test('createAgyFooterTracker caches status-bar counts without fabricating start timestamps', async () => {
    const running = ['Wait', RULE, '> ', RULE, '1 task(s) · esc to cancel'].join('\n')
    const idle = ['Done', RULE, '> ', RULE, '? for shortcuts'].join('\n')
    const screens: (string | null)[] = [running, null, running, idle]
    const tracker = createAgyFooterTracker(async () => screens.shift() ?? null, 1000)

    const t0 = 1_700_000_000_000
    expect(await tracker.check('a1', 'term1', t0)).toBe(1)
    expect(await tracker.check('a1', 'term1', t0 + 500)).toBe(1)
    expect(await tracker.check('a1', 'term1', t0 + 1500)).toBeNull()
    expect(await tracker.check('a1', 'term1', t0 + 3000)).toBe(1)
    expect(await tracker.check('a1', 'term1', t0 + 4500)).toBeNull()
    screens.push(running)
    expect(await tracker.check('a1', 'term1', t0 + 6000)).toBe(1)
  })

  test('createAgyFooterTracker.peek returns cached count synchronously and invokes onChange only when count changes', async () => {
    const running = ['Wait', RULE, '> ', RULE, '1 task(s) · esc to cancel'].join('\n')
    const idle = ['Done', RULE, '> ', RULE, '? for shortcuts'].join('\n')
    let current: string | null = idle
    const tracker = createAgyFooterTracker(async () => current, 1000)

    let changes = 0
    const onChange = () => {
      changes++
    }
    const t0 = 1_700_000_000_000
    // Initial miss (0 -> 0): synchronous null, background probe sees idle -> no onChange.
    expect(tracker.peek('a1', 'term1', t0, onChange)).toBeNull()
    await Bun.sleep(10)
    expect(changes).toBe(0)

    // Transition 0 -> 1 after pollMs: triggers onChange once background probe completes.
    current = running
    expect(tracker.peek('a1', 'term1', t0 + 1500, onChange)).toBeNull()
    await Bun.sleep(10)
    expect(changes).toBe(1)
    expect(tracker.peek('a1', 'term1', t0 + 1600, onChange)).toBe(1)
  })
})

describe('nodePart and ListAgents with bgTasks (#676)', () => {
  test('nodePart validates bgTasks and strips invalid values', () => {
    const longDetail = 'x'.repeat(300)
    const part = nodePart(
      {
        items: [
          {
            key: SID,
            session: SID,
            pane: 'w1:p1',
            workspace: 'w1',
            cwd: '/home/anna/work',
            status: 'working',
            name: 'atlas',
            autoName: 'atlas',
            category: 'other',
            categorySet: true,
            column: 'work',
            attention: '',
            bgTasks: { count: 1, since: 1_700_000_000_000, detail: longDetail, stuckMin: 30, stuck: true },
          },
          {
            key: 'pane-2',
            session: null,
            pane: 'pane-2',
            workspace: 'w1',
            cwd: '/home/ben/work',
            status: 'idle',
            name: 'ben',
            autoName: 'ben',
            category: 'other',
            categorySet: false,
            column: 'idle',
            attention: '',
            bgTasks: { count: 0, since: null, detail: 'invalid zero', stuckMin: 30 },
          },
        ],
      },
      'node-1',
    )
    expect(part?.items[0]?.bgTasks).toEqual({
      count: 1,
      since: 1_700_000_000_000,
      detail: 'x'.repeat(160),
      stuckMin: 30,
      stuck: true,
    })
    expect(part?.items[1]?.bgTasks).toBeUndefined()
  })

  test('formatAgentLines notes stuck background tasks while leaving normal sessions unchanged', () => {
    const lines = formatAgentLines(
      [
        {
          key: SID,
          name: 'atlas',
          names: ['atlas'],
          session: SID,
          agent: 'agy',
          device: null,
          pane: 'w1:p1',
          cwd: '/work',
          sleeping: false,
          status: 'working',
          day: false,
          activity: 2_000_000,
          bgTasks: { count: 1, since: 1000, detail: 'Chrome', stuckMin: 30, stuck: true },
        },
        {
          key: '030bc85e-c173-4999-b250-c85a4d5595bd',
          name: 'cleo',
          names: ['cleo'],
          session: '030bc85e-c173-4999-b250-c85a4d5595bd',
          agent: 'claude',
          device: null,
          pane: 'w1:p2',
          cwd: '/work',
          sleeping: false,
          status: 'done',
          day: false,
          activity: 2_000_000,
        },
      ],
      { now: 2_000_000 },
    )
    expect(lines[0]).toContain('background task may be stuck')
    expect(lines[1]).toBe('cleo [030bc85e]  ·  claude  ·  done')
  })
})
