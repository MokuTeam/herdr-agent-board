// The React session sheet against the old page's (at the parity baseline): each scene drawn by
// web/app.js's own sheet code on the #sheet of web/index.html (support/old-sheet.ts) and by
// <SheetHead> and <SheetView> for the same state (support/sheet-scene.tsx) — the head's title, then
// everything under the head. Whitespace between elements is dropped by the comparison; where text
// runs inline, a second comparison keeps it (canonical `spaces`). Then the mounted sheet, as the
// page draws it before any effect ran.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import type { ConversationTurn } from '../../src/core/transcript.ts'
import type { Item } from '../../src/core/types.ts'
import type { SessionDetail } from '../../web/src/api/client.ts'
import { Sheet } from '../../web/src/components/sheet/Sheet.tsx'
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

  test('the card fields: lane and column chips (moves on screen at once), a pin with Auto, the fields and their hints', () => {
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
    same({ items: [pinned], open: 'a', detail: ready(detailOf(pinned)) })
    same({
      items: [pinned],
      open: 'a',
      detail: ready(detailOf(pinned)),
      moves: [{ key: 'a', cat: 'other', column: 'me' }],
    })
    same({ lang: 'ru', items: [pinned], open: 'a', detail: ready(detailOf(pinned)) })
    const unknownLane = { ...working, category: 'gone' }
    same({ items: [unknownLane], open: 'a', categories: CATEGORIES.slice(0, 2) })
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

  test('on a phone the card fields fold behind "Card details"', () => {
    same({ items: [working], open: 'a', narrow: true })
    same({ items: [working], open: 'a', narrow: true, propertiesOpen: true })
    same({ items: [working], open: 'a', propertiesOpen: true })
  })
})

describe('text that runs inline keeps its spaces', () => {
  const spaced = (nodes: Node[], match: Parameters<typeof findAll>[1]) =>
    findAll(nodes, match).map(el => canonical([el], { spaces: true }))
  const parts = (el: { attrs: Map<string, string> }) =>
    ['sheet-status', 'sheet-detail-state', 'cats', 'cols'].includes(el.attrs.get('id') ?? '')
  const classes = ['asked', 'sched-mini', 'thread', 'att-text', 'sched-more']
  const inline = (el: Parameters<typeof hasClass>[0]) => parts(el) || classes.some(c => hasClass(el, c))

  test('the pill, the note, what it asks, the chips, the reminders, the conversation, the files', () => {
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
    const old = [...spaced(sides.oldTitle, inline), ...spaced(sides.oldBody, inline)]
    const react = [...spaced(sides.reactTitle, inline), ...spaced(sides.reactBody, inline)]
    // The pill, the note, the two chip rows, what it asks, three reminders and "+1 more", the conversation, a file.
    expect(old.length).toBe(11)
    expect(react).toEqual(old)
  })
})

describe('the mounted sheet', () => {
  const VP = { w: 1600, h: 1000 }
  /** What comes in .sheet-inner: the head's title, and the rest under the head. */
  function inner(nodes: Node[]): string {
    const aside = byId(nodes, 'sheet')
    const { title, body } = sheetParts(aside)
    return `${canonical([title])}\n${canonical(body)}`
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
    expect(inner(mounted(null, data))).toBe(inner([oldSheet({ data, open: null })]))
  })

  test('on its first draw for a session, its detail not asked for yet', () => {
    const data = payload({ items: [working], categories: CATEGORIES })
    const react = mounted('a', data)
    expect(inner(react)).toBe(
      inner([oldSheet({ data, open: 'a', detail: { key: 'a', data: null, status: 'idle', error: '', at: null } })]),
    )
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
