// The profile switch and the profile tags of the web board: two profiles shown, the toolbar has a
// switch after the lanes control and the cards name their profile; the switch's pick filters the
// cards as the lanes control does and stays in this browser. One shown: none of it
// (single-profile.test.tsx holds that page to phase 1's).
import { expect, test } from 'bun:test'
import { createRef } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardCategory, BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import { Board } from '../../web/src/components/Board.tsx'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import { pickedProfile, profileOptions, profileShown, tagView } from '../../web/src/models/profiles.ts'
import { type BoardUi, boardUi, initialUi } from '../../web/src/state/board-ui.ts'
import { board as boardContext, item, payload, renderInBoard } from './support/board.tsx'
import { byClass, byId, type Element, find, findAll, hasClass, type Node } from './support/markup.ts'

const t = translator('en')

const PRIVATE: BoardProfile = {
  id: 'default',
  title: 'Private',
  color: '#5856D6',
  colorName: 'indigo',
  dir: 'C:\\Users\\me\\.claude',
  hidden: false,
  inherited: true,
  exists: true,
  hooks: true,
  sessions: 2,
  limits: null,
}
const WORK: BoardProfile = {
  id: 'work',
  title: 'Work',
  color: '#30B0C7',
  colorName: 'teal',
  dir: 'C:\\Users\\me\\.claude-work',
  hidden: false,
  inherited: false,
  exists: true,
  hooks: true,
  sessions: 1,
  limits: null,
}
const GAMEDEV: BoardProfile = {
  id: 'gamedev',
  title: 'Gamedev',
  color: '#FF2D55',
  colorName: 'pink',
  dir: 'C:\\Users\\me\\.claude-gamedev',
  hidden: true,
  inherited: false,
  exists: true,
  hooks: null,
  sessions: 0,
  limits: null,
}
const PROFILES = [PRIVATE, WORK, GAMEDEV]
const ONE_SHOWN = [PRIVATE, { ...WORK, hidden: true }, GAMEDEV]

const category = (id: string, title: string, color: string, fallback = false): BoardCategory => ({
  id,
  title,
  color,
  colorName: '',
  paths: [],
  configured: true,
  fallback,
})
const CATEGORIES = [
  category('proj', 'Project', '#007AFF'),
  category('client', 'Client', '#FF9500'),
  category('other', 'Other', '#8E8E93', true),
]
const FOLDER = 'D:\\elsewhere\\.claude-x'
// a and e run in the default profile (e was started for work), b in work; c reported none, d a folder no profile has.
const ITEMS = [
  item({ key: 'a', name: 'Alpha', column: 'work', status: 'working', category: 'proj', profile: 'default' }),
  item({ key: 'b', name: 'Beta', column: 'me', attention: 'ask', category: 'client', profile: 'work' }),
  item({ key: 'c', name: 'Gamma', column: 'done', status: 'done', category: 'proj' }),
  item({ key: 'd', name: 'Delta', column: 'idle', category: 'proj', profile: null, profileFolder: FOLDER }),
  item({ key: 'e', name: 'Eps', column: 'ext', category: 'other', profile: 'default', profileWanted: 'work' }),
]
const DATA = payload({ items: ITEMS, categories: CATEGORIES, profiles: PROFILES })

const toolbar = (data: BoardPayload, ui: Partial<BoardUi> = {}, lang = 'en'): Node[] =>
  renderInBoard(
    <Toolbar limitsAnchor={createRef<HTMLButtonElement>()} />,
    boardContext({ data, ui: { filter: 'all', sleepers: true, ...ui } }),
    lang,
  )
const boardOf = (data: BoardPayload, ui: Partial<BoardUi> = {}, lang = 'en'): Node[] =>
  renderInBoard(<Board />, boardContext({ data, ui: { filter: 'all', query: '', sleepers: true, ...ui } }), lang)

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
const elementsIn = (el: Element): Element[] => el.children.filter((c): c is Element => c.kind === 'element')
const tabs = (el: Element): Element[] => findAll(el.children, c => c.tag === 'button')
const hasId = (nodes: Node[], id: string): boolean => findAll(nodes, el => el.attrs.get('id') === id).length > 0
const picked = (nodes: Node[]): string | undefined =>
  tabs(byId(nodes, 'profiles'))
    .find(b => b.attrs.get('aria-selected') === 'true')
    ?.attrs.get('data-id')
const cardKeys = (nodes: Node[]): string[] =>
  findAll(nodes, el => el.tag === 'article')
    .map(el => el.attrs.get('data-key') ?? '')
    .sort()
const lanesWithCards = (nodes: Node[]): string[] =>
  findAll(nodes, el => el.tag === 'section' && hasClass(el, 'lane') && !hasClass(el, 'empty-lane')).map(
    el => el.attrs.get('data-cat') ?? '',
  )
const cardOf = (nodes: Node[], key: string): Element =>
  find(nodes, el => el.tag === 'article' && el.attrs.get('data-key') === key)
/** A card's tag: its classes, text, style and tooltip; null without one. */
function tagOf(nodes: Node[], key: string): string[] | null {
  const [tag, ...more] = findAll(cardOf(nodes, key).children, el => hasClass(el, 'profile-tag'))
  if (!tag) return null
  expect(more).toEqual([])
  return [tag.attrs.get('class') ?? '', textOf(tag), tag.attrs.get('style') ?? '', tag.attrs.get('title') ?? '']
}
const stored = (values: Record<string, string>) => (key: string, fallback: string) => values[key] ?? fallback

test('two shown profiles: the switch after the lanes, All profiles first, each with its count and color', () => {
  const nodes = toolbar(DATA)
  const control = byId(nodes, 'profiles')
  expect([control.tag, control.attrs.get('class'), control.attrs.get('role'), control.attrs.get('aria-label')]).toEqual(
    ['div', 'segmented profiles', 'tablist', 'Profiles'],
  )
  // Right after the lanes control, with a thumb as it has.
  const row = elementsIn(byClass(nodes, 'controls'))
  expect(row[row.findIndex(el => el.attrs.get('id') === 'lanes') + 1]).toBe(control)
  expect(elementsIn(control).filter(el => hasClass(el, 'thumb')).length).toBe(1)
  const buttons = tabs(control)
  expect(buttons.map(textOf)).toEqual(['All profiles5', 'Private2', 'Work1'])
  expect(buttons.map(b => b.attrs.get('data-id'))).toEqual(['all', 'default', 'work'])
  expect(buttons.map(b => b.attrs.get('role'))).toEqual(['tab', 'tab', 'tab'])
  expect(buttons.map(b => b.attrs.get('aria-selected'))).toEqual(['true', 'false', 'false'])
  expect(buttons.map(b => b.attrs.get('style'))).toEqual([undefined, '--c:#5856D6', '--c:#30B0C7'])
  expect(buttons.map(b => findAll(b.children, el => hasClass(el, 'n')).map(textOf))).toEqual([['5'], ['2'], ['1']])
  // It counts what is on show, as the lanes control does.
  expect(tabs(byId(toolbar(DATA, { query: 'beta' }), 'profiles')).map(textOf)).toEqual([
    'All profiles1',
    'Private0',
    'Work1',
  ])
  // In Russian.
  const ru = toolbar(DATA, {}, 'ru')
  expect(byId(ru, 'profiles').attrs.get('aria-label')).toBe('Профили')
  expect(tabs(byId(ru, 'profiles')).map(textOf)[0]).toBe('Все профили5')
  // The model: every shown profile, those with no session on show too.
  expect(profileOptions(PROFILES, [], t)).toEqual([
    { id: 'all', title: 'All profiles', color: '', n: 0 },
    { id: 'default', title: 'Private', color: '#5856D6', n: 0 },
    { id: 'work', title: 'Work', color: '#30B0C7', n: 0 },
  ])
})

test('one shown profile: no switch', () => {
  const boards = [
    { ...DATA, profiles: ONE_SHOWN },
    { ...DATA, profiles: [PRIVATE] },
    payload({ items: ITEMS, categories: CATEGORIES }),
  ]
  for (const data of boards) {
    expect(hasId(toolbar(data), 'profiles')).toBe(false)
    expect(hasId(toolbar(data, { profile: 'work' }), 'profiles')).toBe(false)
    expect(hasId(toolbar(data), 'lanes')).toBe(true)
  }
  expect(profileOptions(ONE_SHOWN, ITEMS, t)).toBeNull()
  expect(profileOptions([PRIVATE], ITEMS, t)).toBeNull()
  expect(profileOptions([], ITEMS, t)).toBeNull()
  expect(profileOptions(undefined, ITEMS, t)).toBeNull()
})

test('Work picked: only its cards and lanes, no tags; kept as board.profile; a hidden pick reads as All profiles', () => {
  const nodes = boardOf(DATA, { profile: 'work' })
  expect(cardKeys(nodes)).toEqual(['b'])
  expect(lanesWithCards(nodes)).toEqual(['client'])
  expect(findAll(nodes, el => hasClass(el, 'profile-tag'))).toEqual([])
  const bar = toolbar(DATA, { profile: 'work' })
  expect(picked(bar)).toBe('work')
  expect(tabs(byId(bar, 'lanes')).map(b => b.attrs.get('data-id'))).toEqual(['all', 'client'])
  expect(tabs(byId(bar, 'lanes')).map(textOf)).toEqual(['All1', 'Client1'])
  // The switch still counts every profile's.
  expect(tabs(byId(bar, 'profiles')).map(textOf)).toEqual(['All profiles5', 'Private2', 'Work1'])
  // Private picked: a session started for work that runs here is in it, still in red.
  const own = boardOf(DATA, { profile: 'default' })
  expect(cardKeys(own)).toEqual(['a', 'e'])
  expect(tagOf(own, 'a')).toBeNull()
  expect(tagOf(own, 'e')?.[0]).toBe('profile-tag wrong')

  // Kept in this browser, as the lane pick is.
  expect(initialUi(stored({})).profile).toBe('all')
  expect(initialUi(stored({ 'board.profile': 'work' })).profile).toBe('work')
  expect(boardUi(initialUi(stored({})), { type: 'profile', id: 'work' }).profile).toBe('work')

  // A pick hidden since, or gone: All profiles.
  for (const pick of ['gamedev', 'gone']) {
    expect(pickedProfile(pick, PROFILES)).toBe('all')
    expect(cardKeys(boardOf(DATA, { profile: pick }))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(picked(toolbar(DATA, { profile: pick }))).toBe('all')
  }
  expect(pickedProfile('work', PROFILES)).toBe('work')
  expect(pickedProfile('all', PROFILES)).toBe('all')
  expect(pickedProfile('work', undefined)).toBe('all')
  // One shown: no switch, so no pick either: every session shows, as before profiles.
  expect(pickedProfile('default', ONE_SHOWN)).toBe('all')
  expect(cardKeys(boardOf({ ...DATA, profiles: ONE_SHOWN }, { profile: 'default' }))).toEqual(['a', 'b', 'c', 'd', 'e'])
  expect(profileShown('all', { profile: null })).toBe(true)
  expect(profileShown('work', { profile: 'work' })).toBe(true)
  expect(profileShown('work', { profile: 'default' })).toBe(false)
  expect(profileShown('work', { profile: null })).toBe(false)
  expect(profileShown('work', {})).toBe(false)
})

test('tags on All profiles: each known profile, none without a report, unknown names the folder, wrong profile in red', () => {
  // A session of a hidden profile still shows under All profiles, with its tag.
  const f = item({ key: 'f', name: 'Phi', column: 'done', status: 'done', category: 'proj', profile: 'gamedev' })
  const nodes = boardOf({ ...DATA, items: [...ITEMS, f] })
  expect(cardKeys(nodes)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  expect(tagOf(nodes, 'a')).toEqual(['profile-tag profile', 'Private', '--c:#5856D6', PRIVATE.dir])
  expect(tagOf(nodes, 'b')).toEqual(['profile-tag profile', 'Work', '--c:#30B0C7', WORK.dir])
  expect(tagOf(nodes, 'c')).toBeNull()
  expect(tagOf(nodes, 'd')).toEqual(['profile-tag unknown', 'unknown profile', '--c:var(--gray)', FOLDER])
  const wrong = 'Wrong profile: started for Work'
  expect(tagOf(nodes, 'e')).toEqual(['profile-tag wrong', wrong, '--c:var(--red)', wrong])
  expect(tagOf(nodes, 'f')).toEqual(['profile-tag profile', 'Gamedev', '--c:#FF2D55', GAMEDEV.dir])
  // Right after the card's name.
  const top = elementsIn(find(cardOf(nodes, 'a').children, el => hasClass(el, 'card-top')))
  const name = top.findIndex(el => hasClass(el, 'name'))
  expect(name).toBeGreaterThan(-1)
  expect(top[name + 1]?.attrs.get('class')).toBe('profile-tag profile')
  // In Russian.
  const ru = boardOf(DATA, {}, 'ru')
  expect(tagOf(ru, 'd')?.[1]).toBe('неизвестный профиль')
  expect(tagOf(ru, 'e')?.[1]).toBe('Не тот профиль: запущена для Work')
  // A wanted profile no longer listed reads as its id.
  expect(tagView({ kind: 'wrong', wantId: 'gone', want: null }, t)).toEqual({
    kind: 'wrong',
    text: 'Wrong profile: started for gone',
    title: 'Wrong profile: started for gone',
    color: 'var(--red)',
  })
})
