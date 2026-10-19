// The Profiles panel (Settings → Profiles…), which the old page never had: a row per Claude
// profile (its color, its name to edit, its folder, its sessions now, shown or hidden), then a
// folder a session reported that no profile has, a folder added from somewhere else, and Install
// for a shown profile without the board's hooks. What its rows and buttons send goes to
// POST /api/profiles; what the board refuses is toasted, as in the categories panel.
import { afterEach, expect, spyOn, test } from 'bun:test'
import type { ReactElement } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import type { Item } from '../../src/core/types.ts'
import { ProfileRow } from '../../web/src/components/profiles/ProfileRow.tsx'
import { ProfilesPanel } from '../../web/src/components/profiles/ProfilesPanel.tsx'
import { type ProfileRowView, profileRows, unknownFolders } from '../../web/src/models/profiles.ts'
import type { Board } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { byId, type Element, find, findAll, hasClass, type Node } from './support/markup.ts'
import { first } from './support/react-commit.ts'
import { type Host, hostElements, listenLikeReact } from './support/react-events.ts'

const t = translator('en')
const VP = { w: 1600, h: 1000 }

const profile = (fields: Partial<BoardProfile> & Pick<BoardProfile, 'id' | 'title'>): BoardProfile => ({
  color: '#5856D6',
  colorName: 'indigo',
  dir: `C:\\Users\\me\\.claude-${fields.id}`,
  hidden: false,
  inherited: false,
  exists: true,
  hooks: true,
  sessions: 0,
  limits: null,
  ...fields,
})
const PRIVATE = profile({
  id: 'default',
  title: 'Private',
  dir: 'C:\\Users\\me\\.claude',
  inherited: true,
  sessions: 2,
})
/** Shown, without the board's hooks. */
const WORK = profile({ id: 'work', title: 'Work', color: '#30B0C7', colorName: 'teal', hooks: false, sessions: 1 })
/** Hidden: its settings.json is not read. */
const GAMEDEV = profile({
  id: 'gamedev',
  title: 'Gamedev',
  color: '#FF2D55',
  colorName: 'pink',
  hidden: true,
  hooks: null,
})
/** Shown, its folder deleted since. */
const OLD = profile({ id: 'old', title: 'Old', color: '#A2845E', colorName: 'brown', exists: false, hooks: false })

const FOLDER = 'D:\\old\\.claude-x'
const ITEMS: Item[] = [
  item({ key: 'a', profile: 'default' }),
  item({ key: 'b', profile: 'default' }),
  item({ key: 'c', profile: 'work' }),
  // Folders no profile has: one written two ways, and another.
  item({ key: 'd', profile: null, profileFolder: FOLDER }),
  item({ key: 'e', profile: null, profileFolder: 'd:/OLD/.claude-x/' }),
  item({ key: 'f', profile: null, profileFolder: 'E:\\y\\.claude-y' }),
  // No card yet: no folder.
  item({ key: 'g' }),
]

const dataOf = (profiles: BoardProfile[], items: Item[] = ITEMS, lang: 'en' | 'ru' = 'en'): BoardPayload =>
  payload({ lang, items, profiles })

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))

/** The panel as drawn for a board. */
function panelOf(data: BoardPayload, fields: Partial<Omit<Board, 'ui'>> = {}, lang = 'en'): Element {
  const nodes = renderInBoard(
    <PanelProvider viewport={() => VP}>
      <ProfilesPanel open={false} onClose={() => {}} />
    </PanelProvider>,
    board({ data, ...fields }),
    lang,
  )
  return byId(nodes, 'profiles-sheet')
}

const rowsIn = (panel: Element): Element[] => findAll([panel], el => hasClass(el, 'profile-row'))
const rowIn = (panel: Element, id: string): Element =>
  find([panel], el => hasClass(el, 'profile-row') && el.attrs.get('data-id') === id)

/** A row as drawn: its id, color, name, folder, sessions now, the pressed one of Shown and Hidden, and what it says of its folder. */
function rowText(row: Element) {
  const field = find([row], el => el.tag === 'input')
  const pressed = findAll([row], el => el.tag === 'button' && el.attrs.get('aria-pressed') === 'true')
  const missing = findAll([row], el => hasClass(el, 'profile-missing'))
  return {
    id: row.attrs.get('data-id'),
    style: row.attrs.get('style'),
    name: field.attrs.get('value'),
    folder: textOf(find([row], el => hasClass(el, 'profile-dir'))),
    sessions: textOf(find([row], el => hasClass(el, 'cat-count'))),
    pressed: pressed.map(textOf),
    missing: missing.map(textOf).join(''),
  }
}

/** The Install notes under the rows: the profile each is for, its text and its button. */
const notesIn = (panel: Element) =>
  findAll([panel], el => hasClass(el, 'profile-note')).map(note => ({
    id: note.attrs.get('data-id'),
    text: textOf(find([note], el => el.tag === 'p')),
    button: textOf(find([note], el => el.tag === 'button')),
  }))

/** The buttons that add a folder a session reported. */
const unknownIn = (panel: Element): string[] => findAll([panel], el => hasClass(el, 'profile-unknown')).map(textOf)

test('a row per profile: color, name, folder, sessions now, shown or hidden', () => {
  expect(profileRows([PRIVATE, WORK, GAMEDEV], t)).toEqual([
    {
      id: 'default',
      title: 'Private',
      color: '#5856D6',
      dir: 'C:\\Users\\me\\.claude',
      sessions: '2 sessions now',
      shown: true,
      missing: false,
      noHooks: false,
    },
    {
      id: 'work',
      title: 'Work',
      color: '#30B0C7',
      dir: 'C:\\Users\\me\\.claude-work',
      sessions: '1 session now',
      shown: true,
      missing: false,
      noHooks: true,
    },
    {
      id: 'gamedev',
      title: 'Gamedev',
      color: '#FF2D55',
      dir: 'C:\\Users\\me\\.claude-gamedev',
      sessions: '0 sessions now',
      shown: false,
      missing: false,
      noHooks: false,
    },
  ])

  const panel = panelOf(dataOf([PRIVATE, WORK, GAMEDEV]))
  expect(panel.attrs.get('aria-label')).toBe('Profiles')
  const head = find([panel], el => hasClass(el, 'sheet-title'))
  expect(textOf(find([head], el => el.tag === 'h2'))).toBe('Profiles')
  expect(textOf(find([head], el => hasClass(el, 'sheet-meta')))).toBe(
    'The Claude Code folders the board found (CLAUDE_CONFIG_DIR). A hidden profile is left out of the switch, new sessions and Install.',
  )
  expect(rowsIn(panel).map(rowText)).toEqual([
    {
      id: 'default',
      style: '--lane:#5856D6',
      name: 'Private',
      folder: 'C:\\Users\\me\\.claude',
      sessions: '2 sessions now',
      pressed: ['Shown'],
      missing: '',
    },
    {
      id: 'work',
      style: '--lane:#30B0C7',
      name: 'Work',
      folder: 'C:\\Users\\me\\.claude-work',
      sessions: '1 session now',
      pressed: ['Shown'],
      missing: '',
    },
    {
      id: 'gamedev',
      style: '--lane:#FF2D55',
      name: 'Gamedev',
      folder: 'C:\\Users\\me\\.claude-gamedev',
      sessions: '0 sessions now',
      pressed: ['Hidden'],
      missing: '',
    },
  ])
  // The name is edited; the folder is only read.
  const work = rowIn(panel, 'work')
  expect(findAll([work], el => el.tag === 'input').map(el => el.attrs.get('aria-label'))).toEqual(['Name'])
  expect(find([work], el => hasClass(el, 'profile-dir')).tag).toBe('span')

  // In Russian.
  const ru = panelOf(dataOf([PRIVATE, WORK, GAMEDEV], ITEMS, 'ru'), {}, 'ru')
  expect(rowsIn(ru).map(row => [rowText(row).sessions, rowText(row).pressed])).toEqual([
    ['2 сессии сейчас', ['Показан']],
    ['1 сессия сейчас', ['Показан']],
    ['0 сессий сейчас', ['Скрыт']],
  ])
  expect(ru.attrs.get('aria-label')).toBe('Профили')

  // Without the board its fields and buttons do nothing.
  const off = panelOf(dataOf([PRIVATE, WORK, GAMEDEV]), { connected: false, canEdit: false })
  const controls = findAll([find([off], el => hasClass(el, 'profiles-body'))], el =>
    ['input', 'button'].includes(el.tag),
  )
  expect(controls.length).toBeGreaterThan(8)
  expect(controls.filter(el => !el.attrs.has('disabled'))).toEqual([])
})

// ---------------------------------------------------------------- live, with React's handlers

/**
 * `node` live in a fake DOM with React's handlers on it (support/react-events.ts): the markup React
 * draws, and the props of its host elements from the same tree, its hooks run in a probe inside
 * the page's providers. React draws it once: what its handlers send is what is checked.
 */
function live(node: ReactElement, context: Board) {
  let hosts: Host[] = []
  function Probe() {
    hosts = hostElements(node)
    return null
  }
  renderInBoard(
    <PanelProvider viewport={() => VP}>
      <Probe />
    </PanelProvider>,
    context,
  )
  const world = new FakeWorld({ viewport: VP })
  const el = world.mount(first(renderInBoard(<PanelProvider viewport={() => VP}>{node}</PanelProvider>, context)))
  listenLikeReact(
    world.wrap(world.body),
    () => el,
    () => hosts,
  )
  const pick = (selector: string): FakeElement => {
    const found = el.querySelector(selector)
    if (!found) throw new Error(`no ${selector}`)
    return found
  }
  return { world, el, pick }
}

/** A <ProfileRow> live; what its edits send is kept. */
function liveRow(row: ProfileRowView) {
  const posts: Record<string, unknown>[] = []
  const side = live(
    <ProfileRow
      row={row}
      disabled={false}
      edit={async body => {
        posts.push(body)
        return true
      }}
    />,
    board(),
  )
  return { ...side, posts }
}

const viewOf = (p: BoardProfile): ProfileRowView => {
  const [view] = profileRows([p], t)
  if (!view) throw new Error('no row')
  return view
}

test('renaming, hiding and showing send the profile’s id', async () => {
  // A new name, when the field is left.
  const left = liveRow(viewOf(WORK))
  const name = left.pick('.cat-title')
  name.focus()
  await left.world.fire(name, 'focusin')
  name.value = '  Job '
  await left.world.fire(name, 'input')
  await left.world.fire(name, 'focusout')
  expect(left.posts).toEqual([{ op: 'update', id: 'work', title: 'Job' }])

  // Enter leaves the field, which sends it.
  const entered = liveRow(viewOf(WORK))
  const field = entered.pick('.cat-title')
  field.focus()
  field.value = 'Job'
  await entered.world.fire(field, 'keydown', { key: 'Enter' })
  expect(entered.world.document.activeElement).not.toBe(field)
  await entered.world.fire(field, 'focusout')
  expect(entered.posts).toEqual([{ op: 'update', id: 'work', title: 'Job' }])

  // The same name, none, or Escape: nothing to send.
  for (const value of ['Work', '   ']) {
    const same = liveRow(viewOf(WORK))
    const f = same.pick('.cat-title')
    f.value = value
    await same.world.fire(f, 'focusout')
    expect([value, same.posts]).toEqual([value, []])
  }
  const escaped = liveRow(viewOf(WORK))
  const e = escaped.pick('.cat-title')
  e.focus()
  e.value = 'Job'
  await escaped.world.fire(e, 'keydown', { key: 'Escape' })
  await escaped.world.fire(e, 'focusout')
  expect(escaped.posts).toEqual([])

  // Hidden, then shown again; the one pressed already sends nothing.
  const work = liveRow(viewOf(WORK))
  const [workShown, workHidden] = work.el.querySelectorAll('.profile-shown button')
  if (!workShown || !workHidden) throw new Error('no Shown and Hidden')
  expect([workShown.textContent, workHidden.textContent]).toEqual(['Shown', 'Hidden'])
  await work.world.fire(workShown, 'click')
  await work.world.fire(workHidden, 'click')
  expect(work.posts).toEqual([{ op: 'update', id: 'work', hidden: true }])
  const gamedev = liveRow(viewOf(GAMEDEV))
  const [shown, hidden] = gamedev.el.querySelectorAll('.profile-shown button')
  if (!shown || !hidden) throw new Error('no Shown and Hidden')
  await gamedev.world.fire(hidden, 'click')
  await gamedev.world.fire(shown, 'click')
  expect(gamedev.posts).toEqual([{ op: 'update', id: 'gamedev', hidden: false }])
})

// ---------------------------------------------------------------- the board's answers

type Call = { url: string; init: RequestInit | undefined }
let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

/** The server's answers to the page's fetches, in turn; the calls kept. */
function answers(...replies: [number, unknown][]): Call[] {
  const calls: Call[] = []
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const [status, body] = replies.shift() ?? [200, { ok: true }]
    return new Response(JSON.stringify(body), { status })
  }
  const spy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(fake, { preconnect: fetch.preconnect }))
  restore = () => spy.mockRestore()
  return calls
}

/** The panel live on a board; what it toasted is kept. */
function livePanel(data: BoardPayload) {
  const toasts: [string, boolean][] = []
  const side = live(
    <ProfilesPanel open={false} onClose={() => {}} />,
    board({ data, toast: (text, error = false) => void toasts.push([text, error]) }),
  )
  return { ...side, toasts }
}

/** What went to the board: the path, its header and the body. */
const sent = (calls: Call[]) =>
  calls.map(c => [
    c.url,
    c.init?.method,
    (c.init?.headers as Record<string, string> | undefined)?.['x-board'],
    JSON.parse(String(c.init?.body)),
  ])

test('adding a folder somewhere else, and a folder a session reported', async () => {
  // Each folder once, as the first session wrote it; a session that reported none adds nothing.
  expect(unknownFolders(ITEMS)).toEqual([FOLDER, 'E:\\y\\.claude-y'])
  expect(unknownFolders([item({ key: 'a', profile: 'work' }), item({ key: 'b' })])).toEqual([])
  const data = dataOf([PRIVATE, WORK, GAMEDEV])
  expect(unknownIn(panelOf(data))).toEqual(['Add D:\\old\\.claude-x', 'Add E:\\y\\.claude-y'])
  expect(unknownIn(panelOf(dataOf([PRIVATE, WORK], ITEMS.slice(0, 3))))).toEqual([])
  // A folder typed in: the field says what it does, and Enter adds it, as a lane's "+ folder".
  const add = find([panelOf(data)], el => hasClass(el, 'profile-add'))
  expect(add.tag).toBe('label')
  expect(textOf(find([add], el => el.tag === 'span'))).toBe('Add a folder somewhere else')
  expect(findAll([add], el => el.tag === 'input').map(el => el.attrs.get('placeholder'))).toEqual(['Folder, Enter'])

  // A folder a session reported.
  const calls = answers(
    [200, { ok: true }],
    [200, { ok: true }],
    [409, { ok: false, error: 'There is no folder D:\\p\\gone' }],
  )
  const panel = livePanel(data)
  const [reported] = panel.el.querySelectorAll('.profile-unknown')
  if (!reported) throw new Error('no folder to add')
  expect(reported.textContent).toBe('Add D:\\old\\.claude-x')
  await panel.world.fire(reported, 'click')
  // One typed, then Enter; nothing typed, or another key, sends nothing.
  const folder = panel.pick('.profile-add input')
  folder.value = ' D:\\p\\acme '
  await panel.world.fire(folder, 'input')
  await panel.world.fire(folder, 'keydown', { key: 'a' })
  await panel.world.fire(folder, 'keydown', { key: 'Enter' })
  folder.value = '   '
  await panel.world.fire(folder, 'keydown', { key: 'Enter' })
  folder.value = 'D:\\p\\gone'
  await panel.world.fire(folder, 'keydown', { key: 'Enter' })
  for (let i = 0; i < 4; i++) await panel.world.flush()
  expect(sent(calls)).toEqual([
    ['/api/profiles', 'POST', '1', { op: 'add', dir: FOLDER }],
    ['/api/profiles', 'POST', '1', { op: 'add', dir: 'D:\\p\\acme' }],
    ['/api/profiles', 'POST', '1', { op: 'add', dir: 'D:\\p\\gone' }],
  ])
  // What the board refused is toasted, as in the categories panel.
  expect(panel.toasts).toEqual([['There is no folder D:\\p\\gone', true]])
})

test('a shown profile without the hooks offers Install; a hidden one does not; a gone folder says so', async () => {
  const rows = profileRows([PRIVATE, WORK, GAMEDEV, OLD, { ...GAMEDEV, id: 'stale', hooks: false }], t)
  expect(rows.map(r => [r.id, r.shown, r.missing, r.noHooks])).toEqual([
    ['default', true, false, false],
    ['work', true, false, true],
    ['gamedev', false, false, false],
    // Its folder is gone: Install could only fail.
    ['old', true, true, false],
    ['stale', false, false, false],
  ])

  const panel = panelOf(dataOf([PRIVATE, WORK, GAMEDEV, OLD]))
  expect(notesIn(panel)).toEqual([
    {
      id: 'work',
      text: 'The board’s hooks are not in Work’s settings.json: its sessions show no status or title',
      button: 'Install',
    },
  ])
  expect(rowText(rowIn(panel, 'old')).missing).toBe('Folder not found')
  expect(rowsIn(panel).map(row => rowText(row).missing)).toEqual(['', '', '', 'Folder not found'])
  // Every profile with its hooks: no note.
  expect(notesIn(panelOf(dataOf([PRIVATE, { ...WORK, hooks: true }, GAMEDEV])))).toEqual([])
  // In Russian.
  expect(notesIn(panelOf(dataOf([PRIVATE, WORK], ITEMS, 'ru'), {}, 'ru'))).toEqual([
    {
      id: 'work',
      text: 'Хуков доски нет в settings.json профиля Work: его сессии не показывают ни статус, ни заголовок',
      button: 'Установить',
    },
  ])

  // Install goes to the board for that profile; a refusal is toasted.
  const calls = answers([200, { ok: true }], [409, { ok: false, error: 'Show Work first' }])
  const live = livePanel(dataOf([PRIVATE, WORK, GAMEDEV, OLD]))
  const install = live.pick('.profile-note button')
  await live.world.fire(install, 'click')
  await live.world.fire(install, 'click')
  for (let i = 0; i < 4; i++) await live.world.flush()
  expect(sent(calls)).toEqual([
    ['/api/profiles', 'POST', '1', { op: 'install', id: 'work' }],
    ['/api/profiles', 'POST', '1', { op: 'install', id: 'work' }],
  ])
  expect(live.toasts).toEqual([['Show Work first', true]])
})
