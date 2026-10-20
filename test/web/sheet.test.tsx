// The React session sheet against the old page's (at the parity baseline): each scene drawn by
// web/app.js's own sheet code on the #sheet of web/index.html (support/old-sheet.ts) and by
// <SheetHead> and <SheetView> for the same state (support/sheet-scene.tsx) — the head's title (with
// a session in it, #62's compact head keeps only the old reminders' row), then everything under the
// head. The compact head itself is looked at on its own, below. Whitespace between elements is dropped by the comparison; where text
// runs inline, a second comparison keeps it (canonical `spaces`). Then the mounted sheet, as the
// page draws it before any effect ran.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import type { ConversationTurn } from '../../src/core/transcript.ts'
import type { ColumnId, Item } from '../../src/core/types.ts'
import type { SessionDetail } from '../../web/src/api/client.ts'
import { Sheet } from '../../web/src/components/sheet/Sheet.tsx'
import { type HeadCard, SheetHead } from '../../web/src/components/sheet/SheetHead.tsx'
import { NO_MOVES, withMove } from '../../web/src/models/board-view.ts'
import type { Attachment } from '../../web/src/models/composer.ts'
import type { DetailValue } from '../../web/src/models/detail-resource.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { CATEGORIES } from './support/board-scene.tsx'
import { byClass, byId, canonical, find, findAll, hasClass, type Node } from './support/markup.ts'
import { oldSheet, sheetParts } from './support/old-sheet.ts'
import { bothSheets, drawSheet, type SheetScene } from './support/sheet-scene.tsx'

const MIN = 60_000
// Half minutes: the two sides read the clock a few ms apart and must not straddle a minute.
const ago = (minutes: number) => Date.now() - (minutes + 0.5) * MIN

function same(scene: SheetScene) {
  const { old, react } = bothSheets(scene)
  expect(react).toBe(old)
}

const ready = (
  data: Omit<SessionDetail, 'item'> & { item: Item },
  fields: Partial<DetailValue<SessionDetail>> = {},
) => ({
  key: data.item.key,
  data,
  status: 'ready' as const,
  error: '',
  at: ago(3),
  ...fields,
})

const UPLOADS = 'C:\\Users\\me\\AppData\\Local\\herdr\\plugins\\agent-board\\uploads\\2026-10-17'
const CONVERSATION: ConversationTurn[] = [
  { role: 'user', text: `Fix the **login**, see ${UPLOADS}\\shot.png and \`src/app.ts\``, at: ago(30) },
  { role: 'tool', label: 'Read', detail: 'src/app.ts', path: 'src/app.ts', done: true, at: ago(29) },
  { role: 'tool', label: 'Edit', detail: 'src/app.ts', path: 'src/app.ts', done: true, at: ago(28) },
  {
    role: 'assistant',
    text: '## Done\n\n- one\n- two <b>not bold</b>\n\n| a | b |\n|---|--:|\n| 1 | 2 |',
    at: ago(27),
  },
  {
    role: 'tool',
    label: 'Ask',
    detail: '',
    path: '',
    done: true,
    at: ago(26),
    ask: [
      { question: 'Which one?', header: 'Pick', multiSelect: false },
      { question: 'And then?', header: '', multiSelect: true },
    ],
    answers: ['Alpha', 'Beta, Gamma'],
  },
  {
    role: 'tool',
    label: 'Ask',
    detail: '',
    path: '',
    done: true,
    at: ago(25),
    ask: [{ question: 'Gone?', header: '', multiSelect: false }],
    answers: null,
  },
  { role: 'tool', label: 'Bash', detail: 'bun test', path: '', done: true, at: ago(2) },
  { role: 'tool', label: 'Grep', detail: 'login', path: '', done: false, at: ago(1) },
]

const working = item({
  key: 'a',
  name: 'Alpha',
  autoName: 'alpha-auto',
  status: 'working',
  column: 'work',
  category: 'proj',
  workspace: 'web',
  activity: ago(5),
  context: 85_400,
  contextPct: 42.4,
  doing: 'the **login** form',
  wait: '',
})

const detailOf = (it: Item, fields: Partial<SessionDetail> = {}): SessionDetail => ({
  item: it,
  conversation: [],
  screen: '',
  dialog: null,
  checkout: false,
  ...fields,
})

describe('session sheet markup parity', () => {
  test('the page as it starts: no session open yet, connected or not', () => {
    same({ items: [working], open: null })
    same({ items: [working], open: null, connected: false })
    same({ lang: 'ru', items: [working], open: null, stale: true })
  })

  test('just opened: the head, the card fields, the conversation loading', () => {
    same({ items: [working], open: 'a' })
    same({ lang: 'ru', items: [working], open: 'a' })
    same({ items: [working], open: 'a', detail: { key: 'a', data: null, status: 'loading', error: '', at: null } })
  })

  test('a conversation: bubbles in Markdown with previews, folds of tool calls (one live), asked forms; Changes in git', () => {
    const detail = ready(detailOf(working, { conversation: CONVERSATION, checkout: true }))
    same({ items: [working], open: 'a', detail })
    same({ lang: 'ru', items: [working], open: 'a', detail })
    // Done now: no fold is live; an empty conversation says so.
    const done = { ...working, status: 'done' as const, column: 'done' as const, result: 'Fixed' }
    same({ items: [done], open: 'a', detail: ready(detailOf(done, { conversation: CONVERSATION })) })
    same({ items: [done], open: 'a', detail: ready(detailOf(done)) })
  })

  test('under "Needs me": why, what it asks and the wave-off; the terminal screen; a session held at a dialog cannot sleep', () => {
    const asking = item({
      key: 'b',
      name: 'Beta',
      status: 'blocked',
      column: 'me',
      attention: 'ask',
      question: 'Ship it <now>?',
      activity: ago(1),
    })
    const screen = 'Do you want to proceed?\n❯ 1. Yes\n  2. No'
    const detail = ready(detailOf(asking, { screen }))
    same({ items: [asking], open: 'b', detail })
    same({ items: [asking], open: 'b', detail, lang: 'ru' })
    same({ items: [{ ...asking, attention: 'later' }], open: 'b', detail })
    same({ items: [{ ...asking, attention: 'decision', status: 'idle' }], open: 'b', detail: ready(detailOf(asking)) })
    // A form to answer here: it takes the question's place, the screen folds away under it.
    same({ items: [asking], open: 'b', detail, formHtml: '<b>Pick one</b>' })
    same({ items: [asking], open: 'b', detail: ready(detailOf(asking)), formHtml: '<b>Pick one</b>' })
    same({ items: [{ ...asking, column: 'work', status: 'working' }], open: 'b', detail, formHtml: '<i>prompt</i>' })
  })

  test('asleep: the pill says so, Wake shows and sleep goes; no Claude session: no history, no sleep', () => {
    const asleep = item({
      key: 'c',
      name: 'Gamma',
      status: 'sleeping',
      column: 'idle',
      sleeping: true,
      activity: ago(90),
    })
    same({ items: [asleep], open: 'c', detail: ready(detailOf(asleep)) })
    const other = item({ key: 'd', name: 'Delta', session: null, agent: 'codex', status: 'idle', column: 'idle' })
    same({ items: [other], open: 'd', detail: ready(detailOf(other)) })
  })

  test('the Terminal button: a dot while the board has a shell open; none where it offers no terminal, or nothing to open one in', () => {
    const open = bothSheets({ items: [working], open: 'a', detail: ready(detailOf(working)), shells: ['a'] })
    expect(open.react).toBe(open.old)
    expect(open.react).toContain('class="button has-shell" id="sheet-term"')
    same({ items: [working], open: 'a', detail: ready(detailOf(working)), shells: ['b'], terminal: true })
    same({ items: [working], open: 'a', detail: ready(detailOf(working)), terminal: false })
    const nowhere = item({ key: 'e', name: 'Epsilon', cwd: '', pane: null })
    same({ items: [nowhere], open: 'e', detail: ready(detailOf(nowhere)) })
    same({ items: [working], open: 'a', detail: ready(detailOf(working)), shells: ['a'], lang: 'ru' })
  })

  test('Call in MokuPilot: with MokuPilot here, for a Claude session; it waits for the board, not for herdr', () => {
    const claude = { ...working, agent: 'claude', session: '0b3f8c2e-5d1a-4c6b-9e7f-1a2b3c4d5e6f' }
    const on = bothSheets({ items: [claude], open: 'a', detail: ready(detailOf(claude)), mokupilot: true })
    expect(on.react).toBe(on.old)
    expect(on.react).toContain('id="sheet-mokupilot" title="Start a MokuPilot call')
    same({ items: [claude], open: 'a', detail: ready(detailOf(claude)), mokupilot: true, stale: true })
    same({ items: [claude], open: 'a', detail: ready(detailOf(claude)), mokupilot: true, connected: false })
    same({ items: [claude], open: 'a', detail: ready(detailOf(claude)), mokupilot: true, lang: 'ru' })
    same({ items: [claude], open: 'a', detail: ready(detailOf(claude)), mokupilot: false })
    same({ items: [{ ...claude, agent: 'codex' }], open: 'a', detail: ready(detailOf(claude)), mokupilot: true })
    same({ items: [], open: 'a', selected: claude, detail: ready(detailOf(claude)), mokupilot: true })
  })

  test('Restart (#51): for an awake Claude session in herdr, also mid-turn; gray while one is on its way, its title how it stands; and its row', () => {
    const claude = { ...working, agent: 'claude', session: '0b3f8c2e-5d1a-4c6b-9e7f-1a2b3c4d5e6f' }
    const at = (fields: Partial<ScheduleEntry> = {}): ScheduleEntry[] => [
      { id: 'r1', key: 'a', kind: 'restart', idle: true, by: 'agent', text: '', next: Date.now() - MIN, ...fields },
    ]
    const shown = bothSheets({ items: [claude], open: 'a', detail: ready(detailOf(claude)) })
    expect(shown.react).toBe(shown.old)
    expect(shown.react).toContain('id="sheet-restart" title="Once the session is free')
    for (const schedules of [
      at(),
      at({ why: 'tasks', pendingSince: Date.now() }),
      at({ why: 'draft' }),
      at({ why: 'gone' }),
      at({ why: 'Could not put Alpha to sleep: it is busy', attempts: 1 }),
      at({ step: 'sleep' }),
      at({ step: 'wake', text: 'go on with the review' }),
      at({ step: 'note' }),
      at({ failed: 'herdr-wake is down', text: 'the note' }),
      [...at({ text: 'my <note>' }), { id: 's1', key: 'a', text: 'later', next: Date.now() + 60 * MIN }],
    ]) {
      same({ items: [claude], open: 'a', detail: ready(detailOf(claude)), schedules })
      same({ items: [claude], open: 'a', detail: ready(detailOf(claude)), schedules, lang: 'ru' })
    }
    same({ items: [claude], open: 'a', detail: ready(detailOf(claude)), schedules: at(), armed: 'r1' })
    same({ items: [claude], open: 'a', detail: ready(detailOf(claude)), stale: true })
    same({ items: [claude], open: 'a', detail: ready(detailOf(claude)), connected: false, schedules: at() })
    same({
      items: [{ ...claude, status: 'idle', column: 'idle', sleeping: true }],
      open: 'a',
      detail: ready(detailOf(claude)),
    })
    same({ items: [{ ...claude, agent: 'codex' }], open: 'a', detail: ready(detailOf(claude)) })
    same({ items: [], open: 'a', selected: claude, detail: ready(detailOf(claude)), schedules: at() })
  })

  test('a session gone from the board: the pill and the note say so, every session action stops', () => {
    const detail = ready(detailOf(working, { conversation: CONVERSATION.slice(0, 1), checkout: true }), {
      status: 'missing',
    })
    same({ items: [], open: 'a', selected: working, detail })
    same({ items: [], open: 'a', selected: working, detail, lang: 'ru' })
    // Off the board while its last detail still reads fine.
    same({ items: [], open: 'a', selected: working, detail: ready(detailOf(working)) })
  })

  test('the note over the conversation: an error, out of date, refreshing; Retry while it can ask', () => {
    const data = detailOf(working, { conversation: CONVERSATION.slice(0, 2) })
    same({ items: [working], open: 'a', detail: ready(data, { status: 'error', error: 'offline <x>' }) })
    same({
      items: [working],
      open: 'a',
      detail: { key: 'a', data: null, status: 'error', error: 'Request timed out', at: null },
    })
    same({ items: [working], open: 'a', detail: ready(data), stale: true })
    same({ items: [working], open: 'a', detail: ready(data), connected: false })
    same({ items: [working], open: 'a', detail: ready(data, { status: 'loading' }) })
    same({ lang: 'ru', items: [working], open: 'a', detail: ready(data, { status: 'loading' }) })
  })

  test('the reminders: the first three (due, repeating, when free, one asking "Cancel?") and the rest in the panel', () => {
    const now = Date.now()
    const schedules: ScheduleEntry[] = [
      { id: 's1', key: 'a', text: 'check the **build**', next: now - 60 * MIN },
      { id: 's2', key: 'a', text: 'every hour', next: now + 30 * MIN, cron: '0 * * * *' },
      { id: 's3', key: 'a', text: 'when free', next: now + 26 * 60 * MIN, idle: true },
      { id: 's4', key: 'a', text: 'fourth', next: now + 50 * 60 * MIN },
      { id: 's5', key: 'a', text: 'fifth', next: now + 70 * 60 * MIN },
      { id: 'x', key: 'b', text: 'not this one', next: now },
    ]
    same({ items: [working], open: 'a', schedules, armed: 's2' })
    same({ lang: 'ru', items: [working], open: 'a', schedules: schedules.slice(1, 3) })
    same({ items: [working], open: 'a', schedules, connected: false })
    // A MokuPilot call's results on their way to the session: by their title.
    const call: ScheduleEntry = {
      id: 'c1',
      key: 'a',
      kind: 'call',
      idle: true,
      text: '# Release **call**\n\n- ship',
      next: now,
    }
    const withCall = bothSheets({ items: [working], open: 'a', schedules: [call, ...schedules.slice(0, 2)] })
    expect(withCall.react).toBe(withCall.old)
    expect(withCall.react).toContain('MokuPilot call results: Release call')
    same({ lang: 'ru', items: [working], open: 'a', schedules: [call] })
  })

  test('the message box: the draft, files uploading, uploaded and failed; a message on its way', () => {
    const files: Attachment[] = [
      {
        id: 1,
        name: 'shot.png',
        size: 2048,
        image: true,
        url: 'blob:x/1',
        status: 'done',
        path: `${UPLOADS}\\shot.png`,
      },
      { id: 2, name: 'notes "v2".txt', size: 512, image: false, url: '', status: 'uploading', path: '' },
      { id: 3, name: 'big.zip', size: 3 * (1 << 20), image: false, url: '', status: 'error', path: '' },
    ]
    const detail = ready(detailOf(working))
    same({ items: [working], open: 'a', detail, message: 'Hello <there>\nsecond line', attachments: files })
    same({ items: [working], open: 'a', detail, attachments: files.slice(0, 1) })
    same({ items: [working], open: 'a', detail, message: 'hi', sending: ['a'] })
    same({ items: [working], open: 'a', detail, message: '   ' })
    same({ lang: 'ru', items: [working], open: 'a', detail, attachments: files })
  })
})

describe('text that runs inline keeps its spaces', () => {
  const spaced = (nodes: Node[], match: Parameters<typeof findAll>[1]) =>
    findAll(nodes, match).map(el => canonical([el], { spaces: true }))
  const parts = (el: { attrs: Map<string, string> }) => ['sheet-detail-state'].includes(el.attrs.get('id') ?? '')
  const classes = ['asked', 'sched-mini', 'thread', 'att-text', 'sched-more']
  const inline = (el: Parameters<typeof hasClass>[0]) => parts(el) || classes.some(c => hasClass(el, c))

  test('the note, what it asks, the reminders, the conversation, the files', () => {
    const asking = item({ key: 'b', name: 'Beta', status: 'blocked', column: 'me', attention: 'ask', question: 'Go?' })
    const schedules: ScheduleEntry[] = [1, 2, 3, 4].map(n => ({
      id: `s${n}`,
      key: 'b',
      text: `reminder ${n}`,
      next: Date.now() + n * MIN,
    }))
    const files: Attachment[] = [
      { id: 1, name: 'a b.txt', size: 10, image: false, url: '', status: 'done', path: '/u/a' },
    ]
    const sides = drawSheet({
      items: [asking],
      open: 'b',
      detail: ready(detailOf(asking, { conversation: CONVERSATION }), { status: 'loading' }),
      schedules,
      attachments: files,
    })
    const old = [...spaced(sides.oldSchedule, inline), ...spaced(sides.oldBody, inline)]
    const react = [...spaced(sides.reactSchedule, inline), ...spaced(sides.reactBody, inline)]
    // Three reminders and "+1 more", the note, what it asks, the conversation, a file.
    expect(old.length).toBe(8)
    expect(react).toEqual(old)
  })
})

describe('the workspace’s name in the head', () => {
  const head = (onRenameWorkspace?: (name: HTMLElement) => void, lang = 'en') =>
    renderInBoard(
      <SheetHead item={working} missing={false} onRenameWorkspace={onRenameWorkspace} />,
      board({ data: payload({ items: [working], categories: CATEGORIES }), ui: { open: 'a' } }),
      lang,
    )

  test('where the page renames workspaces, the name alone is a button, in the line’s own words', () => {
    const meta = byId(
      head(() => {}),
      'sheet-meta',
    )
    expect(canonical([byId([meta], 'sheet-workspace')])).toBe(
      '<button class="sheet-workspace" id="sheet-workspace" title="Rename workspace…" type="button">web</button>',
    )
    expect(canonical(findAll([meta], el => el.tag === 'span').slice(0, 1), { spaces: true })).toBe(
      [
        '<span>',
        '  workspace ',
        '  <button class="sheet-workspace" id="sheet-workspace" title="Rename workspace…" type="button">web</button>',
        '</span>',
      ].join('\n'),
    )
    expect(
      byId(
        head(() => {}, 'ru'),
        'sheet-workspace',
      ).attrs.get('title'),
    ).toBe('Переименовать workspace…')
  })

  test('without a way to rename it, the line is as it was', () => {
    const meta = byId(head(), 'sheet-meta')
    expect(findAll([meta], el => el.tag === 'button')).toEqual([])
    expect(canonical(findAll([meta], el => el.tag === 'span').slice(0, 1))).toBe('<span>workspace web</span>')
  })
})

describe('the mounted sheet', () => {
  const VP = { w: 1600, h: 1000 }
  /** What comes in .sheet-inner: the head's title (with a session, its reminders' row), and the rest under the head. */
  function inner(nodes: Node[], session: boolean): string {
    const aside = byId(nodes, 'sheet')
    const { title, body, schedule } = sheetParts(aside)
    return `${canonical(session ? schedule : [title])}\n${canonical(body)}`
  }
  const mounted = (open: string | null, data = payload({ items: [working], categories: CATEGORIES })) =>
    renderInBoard(
      <PanelProvider viewport={() => VP}>
        <Sheet />
      </PanelProvider>,
      board({ data, ui: { open } }),
    )

  test('before any session opened, as the page starts', () => {
    const data = payload({ items: [working], categories: CATEGORIES })
    expect(inner(mounted(null, data), false)).toBe(inner([oldSheet({ data, open: null })], false))
  })

  test('on its first draw for a session, its detail not asked for yet', () => {
    const data = payload({ items: [working], categories: CATEGORIES })
    const react = mounted('a', data)
    expect(inner(react, true)).toBe(
      inner(
        [oldSheet({ data, open: 'a', detail: { key: 'a', data: null, status: 'idle', error: '', at: null } })],
        true,
      ),
    )
    // The head's title is #62's: the card's fields in it, nothing of them under it.
    expect(findAll(byClass(react, 'sheet-title').children, el => el.attrs.get('id') === 'sheet-card').length).toBe(1)
    const aside = byId(react, 'sheet')
    expect(hasClass(aside, 'sheet')).toBe(true)
    expect(find([aside], el => el.attrs.get('id') === 'sheet-close').tag).toBe('button')
  })

  test('the slot for a question form fills #sheet-question in place of what the session asks', () => {
    const asking = item({ key: 'b', status: 'blocked', column: 'me', attention: 'ask', question: 'Go?' })
    const react = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <Sheet question={it => (it.key === 'b' ? <form className="qa-form">answer</form> : null)} />
      </PanelProvider>,
      board({ data: payload({ items: [asking] }), ui: { open: 'b' } }),
    )
    const box = byId(react, 'sheet-question')
    expect(canonical([box])).toBe(
      '<div class="sheet-question" id="sheet-question">\n  <form class="qa-form">answer</form>\n</div>',
    )
    const none = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <Sheet question={() => null} />
      </PanelProvider>,
      board({ data: payload({ items: [asking] }), ui: { open: 'b' } }),
    )
    expect(byClass([byId(none, 'sheet-question')], 'asked').tag).toBe('div')
  })

  test('the texts come in the page’s language', () => {
    const t = translator('ru')
    const react = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <Sheet />
      </PanelProvider>,
      board({ data: payload({ items: [working], lang: 'ru' }), ui: { open: 'a' } }),
      'ru',
    )
    expect(canonical([byId(react, 'sheet-focus')])).toContain(t('sheet.focus'))
  })
})

describe('the compact head (#62)', () => {
  const pinned = {
    ...working,
    status: 'idle' as const,
    column: 'ext' as const,
    pin: 'ext' as const,
    auto: 'done' as const,
    wait: 'review "now"',
    title: 'Claude *title*',
    doing: '',
  }
  const head = (
    it: Item | null,
    {
      card = { disabled: false, open: false },
      missing = false,
      lang = 'en',
      moves = [],
      connected = true,
    }: {
      card?: HeadCard
      missing?: boolean
      lang?: string
      moves?: { key: string; cat: string | null; column: ColumnId | null }[]
      connected?: boolean
    } = {},
  ) => {
    const ui = {
      open: it?.key ?? null,
      moves: moves.reduce((all, m) => withMove(all, m.key, { ...m, at: Date.now() }), NO_MOVES),
    }
    const data = payload({ items: it ? [it] : [], categories: CATEGORIES })
    return renderInBoard(<SheetHead item={it} missing={missing} card={card} />, board({ data, connected, ui }), lang)
  }
  const text = (el: Node): string => (el.kind === 'text' ? el.text : el.children.map(text).join(''))

  test('before a session was ever open: the empty places the page starts with', () => {
    expect(canonical(head(null))).toBe(
      [
        '<span class="status-pill" id="sheet-status"></span>',
        '<h2 id="sheet-name" tabindex="0"></h2>',
        '<p class="sheet-meta" id="sheet-meta"></p>',
      ].join('\n'),
    )
  })

  test('where it shows and its lane are pills whose choices open in a menu; the lane leaves the line under the name', () => {
    const nodes = head(working, { card: { disabled: false, open: false, pickOpen: 'category' } })
    const status = byId(nodes, 'sheet-status')
    expect([status.tag, status.attrs.get('aria-haspopup'), status.attrs.get('aria-expanded')]).toEqual([
      'button',
      'menu',
      'false',
    ])
    expect(text(status)).toBe('Working')
    expect(byClass([status], 'dot').attrs.get('class')).toBe('dot work')
    const lane = byId(nodes, 'sheet-lane')
    expect([lane.tag, lane.attrs.get('aria-haspopup'), lane.attrs.get('aria-expanded')]).toEqual([
      'button',
      'menu',
      'true',
    ])
    expect(text(lane)).toBe('Project')
    expect(lane.attrs.get('style')).toContain('--lane:#007AFF')
    expect(text(byId(nodes, 'sheet-meta'))).toBe('workspace web · active 5 min ago · context 42% · 85k')
    // The separators are spans of their own: a narrow column stacks the facts without them.
    expect(findAll([byId(nodes, 'sheet-meta')], el => hasClass(el, 'sep')).map(text)).toEqual([' · ', ' · '])
    // In Russian, with the pills' names.
    const ru = head(working, { lang: 'ru' })
    expect(byId(ru, 'sheet-lane').attrs.get('title')).toBe('Перенести в категорию')
    expect(byId(ru, 'sheet-status').attrs.get('title')).toBe('Статус')
  })

  test('a move shows on the pills at once, as it did on the chips', () => {
    const nodes = head(pinned, { moves: [{ key: 'a', cat: 'other', column: 'me' }] })
    expect(text(byId(nodes, 'sheet-status'))).toBe('Needs me')
    expect(byClass([byId(nodes, 'sheet-status')], 'dot').attrs.get('class')).toBe('dot me')
    expect(text(byId(nodes, 'sheet-lane'))).toBe('Other')
  })

  test('asleep, the pill says so; gone from the board, it is no button; without the board, the pills open nothing', () => {
    const asleep = byId(head({ ...working, sleeping: true }), 'sheet-status')
    expect([asleep.tag, text(asleep)]).toEqual(['button', 'Asleep'])
    const gone = head(working, { missing: true })
    expect([byId(gone, 'sheet-status').tag, text(byId(gone, 'sheet-status'))]).toEqual(['span', 'Session unavailable'])
    expect(byId(gone, 'sheet-lane').attrs.has('disabled')).toBe(true)
    const offline = head(working, { card: { disabled: true, open: false } })
    expect(byId(offline, 'sheet-status').attrs.has('disabled')).toBe(true)
    expect(byId(offline, 'sheet-lane').attrs.has('disabled')).toBe(true)
    expect(byId(offline, 'doing').attrs.has('disabled')).toBe(true)
  })

  test('the card’s fields show when they say something; the pencil shows the empty ones to fill', () => {
    const doing = head(working)
    // A field that wraps when long (three lines, then it scrolls), the whole value in its tooltip.
    const field = byId(doing, 'doing')
    expect([field.tag, field.attrs.get('rows'), text(field), field.attrs.get('title')]).toEqual([
      'textarea',
      '1',
      'the **login** form',
      'the **login** form',
    ])
    expect(findAll(doing, el => el.attrs.get('id') === 'wait')).toEqual([])
    const toggle = byId(doing, 'sheet-properties-toggle')
    expect([toggle.attrs.get('aria-expanded'), toggle.attrs.get('aria-controls'), toggle.attrs.get('title')]).toEqual([
      'false',
      'sheet-card',
      'Card details',
    ])
    const waits = head(pinned)
    expect(findAll(waits, el => el.attrs.get('id') === 'doing')).toEqual([])
    expect(text(byId(waits, 'wait'))).toBe('review "now"')
    // Opened: both, the empty one with its hint (what it does: Claude's title for it, in plain words).
    const opened = head(pinned, { card: { disabled: false, open: true } })
    expect(byId(opened, 'sheet-properties-toggle').attrs.get('aria-expanded')).toBe('true')
    expect(byId(opened, 'doing').attrs.get('placeholder')).toBe('Claude title')
    expect(byId(opened, 'doing').attrs.has('title')).toBe(false)
    expect(text(byId(opened, 'wait'))).toBe('review "now"')
    // Nothing to say: the fields' place folds away; the pencil or a reminder brings it back.
    const quiet = { ...working, doing: '' }
    expect(byId(head(quiet), 'sheet-card').attrs.has('hidden')).toBe(true)
    expect(byId(head(quiet, { card: { disabled: false, open: true } }), 'sheet-card').attrs.has('hidden')).toBe(false)
    const reminded = renderInBoard(
      <SheetHead item={quiet} missing={false} card={{ disabled: false, open: false }} />,
      board({
        data: payload({ items: [quiet], schedules: [{ id: 's1', key: 'a', text: 'check', next: Date.now() }] }),
        ui: { open: 'a' },
      }),
    )
    expect(byId(reminded, 'sheet-card').attrs.has('hidden')).toBe(false)
    expect(findAll(reminded, el => hasClass(el, 'sched-row')).length).toBe(1)
  })

  test("a phone's fold line opens the fields as the pencil does, and says the pencil's words with none (#105)", () => {
    const fold = (nodes: Node[]) => findAll(nodes, el => hasClass(el, 'sheet-fold'))[0]
    const folded = head(working)
    const line = fold(folded)
    expect([line ? text(line) : '', line?.attrs.get('aria-expanded'), line?.attrs.get('aria-controls')]).toEqual([
      'Doingthe **login** form',
      'false',
      'sheet-card',
    ])
    expect(byId(folded, 'sheet-card').attrs.has('data-folded')).toBe(true)
    const opened = head(working, { card: { disabled: false, open: true } })
    expect(fold(opened)?.attrs.get('aria-expanded')).toBe('true')
    expect(byId(opened, 'sheet-card').attrs.has('data-folded')).toBe(false)
    // Nothing to say: the line is the pencil's own, the place it opens holds the empty fields to fill.
    const none = fold(head({ ...working, doing: '' }))
    expect(none ? text(none) : '').toBe('Card details')
  })
})
