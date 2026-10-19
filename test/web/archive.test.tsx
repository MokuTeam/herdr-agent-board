// The archive on the web board (upstream's #56, 2b9e6b7): the panel's markup against upstream's
// own archiveRowHTML and renderArchive (web/app.js at the merge, run with its own helpers), in
// English and Russian; its aside's shell against web/index.html there; the profile tag a row
// carries with more than one profile shown; the board without the cards on their way to the
// archive (upstream's visibleItems); the launch card of a Return and its Retry (upstream's
// launch.js); the toast with Return; and the pure parts: the page state (board-ui.ts), what the
// toasts say and for how long (models/archive-view.ts), Ctrl+Z (models/board-keys.ts), the
// archive's API as the page reads it (api/client.ts).
import { afterEach, describe, expect, test } from 'bun:test'
import type { PublicArchiveRecord } from '../../src/core/archive.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardCategory, BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import type { Item, LaunchView, Translator } from '../../src/core/types.ts'
import { archiveApi } from '../../web/src/api/client.ts'
import { ArchiveBody, type ArchiveBodyProps, ArchivePanel } from '../../web/src/components/archive/ArchivePanel.tsx'
import { Toast } from '../../web/src/components/Toast.tsx'
import type { Archive } from '../../web/src/hooks/useArchive.ts'
import { launchSlots, retryLaunch } from '../../web/src/hooks/useLaunch.ts'
import { archivedManyText, archiveNotes, returnedText, returnToastMs } from '../../web/src/models/archive-view.ts'
import { boardKey, type KeyScene } from '../../web/src/models/board-keys.ts'
import { visibleItems } from '../../web/src/models/board-view.ts'
import { placeholderOf, stepText } from '../../web/src/models/launch.ts'
import { ARCHIVING_MS, boardUi, FLY_BACK_MS, initialUi } from '../../web/src/state/board-ui.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { bothBoards } from './support/board-scene.tsx'
import { FakeServer, launchWorld, oldLaunch } from './support/launch-sides.tsx'
import {
  addButtonTypes,
  canonical,
  type Element,
  findAll,
  hasClass,
  type Node,
  OLD_PAGE_ONLY,
  parseHtml,
  reactMarkup,
  stripAttrs,
} from './support/markup.ts'
import { OLD_WHEN, oldCode, oldFunction, oldModule } from './support/old-app.ts'
import { oldSide } from './support/panel-sides.tsx'

const MERGE = '2b9e6b7'
const DAY = 86_400_000
const HOUR = 3_600_000
const OLD_ARCHIVE = await oldModule('web/archive-model.js', MERGE)
const OLD_BASENAME = oldCode('web/launch-model.js', ['baseName'], {}, MERGE)

const CATEGORIES: BoardCategory[] = [
  { id: 'acme', title: 'Acme Corp', color: '#007AFF', colorName: 'blue', paths: [], configured: true, fallback: false },
  { id: 'other', title: 'Other', color: '#8E8E93', colorName: 'gray', paths: [], configured: true, fallback: true },
]

const now = Date.now()
const record = (fields: Partial<PublicArchiveRecord> & Pick<PublicArchiveRecord, 'key'>): PublicArchiveRecord => ({
  session: fields.key,
  name: `Session ${fields.key}`,
  autoName: `auto-${fields.key}`,
  category: 'acme',
  cwd: 'C:\\Clients\\Acme\\billing',
  workspace: '',
  workspaceId: 'w1',
  pane: 'w1:p1',
  tab: 'w1:t1',
  note: '',
  title: `Session ${fields.key}`,
  sleeping: false,
  activity: now - HOUR,
  archivedAt: now - HOUR,
  by: 'user',
  state: 'archived',
  closeAt: now - HOUR,
  held: 0,
  returning: false,
  ...fields,
})

/** Every way a row shows: today, yesterday and older; a note, a title, a workspace, held entries, by an agent; closing, returning, armed. */
const RECORDS: PublicArchiveRecord[] = [
  record({
    key: 'a',
    note: 'PR **merged**, see `ci`',
    workspace: 'Acme',
    held: 2,
    state: 'closing',
    archivedAt: now - 60_000,
  }),
  record({
    key: 'b',
    title: 'Fix the invoices',
    category: 'other',
    cwd: '/srv/web/',
    from: { key: 'x', name: 'Lead' },
  }),
  record({ key: 'c', category: 'gone', cwd: '', returning: true, archivedAt: now - DAY - HOUR }),
  record({
    key: 'd',
    name: 'Probe <one> & "two"',
    held: 1,
    archivedAt: now - 9 * DAY,
    from: { key: 'y', name: 'Helper' },
  }),
  record({ key: 'e', archivedAt: now - 9 * DAY - HOUR }),
]

interface PanelScene {
  lang?: string
  records?: PublicArchiveRecord[]
  query?: string
  sleepy?: number
  returning?: string[]
  armed?: string | null
  canMutate?: boolean
  canEdit?: boolean
}

/** #archive-body as upstream's renderArchive leaves it for the scene. */
function oldBody(s: PanelScene, t: Translator): string {
  const body = { _html: '', _fresh: true, innerHTML: '', querySelectorAll: () => [] }
  const deps: Record<string, unknown> = {
    t,
    state: { data: { categories: CATEGORIES } },
    baseName: OLD_BASENAME.get('baseName'),
    capital: OLD_WHEN.get('capital'),
    longWhen: OLD_WHEN.get('longWhen'),
    timeOf: OLD_WHEN.get('timeOf'),
    dayLabel: OLD_WHEN.get('dayLabel'),
    searchArchive: OLD_ARCHIVE.get('searchArchive'),
    archiveRecords: s.records ?? [],
    archiveReturning: new Set(s.returning ?? []),
    archiveArmed: s.armed ? { key: s.armed } : null,
    archivePanel: { isOpen: true },
    archiveCollapsing: 0,
    archiveBody: body,
    canMutate: () => s.canMutate ?? true,
    canEdit: () => s.canEdit ?? true,
    tidyItems: () => Array.from({ length: s.sleepy ?? 0 }, (_, i) => ({ key: `z${i}` })),
    $: (selector: string) => (selector === '#archive-search' ? { value: s.query ?? '' } : null),
    appear: () => {},
  }
  const code = oldCode(
    'web/app.js',
    ['ICON', 'esc', 'plain', 'catInfo', 'archiveRowHTML', 'renderArchive'],
    deps,
    MERGE,
  )
  oldFunction(code, 'renderArchive')()
  const nodes = parseHtml(body.innerHTML)
  addButtonTypes(nodes)
  return canonical(nodes)
}

function newBody(s: PanelScene, t: Translator, data: BoardPayload = payload({ categories: CATEGORIES })): string {
  const props: ArchiveBodyProps = {
    records: s.records ?? [],
    query: s.query ?? '',
    sleepy: s.query ? 0 : (s.sleepy ?? 0),
    returning: new Set(s.returning ?? []),
    armed: s.armed ?? null,
    canMutate: s.canMutate ?? true,
    canEdit: s.canEdit ?? true,
    categories: CATEGORIES,
    t,
  }
  return canonical(renderInBoard(<ArchiveBody {...props} />, board({ data }), s.lang ?? 'en'))
}

const SCENES: [string, PanelScene][] = [
  ['an empty archive', {}],
  ['an empty archive with sleeping sessions to take', { sleepy: 3 }],
  ['the offer gray without fresh herdr data', { sleepy: 1, canMutate: false, records: RECORDS }],
  ['rows by day, newest first: notes, titles, workspaces, held entries, who archived it', { records: RECORDS }],
  [
    'a Return on its way from this page; a trash can asking "Remove?"',
    { records: RECORDS, returning: ['b'], armed: 'd' },
  ],
  ['offline: no Remove', { records: RECORDS, canEdit: false, canMutate: false, armed: 'a' }],
  ['a search by lane title: no offer while searching', { records: RECORDS, query: 'acme corp', sleepy: 2 }],
  ['a search by every word, the folder and the note', { records: RECORDS, query: 'billing MERGED' }],
  ['a search that finds none', { records: RECORDS, query: 'nothing here' }],
]

describe.each(['en', 'ru'])('the archive’s panel in %s', lang => {
  const t = translator(lang)
  for (const [name, s] of SCENES)
    test(`#archive-body is upstream’s renderArchive: ${name}`, () => {
      expect(newBody({ ...s, lang }, t)).toBe(oldBody(s, t))
    })

  test('its aside is upstream’s web/index.html, made a panel: grip, head, the search, the body', async () => {
    const side = await oldSide({ viewport: { w: 1600, h: 1000 }, ids: ['archive-sheet'], lang })
    let old: Node[]
    try {
      old = [parseHtml(canonical([side.aside('archive-sheet').node]))[0] as Node]
    } finally {
      side.dispose()
    }
    stripAttrs(old, OLD_PAGE_ONLY)
    addButtonTypes(old)
    const react = renderInBoard(
      <PanelProvider viewport={() => ({ w: 1600, h: 1000 })}>
        <ArchivePanel archive={RESTING} />
      </PanelProvider>,
      board(),
      lang,
    )
    // The search field: the React input is controlled (its value reflected), the old page's was not.
    for (const input of findAll(old, el => el.attrs.get('id') === 'archive-search')) input.attrs.set('value', '')
    expect(canonical(react)).toBe(canonical(old))
  })
})

/** The archive as the page starts: its panel never opened. */
const RESTING: Archive = {
  async archiveSession() {},
  async archiveMany() {},
  async returnSessions() {},
  tidyItems: () => [],
  canUndo: () => false,
  undo() {},
  panel: { open: false, records: [], returning: new Set(), armed: null, query: '', opened: 0 },
  openPanel() {},
  closePanel() {},
  togglePanel() {},
  setQuery() {},
  async remove() {},
  disarm() {},
}

describe('a row with more than one profile shown', () => {
  const t = translator('en')
  const profile = (id: string, hidden = false): BoardProfile => ({
    id,
    title: id === 'work' ? 'Work' : 'Default',
    color: id === 'work' ? '#30B0C7' : '#5856D6',
    colorName: id === 'work' ? 'teal' : 'indigo',
    inherited: id !== 'work',
    dir: `C:\\Users\\me\\.claude-${id}`,
    hidden,
    exists: true,
    hooks: true,
    sessions: 1,
    limits: null,
  })
  const tags = (data: BoardPayload, r: PublicArchiveRecord, picked = 'all') =>
    findAll(renderInBoard(<ArchiveBody {...props(r)} />, board({ data, ui: { profile: picked } }), 'en'), el =>
      hasClass(el, 'profile-tag'),
    )
  const props = (r: PublicArchiveRecord): ArchiveBodyProps => ({
    records: [r],
    query: '',
    sleepy: 0,
    returning: new Set(),
    armed: null,
    canMutate: true,
    canEdit: true,
    categories: CATEGORIES,
    t,
  })

  test('carries its session’s profile tag after the name, as its card did', () => {
    const data = payload({ categories: CATEGORIES, profiles: [profile('default'), profile('work')] })
    const [tag] = tags(data, record({ key: 'a', profile: 'work' }))
    expect(tag?.children.map(c => (c.kind === 'text' ? c.text : '')).join('')).toBe('Work')
    const top = findAll(
      renderInBoard(<ArchiveBody {...props(record({ key: 'a', profile: 'work' }))} />, board({ data })),
      el => hasClass(el, 'arch-top'),
    )[0] as Element
    expect(top.children.map(c => (c.kind === 'element' ? c.attrs.get('class') : ''))).toEqual([
      'arch-name',
      'profile-tag profile',
      'arch-when',
    ])
  })

  test('whatever the profile switch picks: the archive lists every profile’s sessions', () => {
    const data = payload({ categories: CATEGORIES, profiles: [profile('default'), profile('work')] })
    for (const [picked, id, title] of [
      ['work', 'default', 'Default'],
      ['work', 'work', 'Work'],
      ['default', 'work', 'Work'],
    ] as const) {
      const [tag] = tags(data, record({ key: 'a', profile: id }), picked)
      expect(tag?.children.map(c => (c.kind === 'text' ? c.text : '')).join('')).toBe(title)
    }
  })

  test('with one profile, none: the row is upstream’s', () => {
    const data = payload({ categories: CATEGORIES, profiles: [profile('default'), profile('work', true)] })
    expect(tags(data, record({ key: 'a', profile: 'default' }))).toEqual([])
    const r = record({ key: 'a', profile: 'default' })
    expect(newBody({ records: [r] }, t, data)).toBe(oldBody({ records: [r] }, t))
  })
})

describe('the board without the cards on their way to the archive, as upstream’s visibleItems', () => {
  const a = item({ key: 'a', name: 'Alpha', category: 'proj', column: 'idle', agent: 'claude' })
  const b = item({ key: 'b', name: 'Beta', category: 'proj', column: 'done' })
  test('one going: its card is off at once, the counts with it', () => {
    const scene = { items: [a, b], archiving: ['a'], ref: MERGE }
    const { old, react } = bothBoards(scene)
    expect(react).toBe(old)
    expect(react).not.toContain('data-key="a"')
    expect(bothBoards({ ...scene, archiving: [] }).react).toContain('data-key="a"')
  })
  test('visibleItems leaves them out whatever the search', () => {
    const options = { query: '', sleepers: true, categories: [], categoryOf: (it: Item) => it.category }
    expect(visibleItems([a, b], { ...options, archiving: new Map([['a', 1]]) }).map(i => i.key)).toEqual(['b'])
    expect(visibleItems([a, b], options).map(i => i.key)).toEqual(['a', 'b'])
  })
})

describe('the launch card of a Return', () => {
  const launch = (fields: Partial<LaunchView> = {}): LaunchView => ({
    id: 'L1',
    name: 'Probe',
    cwd: 'C:\\Work\\probe',
    category: 'acme',
    workspace: 'Personal',
    workspaceId: 'w2',
    state: 'starting',
    step: 'agent',
    error: '',
    kind: '',
    pane: null,
    key: null,
    startedAt: 1000,
    doneAt: null,
    message: '',
    worktree: null,
    newWorkspace: false,
    resume: 'sess-1',
    ...fields,
  })
  const LAUNCHES = [
    launch(),
    launch({ step: 'tab' }),
    launch({ state: 'waiting', step: 'dialog' }),
    launch({ state: 'failed', error: 'claude exited', kind: 'launcher' }),
    launch({ resume: null }),
  ]
  for (const lang of ['en', 'ru'])
    test(`"back", Claude resuming, as upstream’s launch.js draws it (${lang})`, async () => {
      const t = translator(lang)
      const world = launchWorld()
      const log: string[] = []
      const call = oldLaunch(
        world,
        { t, categories: [], items: [], launches: [], filter: 'all', canMutate: true },
        new FakeServer(log),
        log,
      )
      try {
        const slots = launchSlots({ t, launcher: '', pressed: () => false }, () => false)
        const oldMarkup = (html: unknown) => {
          const nodes = parseHtml(String(html))
          addButtonTypes(nodes)
          return canonical(nodes)
        }
        for (const l of LAUNCHES) {
          expect(canonical(reactMarkup(slots.card(placeholderOf(l))))).toBe(oldMarkup(call('cardHTML', { launch: l })))
          expect(canonical(reactMarkup(slots.note(l)))).toBe(oldMarkup(call('note', l)))
        }
        expect(stepText(launch(), t, '')).toBe(t('archive.step'))
      } finally {
        await world.settle()
        world.uninstall()
      }
    })

  test('Retry on it is its Return again: its card goes, the Return asks anew; a new session’s opens the window', () => {
    const log: string[] = []
    const deps = {
      open: (l: LaunchView) => void log.push(`open(${l.id})`),
      dismiss: (id: string) => void log.push(`dismiss(${id})`),
      onResume: (l: { resume: string }) => void log.push(`resume(${l.resume})`),
    }
    retryLaunch(launch(), null, deps)
    retryLaunch(launch({ resume: null }), null, deps)
    expect(log).toEqual(['dismiss(L1)', 'resume(sess-1)', 'open(L1)'])
  })
})

describe('the toast that offers Return', () => {
  test('its text and its button, as upstream’s toast() builds it; plain ones as before', () => {
    const action = { label: 'Return', run() {} }
    const withAction = reactMarkup(
      <Toast toast={{ id: 1, text: 'Probe went to the archive', error: false, action, ms: 5000 }} onGone={() => {}} />,
    )
    expect(canonical(withAction)).toBe(
      canonical(
        parseHtml(
          '<div class="toast with-action"><span class="toast-text">Probe went to the archive</span><button type="button" class="toast-action">Return</button></div>',
        ),
      ),
    )
    expect(canonical(reactMarkup(<Toast toast={{ id: 2, text: 'Done', error: true }} onGone={() => {}} />))).toBe(
      canonical(parseHtml('<div class="toast error">Done</div>')),
    )
  })

  test('it stays until a little before the pane closes, 2.5 to 7 s', () => {
    expect(returnToastMs(now + 8000, 8000, now)).toBe(6800)
    expect(returnToastMs(now + 30_000, 8000, now)).toBe(7000)
    expect(returnToastMs(now + 1000, 8000, now)).toBe(2500)
    expect(returnToastMs(null, 8000, now)).toBe(6800)
    expect(returnToastMs(undefined, 3000, now)).toBe(2500)
  })
})

describe('the page’s state', () => {
  const ui0 = initialUi((_k, f) => f)
  test('cards on their way to the archive: off at once, back on a refusal, let go once the board has them no more or after 20 s', () => {
    let ui = boardUi(ui0, { type: 'archiving', keys: ['a', 'b'], at: 1000 })
    expect([...ui.archiving.keys()]).toEqual(['a', 'b'])
    ui = boardUi(ui, { type: 'unarchiving', keys: ['b'] })
    expect([...ui.archiving.keys()]).toEqual(['a'])
    expect(boardUi(ui, { type: 'unarchiving', keys: ['zz'] })).toBe(ui)
    const items = [item({ key: 'a' })]
    expect(boardUi(ui, { type: 'settle', items, now: 1000 + ARCHIVING_MS }).archiving.has('a')).toBe(true)
    expect(boardUi(ui, { type: 'settle', items, now: 1001 + ARCHIVING_MS }).archiving.has('a')).toBe(false)
    expect(boardUi(ui, { type: 'settle', items: [], now: 1001 }).archiving.size).toBe(0)
  })

  test('cards back from the archive: awaited 90 s, each once', () => {
    let ui = boardUi(ui0, { type: 'flyBack', keys: ['a', 'launch:L1'], at: 1000 })
    expect(boardUi(ui, { type: 'settle', items: [], now: 1000 + FLY_BACK_MS }).flyBack.size).toBe(2)
    expect(boardUi(ui, { type: 'settle', items: [], now: 1001 + FLY_BACK_MS }).flyBack.size).toBe(0)
    ui = boardUi(ui, { type: 'flewBack', key: 'a' })
    expect([...ui.flyBack.keys()]).toEqual(['launch:L1'])
    expect(boardUi(ui, { type: 'flewBack', key: 'a' })).toBe(ui)
  })

  test('a toast with an action and a duration; its token hides it early, once', () => {
    const run = () => {}
    let ui = boardUi(ui0, {
      type: 'toast',
      text: 'gone',
      error: false,
      action: { label: 'Return', run },
      ms: 4000,
      token: 7,
    })
    ui = boardUi(ui, { type: 'toast', text: 'plain', error: false })
    expect(ui.toasts).toEqual([
      { id: 1, text: 'gone', error: false, action: { label: 'Return', run }, ms: 4000, token: 7 },
      { id: 2, text: 'plain', error: false },
    ])
    const hidden = boardUi(ui, { type: 'toastHide', token: 7 })
    expect(hidden.toasts[0]?.hiding).toBe(true)
    expect(boardUi(hidden, { type: 'toastHide', token: 7 })).toBe(hidden)
    expect(boardUi(ui, { type: 'toastHide', token: 99 })).toBe(ui)
  })
})

describe('what the toasts say', () => {
  const t = translator('en')
  test('a tidy-up, one or many; a Return, put back or resumed', () => {
    expect(archivedManyText([{ name: 'Probe' }], t)).toBe(t('archive.done', { name: 'Probe' }))
    expect(archivedManyText([{ name: 'a' }, { name: 'b' }], t)).toBe(t('archive.doneMany', { n: 2 }))
    const nameOf = (key: string) => (key === 'k' ? 'From the board' : undefined)
    expect(returnedText([{ key: 'k', name: 'Probe', back: true }], nameOf, t)).toBe(
      t('archive.back', { name: 'Probe' }),
    )
    expect(returnedText([{ key: 'k', name: '', resume: true }], nameOf, t)).toBe(
      t('archive.resuming', { name: 'From the board' }),
    )
    expect(returnedText([{ key: 'z', name: '', again: true }], nameOf, t)).toBe(
      t('archive.resuming', { name: t('session') }),
    )
    expect(
      returnedText(
        [
          { key: 'a', name: 'a' },
          { key: 'b', name: 'b', resume: true },
        ],
        nameOf,
        t,
      ),
    ).toBe(t('archive.resumingMany', { n: 2 }))
    expect(
      returnedText(
        [
          { key: 'a', name: 'a' },
          { key: 'b', name: 'b' },
        ],
        nameOf,
        t,
      ),
    ).toBe(t('archive.backMany', { n: 2 }))
  })

  test('a close the server called off is said once; the first board’s log is old news', () => {
    const kept = { key: 'k', name: 'Probe', at: 5, result: 'kept', why: 'archive.why.working', detail: '' }
    const first = archiveNotes([kept], null, () => undefined, t)
    expect(first.toasts).toEqual([])
    const later = { ...kept, at: 9 }
    const next = archiveNotes(
      [later, kept, { key: 'c', name: 'C', at: 9, result: 'closed' }, 'junk'],
      first.seen,
      () => 'Named',
      t,
    )
    expect(next.toasts).toEqual([
      t('archive.kept', { name: 'Named', why: t('archive.why.working').replace(/^./, c => c.toLowerCase()) }),
    ])
    expect(archiveNotes([later], next.seen, () => undefined, t).toasts).toEqual([])
  })
})

test('Ctrl+Z brings back the archive whose toast still shows; not while typing, nor with Shift or Alt', () => {
  const scene: KeyScene = {
    typing: false,
    inSearch: false,
    panelOpen: false,
    query: '',
    quickLook: false,
    digits: false,
  }
  const z = { key: 'z', shiftKey: false, metaKey: false, ctrlKey: true, altKey: false }
  expect(boardKey(z, { ...scene, undo: true })).toBe('undoArchive')
  expect(boardKey({ ...z, ctrlKey: false, metaKey: true, key: 'Z' }, { ...scene, undo: true })).toBe('undoArchive')
  expect(boardKey(z, scene)).toBe(null)
  expect(boardKey(z, { ...scene, undo: true, typing: true })).toBe(null)
  expect(boardKey({ ...z, shiftKey: true }, { ...scene, undo: true })).toBe(null)
  expect(boardKey({ ...z, altKey: true }, { ...scene, undo: true })).toBe(null)
})

describe('the archive’s API as the page reads it', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })
  const answer = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const fake = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }
    globalThis.fetch = Object.assign(fake, { preconnect: realFetch.preconnect })
    return calls
  }
  const t = translator('en')

  test('GET /api/archive: the records and the undo time, uncached', async () => {
    const calls = answer(200, { records: [record({ key: 'a' })], undoMs: 8000, extra: 1 })
    const r = await archiveApi.list()
    expect(r.records.map(x => x.key)).toEqual(['a'])
    expect(r.undoMs).toBe(8000)
    expect(calls[0]?.init?.cache).toBe('no-store')
  })

  test('POST /api/archive with the board’s header; a 409 keeps what it did and did not do, with the first error', async () => {
    const calls = answer(409, {
      ok: false,
      done: [],
      failed: [{ key: 'a', name: 'A', why: 'archive.why.working', error: 'A is working' }, { nope: 1 }],
      error: 'A is working',
    })
    const r = await archiveApi.post('archive', ['a'], t)
    expect(r).toEqual({
      ok: false,
      done: [],
      failed: [{ key: 'a', name: 'A', why: 'archive.why.working', error: 'A is working' }],
      error: 'A is working',
    })
    expect(calls[0]?.url).toBe('/api/archive')
    expect(new Headers(calls[0]?.init?.headers).get('x-board')).toBe('1')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ op: 'archive', keys: ['a'] })
  })

  test('some done, some not: what was done is read, the rest said', async () => {
    answer(200, {
      ok: false,
      done: [{ key: 'b', ok: true, name: 'B', resume: true, launch: 'L7' }],
      failed: [{ key: 'c', error: 'C is gone' }],
      error: 'C is gone',
    })
    const r = await archiveApi.post('return', ['b', 'c'], t)
    expect(r.ok).toBe(false)
    expect(r.done).toEqual([{ key: 'b', ok: true, name: 'B', resume: true, launch: 'L7' }])
    expect(r.failed.map(f => f.key)).toEqual(['c'])
    answer(200, { ok: true, done: [{ key: 'b', name: 'B', held: 1, closeAt: 5 }], failed: [] })
    expect(await archiveApi.post('archive', ['b'], t)).toEqual({
      ok: true,
      done: [{ key: 'b', name: 'B', held: 1, closeAt: 5 }],
      failed: [],
      error: '',
    })
  })

  test('no answer: offline, nothing done', async () => {
    globalThis.fetch = Object.assign(
      async () => {
        throw new Error('refused')
      },
      { preconnect: realFetch.preconnect },
    )
    expect(await archiveApi.post('remove', ['a'], t)).toEqual({
      ok: false,
      done: [],
      failed: [],
      error: t('err.offline', { why: 'refused' }),
    })
  })
})
