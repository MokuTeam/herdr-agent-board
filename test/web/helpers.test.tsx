// Markup parity for a session's helpers and the sessions it works with (upstream #40): the rows,
// the card's chip and foot, the sheet's strip and "Sessions" row, the thread's lines that work with
// others, and the helpers window, against what upstream's helpers.js and app.js drew as that change
// left them (support/old-helpers.ts).
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import type { ReactNode } from 'react'
import type { PublicHelper, WorkflowRun } from '../../src/core/helpers.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { taskNotice } from '../../src/core/notices.ts'
import type { ConversationTurn } from '../../src/core/transcript.ts'
import type { Item } from '../../src/core/types.ts'
import { isSessionDetail } from '../../web/src/api/client.ts'
import { isHelperReply } from '../../web/src/api/helpers.ts'
import { HelpersChip, Relations } from '../../web/src/components/helpers/CardHelpers.tsx'
import { HelperRow, RunRow } from '../../web/src/components/helpers/HelperRows.tsx'
import { HelpersStrip } from '../../web/src/components/helpers/HelpersStrip.tsx'
import { HelpersWindowView } from '../../web/src/components/helpers/HelpersWindow.tsx'
import { RelationsRow } from '../../web/src/components/helpers/RelationsRow.tsx'
import { Thread } from '../../web/src/components/sheet/Thread.tsx'
import type { HelperRef, HelpersView } from '../../web/src/hooks/useHelpers.ts'
import { visibleItems } from '../../web/src/models/board-view.ts'
import { summaryParts } from '../../web/src/models/toolbar.ts'
import { type NotificationParts, notification } from '../support/task-notification.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { addButtonTypes, canonical, findAll, hasClass, type Node, parseHtml } from './support/markup.ts'
import { oldApp, oldWindow, tickClocks } from './support/old-helpers.ts'

// A whole second: the running clocks on both sides read the same.
const NOW = Date.parse('2026-10-16T10:30:00.000Z')
beforeAll(() => setSystemTime(new Date(NOW)))
afterAll(() => setSystemTime())

const S = 1000
const helper = (id: string, more: Partial<PublicHelper> = {}): PublicHelper => ({
  id,
  kind: 'agent',
  type: 'general-purpose',
  name: '',
  description: `Task ${id}`,
  color: '',
  model: '',
  background: true,
  parent: null,
  toolUseId: null,
  workflow: null,
  phase: '',
  status: 'done',
  startedAt: NOW - 600 * S,
  endedAt: NOW - 540 * S,
  activity: NOW - 540 * S,
  prompt: `Do ${id}.`,
  from: '',
  now: null,
  after: '',
  waiting: 0,
  tokens: 21302,
  result: 'Done.',
  ...more,
})
const run = (id: string, more: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  name: `flow-${id}`,
  status: 'done',
  summary: '',
  startedAt: NOW - 900 * S,
  endedAt: NOW - 800 * S,
  activity: NOW - 800 * S,
  tokens: null,
  tools: null,
  agents: 0,
  taskId: '',
  ...more,
})

const HELPERS: PublicHelper[] = [
  helper('a1', {
    status: 'running',
    startedAt: NOW - 65 * S,
    description: 'Check the logs',
    toolUseId: 'ag',
    now: { name: 'Read', label: 'Read', detail: 'app.log' },
  }),
  helper('a2', { status: 'running', kind: 'fork', type: '', name: 'audit-a', description: '', after: 'Grep' }),
  helper('a3', { status: 'running', waiting: 2, name: 'waiter', description: 'Wait for builds', phase: '' }),
  helper('a4', { status: 'running', parent: 'a1', description: 'Nested child', startedAt: NOW - 30 * S }),
  helper('a5', { status: 'running', description: 'Plain thinking', model: 'claude-x' }),
  helper('m1', { kind: 'teammate', status: 'idle', color: 'green', name: 'design-check', type: 'code-reviewer' }),
  helper('w1', {
    kind: 'workflow',
    type: '',
    workflow: 'wf_1',
    status: 'running',
    phase: 'Probe',
    description: 'probe:a',
  }),
  helper('d1', { status: 'done', background: false, description: 'Find the owner' }),
  helper('f1', { status: 'failed', description: 'Broke', startedAt: null }),
  helper('s1', { status: 'stopped', description: 'Stopped one', endedAt: null }),
]
const RUNS: WorkflowRun[] = [
  run('wf_1', { status: 'running', name: 'probe-parallel', agents: 1, startedAt: NOW - 120 * S }),
  run('wf_0', { status: 'done', tokens: 52000, summary: 'Audit of every screen', agents: 2, taskId: 'tw0' }),
  run('wf_x', { status: 'stopped', name: '' }),
]

const t = translator('en')
const oldNodes = (html: string): Node[] => {
  const nodes = parseHtml(html)
  tickClocks(nodes)
  addButtonTypes(nodes)
  return nodes
}
const same = (old: Node[], react: Node[], spaces = false) =>
  expect(canonical(react, { spaces })).toBe(canonical(old, { spaces }))
const inBoard = (node: ReactNode, items: Item[] = [], categories = CATEGORIES) =>
  renderInBoard(node, board({ data: payload({ items, categories }) }))

const CATEGORIES = [
  { id: 'other', title: 'Other', color: '#8e8e93', colorName: 'gray', paths: [], configured: true, fallback: true },
  { id: 'work', title: 'Work', color: '#0a84ff', colorName: 'blue', paths: [], configured: true, fallback: false },
]

describe('rows', () => {
  test('a helper as a row: what it does now, how long it ran, how it stands; nested a level in', () => {
    const { rows } = oldApp({ items: [] })
    const listed = [
      ...HELPERS,
      { ...HELPERS[3], depth: 1 },
      { ...HELPERS[3], id: 'deep', depth: 5 },
    ] as (PublicHelper & {
      depth?: number
    })[]
    for (const h of listed) same(oldNodes(String(rows.helperRowHTML(h, t))), inBoard(<HelperRow h={h} />))
  })

  test('a workflow run as a row: its name, its agents, its status', () => {
    const { rows } = oldApp({ items: [] })
    for (const w of RUNS) same(oldNodes(String(rows.runRowHTML(w, t))), inBoard(<RunRow w={w} />))
  })
})

const ITEMS: Item[] = [
  item({ key: 'm', name: 'Master', autoName: 'Master', pane: 'w:p1' }),
  item({ key: 'c', name: 'My case', autoName: 'case-42', pane: 'w:p2', category: 'work' }),
  item({ key: 'o', name: 'Other', autoName: 'other-1', pane: 'w:p3' }),
]

describe('the card', () => {
  const cases: [string, Partial<Item>][] = [
    ['nothing at work, no links', {}],
    [
      'three at work, a teammate in its own color, the newest one’s words',
      {
        helpers: {
          running: 4,
          total: 6,
          workflows: 0,
          live: [
            { id: 'x1', kind: 'agent', label: 'Check the logs', color: '' },
            { id: 'x2', kind: 'teammate', label: 'design', color: 'green' },
            { id: 'x3', kind: 'fork', label: 'audit', color: '' },
            { id: 'x4', kind: 'workflow', label: 'probe', color: '' },
          ],
          at: NOW,
        },
      },
    ],
    ['a workflow between two of its agents', { helpers: { running: 0, total: 2, workflows: 1, live: [], at: NOW } }],
    ['all finished: no chip', { helpers: { running: 0, total: 2, workflows: 0, live: [], at: 0 } }],
    [
      'started by another session, and started two (one gone from the board)',
      {
        links: {
          from: { key: 'm', name: 'Master', at: NOW },
          started: [
            { key: 'o', name: 'Other', at: NOW },
            { key: 'gone', name: 'Gone', at: NOW },
            { key: 'c', name: 'My case', at: NOW },
          ],
          talks: [],
        },
      },
    ],
    [
      'linked only by messages: no foot',
      { links: { from: null, started: [], talks: [{ key: 'm', name: 'Master', in: 1, out: 0, at: NOW }] } },
    ],
  ]
  for (const [name, more] of cases)
    test(name, () => {
      const it = item({ key: 'c', name: 'My case', ...more })
      const items = [...ITEMS.filter(i => i.key !== 'c'), it]
      const app = oldApp({ items })
      const old = oldNodes(`${String(app.helpersChip(it))}${String(app.relationsLine(it))}`)
      same(
        old,
        inBoard(
          <>
            <HelpersChip item={it} />
            <Relations item={it} />
          </>,
          items,
        ),
      )
    })
})

describe('the sheet', () => {
  const strip = (helpers: PublicHelper[], workflows: WorkflowRun[]) => {
    const old = oldApp({ items: ITEMS, detail: { helpers, workflows } }).strip()
    addButtonTypes([old])
    const react = inBoard(
      <HelpersStrip helpers={helpers} workflows={workflows} onHelper={() => {}} onList={() => {}} />,
    )
    same([old], react)
  }
  test('no helpers: the strip stays hidden', () => strip([], []))
  test('at work: the runs that run, then the first four, then how many more', () => strip(HELPERS, RUNS))
  test('at work, a few: no "more"', () => strip(HELPERS.slice(0, 2), []))
  test('none at work: the newest of its own helpers, a teammate waiting for a message as before', () => {
    const finished = HELPERS.filter(h => h.status !== 'running')
    strip(finished, [])
  })
  test('none at work, the newest ended: how and when in its mark’s place, the head as before (#113)', () => {
    const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
    const ended = (helpers: PublicHelper[], workflows: WorkflowRun[]) => {
      const old = oldApp({ items: ITEMS, detail: { helpers, workflows } }).strip()
      addButtonTypes([old])
      const react = inBoard(
        <HelpersStrip helpers={helpers} workflows={workflows} onHelper={() => {}} onList={() => {}} />,
      )
      const last = findAll(react, el => hasClass(el, 'helper-last'))[0]
      // The head and the strip around the line are the old ones.
      for (const rows of [
        ...findAll([old], el => hasClass(el, 'helper-rows')),
        ...findAll(react, el => hasClass(el, 'helper-rows')),
      ])
        rows.children = []
      same([old], react)
      if (!last) throw new Error('no last line')
      expect(last.attrs.get('class')).toBe('helper-last past')
      expect(findAll([last], el => hasClass(el, 'h-mark'))).toEqual([])
      return { title: last.attrs.get('title'), parts: last.children.slice(1).map(textOf) }
    }
    const stopped = helper('s9', {
      status: 'stopped',
      description: 'Denser board header',
      endedAt: NOW - 8 * 60 * S,
    })
    expect(ended([stopped], [])).toEqual({
      title: 'Denser board header · stopped 8 min ago',
      parts: ['Denser board header', 'stopped 8 min ago'],
    })
    expect(ended([], [run('wf_late', { endedAt: NOW - 10 * S, status: 'failed' })]).parts).toEqual([
      'flow-wf_late',
      'failed just now',
    ])
    expect(ended([], [run('wf_only', { status: 'done', endedAt: NOW - 7 * 60 * S })]).parts).toEqual([
      'flow-wf_only',
      'finished 7 min ago',
    ])
  })

  describe('none at work: the newest ended line for ten minutes, then only the head', () => {
    const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
    // The strip as the board draws it at `now`.
    const at = (helpers: PublicHelper[], workflows: WorkflowRun[], now = NOW) =>
      renderInBoard(
        <HelpersStrip helpers={helpers} workflows={workflows} onHelper={() => {}} onList={() => {}} />,
        board({ data: payload({ items: ITEMS, categories: CATEGORIES }), now }),
      )
    const parts = (nodes: Node[]) => {
      const last = findAll(nodes, el => hasClass(el, 'helper-last'))
      return {
        last: last.map(el => el.children.slice(1).map(textOf)),
        rows: findAll(nodes, el => hasClass(el, 'helper-rows')).length,
        head: findAll(nodes, el => hasClass(el, 'helpers-head')).map(textOf),
        hidden: nodes[0]?.kind === 'element' && nodes[0].attrs.has('hidden'),
      }
    }
    const head = (sum: string) => [`Helpers${sum}All`]
    const ago = (min: number) => NOW - min * 60 * S

    test('a helper ended 9 min ago: its line; 11 min ago: the head alone, "All" still there', () => {
      const ended = (min: number) => [
        helper('b1', { description: 'Board header above docked panel', endedAt: ago(min), activity: ago(min) }),
        helper('b0', { status: 'failed', endedAt: ago(min + 30), activity: ago(min + 30) }),
      ]
      expect(parts(at(ended(9), []))).toEqual({
        last: [['Board header above docked panel', 'finished 9 min ago']],
        rows: 1,
        head: head('2 finished'),
        hidden: false,
      })
      const later = at(ended(11), [])
      expect(parts(later)).toEqual({ last: [], rows: 0, head: head('2 finished'), hidden: false })
      expect(findAll(later, el => el.attrs.has('data-helpers-all')).length).toBe(1)
    })

    test('the line goes by itself as the board’s clock moves on, without new helpers', () => {
      const list = [helper('b1', { endedAt: ago(9), activity: ago(9) })]
      expect(parts(at(list, [], NOW)).last).toEqual([['Task b1', 'finished 9 min ago']])
      expect(parts(at(list, [], NOW + 59 * S)).last).toEqual([['Task b1', 'finished 9 min ago']])
      expect(parts(at(list, [], NOW + 61 * S)).last).toEqual([])
    })

    test('no end time: from its last activity', () => {
      const stopped = (min: number) => [
        helper('s2', { status: 'stopped', description: 'Stopped one', endedAt: null, activity: ago(min) }),
      ]
      expect(parts(at(stopped(9), [])).last).toEqual([['Stopped one', 'stopped 9 min ago']])
      expect(parts(at(stopped(11), [])).last).toEqual([])
    })

    test('a workflow run: its line for ten minutes, then the head with nothing to count', () => {
      const flow = (min: number) => [run('wf_n', { status: 'done', endedAt: ago(min), activity: ago(min) })]
      expect(parts(at([], flow(9))).last).toEqual([['flow-wf_n', 'finished 9 min ago']])
      expect(parts(at([], flow(11)))).toEqual({ last: [], rows: 0, head: head(''), hidden: false })
    })

    test('the newest decides: a run that ended 2 min ago shows over a helper of an hour ago', () => {
      const list = [helper('b1', { endedAt: ago(60), activity: ago(60) })]
      const flows = [run('wf_r', { status: 'done', endedAt: ago(2), activity: ago(2) })]
      expect(parts(at(list, flows)).last).toEqual([['flow-wf_r', 'finished 2 min ago']])
      expect(parts(at(list, flows, NOW + 9 * 60 * S)).last).toEqual([])
    })

    test('at work, beside helpers that ended a day ago: as before', () => {
      const old = HELPERS.filter(h => h.status !== 'running').map(h => ({
        ...h,
        endedAt: h.endedAt && ago(24 * 60),
        activity: ago(24 * 60),
      }))
      strip([...HELPERS.filter(h => h.status === 'running'), ...old], RUNS)
      strip([HELPERS[0] as PublicHelper, ...old], [])
      // Only a workflow run at work, its agent included.
      strip([HELPERS[6] as PublicHelper, ...old], RUNS.slice(0, 1))
    })
  })

  const relations = (links: NonNullable<Item['links']> | null, items = ITEMS) => {
    const it = item({ key: 'k', name: 'Here', links })
    const all = [...items, it]
    const app = oldApp({ items: all, categories: CATEGORIES })
    same(oldNodes(String(app.relationsRow(it))), inBoard(<RelationsRow item={it} onSession={() => {}} />, all), true)
  }
  test('"Sessions": who started it first, then by the latest contact, with the messages each way', () =>
    relations({
      from: { key: 'm', name: 'Master', at: NOW - 3600 * S },
      started: [
        { key: 'c', name: 'My case', at: NOW - 120 * S },
        { key: 'gone', name: 'Gone', at: NOW },
      ],
      talks: [
        { key: 'c', name: 'My case', in: 2, out: 1, at: NOW - 60 * S },
        { key: 'm', name: 'Master', in: 0, out: 3, at: NOW - 30 * S },
        { key: 'o', name: 'Other', in: 1, out: 0, at: NOW - 7200 * S },
      ],
    }))
  test('"Sessions": none linked, no row', () => relations(null))
  test('"Sessions": more than six, the first five and how many more', () => {
    const many = Array.from({ length: 8 }, (_, n) => item({ key: `s${n}`, name: `Session ${n}` }))
    relations(
      {
        from: null,
        started: [],
        talks: many.map((s, n) => ({ key: s.key, name: s.name, in: n, out: 0, at: NOW - n * S })),
      },
      many,
    )
  })
})

const call = (id: string, more: Partial<Extract<ConversationTurn, { role: 'tool' }>>): ConversationTurn => ({
  role: 'tool',
  label: 'Agent',
  detail: '',
  path: '',
  done: true,
  at: NOW - 300 * S,
  id,
  ...more,
})
const peer = (more: Partial<Extract<ConversationTurn, { role: 'peer' }>>): ConversationTurn => ({
  role: 'peer',
  from: '',
  text: 'Hello **there**.',
  at: NOW - 200 * S,
  ...more,
})

/** A background task reporting back (core/notices.ts), as the thread gets it. */
const notice = (summary: string, at: number, more: NotificationParts): ConversationTurn => {
  const n = taskNotice(notification(summary, more))
  if (!n) throw new Error(`not a task notice: ${summary}`)
  return { role: 'notice', ...n, at }
}

describe('the thread', () => {
  const session = item({ key: 'k', name: 'Here', column: 'work', status: 'working', pane: 'w:p9' })
  const items = [...ITEMS, session, item({ key: 'spawned', name: 'case-43', autoName: 'case-43', pane: 'wP:p3' })]
  /** Both sides of the thread, the same; the React side's markup. */
  const drawn = (conversation: ConversationTurn[], ctx: { helper?: PublicHelper; key?: string } = {}) => {
    const app = oldApp({ items, detail: { helpers: HELPERS, workflows: RUNS } })
    const old = oldNodes(String(app.thread(conversation, session, ctx)))
    const react = inBoard(
      <Thread
        conversation={conversation}
        item={session}
        links={{ helpers: HELPERS, workflows: RUNS, items }}
        helper={ctx.helper ?? null}
      />,
      items,
    )
    same(old, react, true)
    return react
  }
  const thread = (conversation: ConversationTurn[], ctx: { helper?: PublicHelper; key?: string } = {}) => {
    drawn(conversation, ctx)
  }

  test('a helper it started: its status and clock when known, else what the call says', () =>
    thread([
      { role: 'user', text: 'Go.', at: NOW - 400 * S },
      call('ag', {
        detail: 'Check the logs',
        helper: { kind: 'agent', type: 'general-purpose', name: '', background: true, id: 'a1' },
      }),
      call('fk', {
        detail: 'Audit a',
        helper: { kind: 'fork', type: '', name: 'audit-a', background: false, id: '' },
        done: false,
      }),
      call('gone', { detail: '', helper: { kind: 'agent', type: 'x', name: 'named', background: false, id: 'zz' } }),
      call('d1x', { helper: { kind: 'agent', type: '', name: '', background: false, id: 'd1' } }),
      { role: 'tool', label: 'Read', detail: 'a.txt', path: 'C:/w/a.txt', done: true, at: NOW - 100 * S },
    ]))

  test('a workflow, a session it started, one it could not start', () =>
    thread([
      call('wf', { label: 'Workflow', workflow: { name: 'polish', run: 'wf_0' } }),
      call('wf2', { label: 'Workflow', workflow: { name: 'probe', run: 'wf_none' }, done: false }),
      call('wf3', { label: 'Workflow', workflow: { name: '', run: 'wf_y' } }),
      call('sp', { label: 'Bash', spawn: { name: 'case-43', pane: 'wP:p3' } }),
      call('sp2', { label: 'Bash', spawn: { name: 'elsewhere', pane: 'wP:p8' }, done: false }),
      call('sp3', { label: 'PowerShell', spawn: { name: 'broken', pane: '', failed: true } }),
      call('sp4', { label: 'Bash', spawn: { name: '', pane: '' } }),
    ]))

  test('messages sent: to a session, a teammate, a pipe whose session is gone; the text folds open', () =>
    thread([
      call('s1', { label: 'SendMessage', send: { to: 'case 42', summary: 'Hours', text: 'All **in**.' } }),
      call('s2', { label: 'SendMessage', send: { to: 'design-check', summary: '', text: '' } }),
      call('s3', { label: 'SendMessage', send: { to: '', summary: 'Reply', text: 'Thanks.', name: '', key: null } }),
      call('s4', { label: 'SendMessage', send: { to: 'Master', summary: '', text: 'x', name: '', key: 'm' } }),
      call('s5', { label: 'SendMessage', send: { to: 'Nobody', summary: '', text: '' } }),
    ]))

  test('messages in: another session by its key or its name, a teammate with its summary, someone unknown', () =>
    thread([
      peer({ from: 'Master', key: 'm' }),
      peer({ from: 'case-42' }),
      peer({ from: 'design-check', team: true, summary: 'Done' }),
      peer({ from: 'Stranger' }),
      peer({ from: '' }),
      { role: 'assistant', text: 'Ok.', at: NOW - 50 * S },
    ]))

  test('an agent or a workflow that reported back: "Conversation" opens it; other notices have none', () => {
    const react = drawn([
      notice('Agent "Check the logs" finished', NOW - 90 * S, { id: 'a1', tail: '<result>All **fine**.</result>' }),
      notice('Agent "Find the owner" completed', NOW - 80 * S, { id: 'd1' }),
      notice('Agent "Gone" finished', NOW - 70 * S, { id: 'zz', tail: '<result>x</result>' }),
      notice('Dynamic workflow "polish" completed', NOW - 60 * S, { id: 'tw0', tail: '<result>- one</result>' }),
      notice('Dynamic workflow "other" completed', NOW - 50 * S, { id: 'tw9' }),
      notice('Background command "Run tests" completed (exit code 0)', NOW - 40 * S, { id: 'a1' }),
      { role: 'assistant', text: 'Both are in.', at: NOW - 30 * S },
    ])
    const open = findAll(react, el => hasClass(el, 'notice-open'))
    expect(open.map(el => el.attrs.get('data-helper') ?? `run ${el.attrs.get('data-run-open')}`)).toEqual([
      'a1',
      'd1',
      'run wf_0',
    ])
  })

  test("a helper's own conversation: what its session asked, its calls live while it works", () => {
    const own = HELPERS[0] as PublicHelper
    const conversation: ConversationTurn[] = [
      { role: 'user', text: 'Read the logs.', at: NOW - 60 * S },
      { role: 'tool', label: 'Read', detail: 'app.log', path: '', done: false, at: NOW - 50 * S },
      peer({ from: 'main' }),
      peer({ from: 'team-lead', team: true }),
    ]
    thread(conversation, { helper: own, key: 'k' })
    thread(conversation, { helper: { ...own, status: 'done' }, key: 'k' })
  })
})

describe('the helpers window', () => {
  const detail = { helpers: HELPERS, workflows: RUNS }
  const view = (stack: HelperRef[], more: Partial<HelpersView> = {}): HelpersView => ({
    hidden: false,
    closing: false,
    key: 'k',
    stack,
    seq: 1,
    data: null,
    first: true,
    error: '',
    ...more,
  })
  const session = item({ key: 'k', name: 'Here', column: 'work', status: 'working' })
  const items = [...ITEMS, session]
  const win = (
    stack: HelperRef[],
    more: Partial<HelpersView> = {},
    sheet: { helpers: PublicHelper[]; workflows: WorkflowRun[] } | null = detail,
  ) => {
    const old = oldWindow({
      items,
      detail: sheet,
      key: 'k',
      stack: stack.map(r => ({ ...r })),
      data: more.data ?? null,
      error: more.error ?? '',
    })
    addButtonTypes([old])
    const react = inBoard(
      <HelpersWindowView
        view={view(stack, more)}
        sheet={{
          key: 'k',
          data: sheet && { item: session, conversation: [], screen: '', dialog: null, checkout: false, ...sheet },
        }}
        item={session}
        items={items}
      />,
      items,
    )
    same([old], react)
  }

  test('the list: at work, the workflow runs with their agents, the teammates, the finished', () =>
    win([{ list: true, run: null }]))
  test('the list of a session with no helpers', () =>
    win([{ list: true, run: null }], {}, { helpers: [], workflows: [] }))
  test('the list before the sheet has read the session', () => win([{ list: true, run: null }], {}, null))
  test('a helper while its conversation loads: what the sheet knows, else its id', () => {
    win([{ list: true, run: null }, { id: 'm1' }])
    win([{ id: 'nope' }])
  })
  test('a helper that could not be read', () => {
    win([{ id: 'a1' }], { error: 'This session has no such helper' })
    win([{ id: 'a1' }], { error: 'Offline: <fetch> failed & "retry"' })
  })

  const read = (h: PublicHelper, conversation: ConversationTurn[], tools = 3) => ({
    helper: { ...h, tools },
    workflow: null,
    conversation,
  })
  const conversation: ConversationTurn[] = [
    { role: 'user', text: 'Read the logs.', at: NOW - 60 * S },
    { role: 'tool', label: 'Read', detail: 'app.log', path: '', done: true, at: NOW - 50 * S },
    { role: 'assistant', text: 'They are **fine**.', at: NOW - 40 * S },
  ]
  test('a helper at work: its conversation, a running clock, its calls and tokens', () =>
    win([{ id: 'a1' }], { data: read(HELPERS[0] as PublicHelper, conversation) }))
  test('a finished helper: how long it took; a teammate says nothing of the background', () => {
    win([{ id: 'd1' }], { data: read(HELPERS[7] as PublicHelper, conversation, 0) })
    win([{ id: 'm1' }], { data: read(HELPERS[5] as PublicHelper, conversation) })
  })
  test('a helper with nothing said yet', () => win([{ id: 'f1' }], { data: read(HELPERS[8] as PublicHelper, []) }))
})

describe('what the page takes from the server', () => {
  const detail = { item: { key: 'k' }, conversation: [], screen: '', dialog: null, checkout: false }
  test('a session’s detail: its helpers and runs when it has them, another session’s messages', () => {
    expect(isSessionDetail(detail)).toBe(true)
    expect(isSessionDetail({ ...detail, helpers: HELPERS, workflows: RUNS, conversation: [peer({})] })).toBe(true)
    expect(isSessionDetail({ ...detail, helpers: [{ id: 'x' }] })).toBe(false)
    expect(isSessionDetail({ ...detail, workflows: 'no' })).toBe(false)
  })
  test('one helper with its conversation', () => {
    const reply = { helper: { ...HELPERS[0], tools: 2 }, workflow: null, conversation: [peer({})] }
    expect(isHelperReply(reply)).toBe(true)
    expect(isHelperReply({ ...reply, workflow: RUNS[0] })).toBe(true)
    expect(isHelperReply({ ...reply, helper: null })).toBe(false)
    expect(isHelperReply({ ...reply, conversation: [{ role: 'nobody' }] })).toBe(false)
  })
})

describe('the board', () => {
  test('the toolbar counts the helpers at work on the whole board', () => {
    const summary = (running: number, workflows: number) => ({ running, total: 9, workflows, live: [], at: 0 })
    const items = [
      item({ key: 'a', helpers: summary(3, 1) }),
      item({ key: 'b', helpers: summary(0, 2) }),
      item({ key: 'c' }),
    ]
    expect(summaryParts(items, t).find(p => p.id === 'helpers')).toEqual({
      id: 'helpers',
      n: 5,
      text: 'helpers at work',
      strong: true,
    })
    expect(summaryParts([item({ key: 'c' })], t).some(p => p.id === 'helpers')).toBe(false)
  })

  test('the search finds a session by what its helpers at work do', () => {
    const it = item({
      key: 'a',
      helpers: {
        running: 1,
        total: 1,
        workflows: 0,
        live: [{ id: 'x', kind: 'agent', label: 'Audit the invoices', color: '' }],
        at: 0,
      },
    })
    const options = { query: 'invoices', sleepers: true, categories: [], categoryOf: (i: Item) => i.category }
    expect(visibleItems([it, item({ key: 'b' })], options).map(i => i.key)).toEqual(['a'])
  })
})
