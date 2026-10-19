// The profile a new session starts in (models/launch-profile.ts): what the window preselects and
// whether it offers the choice, the profiles kept per folder, the row and the tag beside Start, and
// what the start sends. Never a guess where the server would ask: a card whose profile the board
// does not know offers the choice with nothing picked.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardCategory, BoardProfile } from '../../src/core/payload.ts'
import type { LaunchView } from '../../src/core/types.ts'
import { formProblems, goButton, type LaunchFields } from '../../web/src/models/launch-form.ts'
import {
  type ProfilePick,
  profileBody,
  profileRow,
  profileStart,
  rememberedProfiles,
  rememberProfile,
} from '../../web/src/models/launch-profile.ts'
import { item } from './support/board.tsx'

const t = translator('en')

const profile = (id: string, title: string, color: string, hidden = false): BoardProfile => ({
  id,
  title,
  color,
  colorName: 'indigo',
  dir: id === 'default' ? 'C:\\Users\\me\\.claude' : `C:\\Users\\me\\.claude-${id}`,
  hidden,
  inherited: id === 'default',
  exists: true,
  hooks: hidden ? null : true,
  sessions: 0,
  limits: null,
})
const PRIVATE = profile('default', 'Private', '#5856D6')
const WORK = profile('work', 'Work', '#30B0C7')
const GAMEDEV = profile('gamedev', 'Gamedev', '#FF2D55', true)
/** Private and Work shown, Gamedev hidden. */
const TWO = [PRIVATE, WORK, GAMEDEV]
/** A teammate's board: one shown, a stray folder found and hidden. */
const ONE = [PRIVATE, { ...WORK, hidden: true }]

const cat = (id: string, usual?: string): BoardCategory => ({
  id,
  title: id,
  color: '#007AFF',
  colorName: 'blue',
  paths: [],
  configured: true,
  fallback: false,
  ...(usual === undefined ? {} : { profile: usual }),
})
const CATEGORIES = [cat('acme', 'work'), cat('web'), cat('games', 'gamedev'), cat('old', 'gone'), cat('other')]

/** The window's scene: a lane and a folder, nothing remembered, unless told otherwise. */
const scene = (
  fields: Partial<{ profiles: BoardProfile[]; category: string; cwd: string; remembered: Record<string, string> }> = {},
) => ({ profiles: TWO, categories: CATEGORIES, category: 'web', cwd: '/srv/web', remembered: {}, ...fields })

const LOCKED = (id: string): ProfilePick => ({ picked: id, locked: true, offered: false })
const ASK: ProfilePick = { picked: null, locked: false, offered: true }

const retryOf = (fields: Partial<LaunchView>): LaunchView => ({
  id: 'L1',
  name: 'acme fix',
  cwd: 'C:\\Work\\acme',
  category: 'acme',
  workspace: 'Acme',
  workspaceId: 'w2',
  state: 'failed',
  step: 'agent',
  error: 'launcher exited 1',
  kind: 'launcher',
  pane: null,
  key: null,
  startedAt: 100,
  doneAt: null,
  message: '',
  worktree: null,
  newWorkspace: false,
  ...fields,
})

describe('what the window preselects', () => {
  test('from a card: its profile, locked; a card whose profile is unknown: the choice, nothing picked', () => {
    const card = (fields: Parameters<typeof item>[0]) => ({ item: item(fields) })
    // Its own profile, hidden or not, whatever the lane or the folder would pick.
    const remembered = { '/srv/web': 'default' }
    expect(profileStart(card({ key: 'w', profile: 'work' }), scene({ category: 'acme', remembered }))).toEqual(
      LOCKED('work'),
    )
    expect(profileStart(card({ key: 'g', profile: 'gamedev' }), scene())).toEqual(LOCKED('gamedev'))
    // Running in another profile than its start asked for: the one it runs in.
    expect(profileStart(card({ key: 'x', profile: 'work', profileWanted: 'default' }), scene())).toEqual(LOCKED('work'))
    // Not known: no report on a board with two shown, a folder no profile has, a profile gone since.
    for (const fields of [
      { profile: null },
      {},
      { profile: null, profileFolder: 'D:\\elsewhere' },
      { profile: 'gone' },
    ])
      expect(profileStart(card({ key: 'u', ...fields }), scene({ category: 'acme', remembered }))).toEqual(ASK)
    // One shown: a card with no report is in it (as the server takes it), and nothing is offered.
    for (const fields of [{ profile: null }, {}])
      expect(profileStart(card({ key: 'u', ...fields }), scene({ profiles: ONE }))).toEqual(LOCKED('default'))
    expect(profileStart(card({ key: 'd', profile: 'default' }), scene({ profiles: ONE }))).toEqual(LOCKED('default'))
    // ... but a folder no profile has, or a profile gone, is not known there either: the user picks.
    expect(profileStart(card({ key: 'u', profile: null, profileFolder: 'D:\\x' }), scene({ profiles: ONE }))).toEqual(
      ASK,
    )
    expect(profileStart(card({ key: 'u', profile: 'gone' }), scene({ profiles: [PRIVATE] }))).toEqual(ASK)
    // A board before profiles: nothing to pick, nothing offered, as before.
    expect(profileStart(card({ key: 'u' }), scene({ profiles: [] }))).toEqual({
      picked: null,
      locked: false,
      offered: false,
    })
    // A failed launch started again: its profile, locked; one gone since is asked for; none: as a new one.
    expect(profileStart({ retry: retryOf({ profile: 'work' }) }, scene())).toEqual(LOCKED('work'))
    expect(profileStart({ retry: retryOf({ profile: 'gone', parent: 's1' }) }, scene())).toEqual(ASK)
    expect(profileStart({ retry: retryOf({}) }, scene({ category: 'acme' }))).toEqual({
      picked: 'work',
      locked: false,
      offered: true,
    })
  })

  test('from a lane’s +: its usual profile; else the folder’s last profile; else nothing', () => {
    const remembered = { 'c:/work/acme': 'default', '/srv/web': 'work' }
    const lane = { category: 'acme' }
    expect(profileStart(lane, scene({ category: 'acme', cwd: 'C:\\Work\\acme', remembered }))).toEqual({
      picked: 'work',
      locked: false,
      offered: true,
    })
    // A lane with none: the folder's, the folder told apart as normDir tells it.
    expect(profileStart({}, scene({ category: 'web', cwd: '/srv/web/', remembered }))).toEqual({
      picked: 'work',
      locked: false,
      offered: true,
    })
    expect(profileStart({}, scene({ category: 'other', cwd: 'c:/WORK/acme', remembered }))).toEqual({
      picked: 'default',
      locked: false,
      offered: true,
    })
    expect(profileStart({}, scene({ category: 'web', cwd: '/srv/elsewhere', remembered }))).toEqual(ASK)
    expect(profileStart({}, scene({ category: 'web', cwd: '', remembered }))).toEqual(ASK)
    // One shown: the folder's is that one (the lane's, Work, is hidden there), and nothing is offered.
    expect(profileStart(lane, scene({ profiles: ONE, category: 'acme', cwd: 'C:\\Work\\acme', remembered }))).toEqual({
      picked: 'default',
      locked: false,
      offered: false,
    })
  })

  test('a hidden or gone profile is never preselected; remembered profiles keep the newest 50', () => {
    // The lane's usual profile hidden, or gone: the folder's; that one hidden or gone: nothing.
    expect(
      profileStart({}, scene({ category: 'games', cwd: '/srv/web', remembered: { '/srv/web': 'default' } })),
    ).toEqual({ picked: 'default', locked: false, offered: true })
    expect(
      profileStart({}, scene({ category: 'old', cwd: '/srv/web', remembered: { '/srv/web': 'gamedev' } })),
    ).toEqual(ASK)
    expect(profileStart({}, scene({ category: 'web', cwd: '/srv/web', remembered: { '/srv/web': 'gone' } }))).toEqual(
      ASK,
    )
    // Work hidden on a teammate's board: never picked, even as a lane's usual one.
    expect(profileStart({}, scene({ profiles: ONE, category: 'acme', cwd: '/srv/web' }))).toEqual({
      picked: null,
      locked: false,
      offered: false,
    })

    // What localStorage holds, narrowed: anything else is nothing remembered.
    expect(rememberedProfiles(null)).toEqual({})
    expect(rememberedProfiles('not json')).toEqual({})
    expect(rememberedProfiles('["work"]')).toEqual({})
    expect(rememberedProfiles('{"c:/work/acme":"work","/srv/web":3,"/srv/x":""}')).toEqual({ 'c:/work/acme': 'work' })

    // Kept by the folder as normDir has it; the newest last, the oldest dropped past 50.
    let book = rememberProfile({}, 'C:\\Work\\acme\\', 'work')
    expect(book).toEqual({ 'c:/work/acme': 'work' })
    book = rememberProfile(book, '/srv/web', 'default')
    book = rememberProfile(book, 'c:/work/acme', 'default')
    expect(Object.entries(book)).toEqual([
      ['/srv/web', 'default'],
      ['c:/work/acme', 'default'],
    ])
    for (let i = 0; i < 60; i++) book = rememberProfile(book, `/srv/p${i}`, 'work')
    expect(Object.keys(book)).toHaveLength(50)
    expect(Object.keys(book)[0]).toBe('/srv/p10')
    expect(Object.keys(book).at(-1)).toBe('/srv/p59')
    expect(rememberedProfiles(JSON.stringify(book))).toEqual(book)
  })
})

describe('what the window shows and sends', () => {
  test('the row only when offered, the tag beside Start when it is not the only shown one', () => {
    expect(profileRow(ASK, TWO)).toEqual({
      offered: true,
      options: [
        { id: 'default', title: 'Private', color: '#5856D6', pressed: false },
        { id: 'work', title: 'Work', color: '#30B0C7', pressed: false },
      ],
      chosen: null,
    })
    const picked = profileRow({ picked: 'work', locked: false, offered: true }, TWO)
    expect(picked.options.map(o => o.pressed)).toEqual([false, true])
    expect(picked.chosen).toEqual({ title: 'Work', color: '#30B0C7' })
    // From a card: no row; its profile beside Start, hidden or not.
    expect(profileRow(LOCKED('work'), TWO)).toEqual({
      offered: false,
      options: [],
      chosen: { title: 'Work', color: '#30B0C7' },
    })
    expect(profileRow(LOCKED('gamedev'), TWO).chosen).toEqual({ title: 'Gamedev', color: '#FF2D55' })
    expect(profileRow(LOCKED('work'), ONE).chosen).toEqual({ title: 'Work', color: '#30B0C7' })
    // One shown and a card in it, or a lane's + picking it: nothing new.
    const nothing = { offered: false, options: [], chosen: null }
    expect(profileRow(LOCKED('default'), ONE)).toEqual(nothing)
    expect(profileRow({ picked: 'default', locked: false, offered: false }, ONE)).toEqual(nothing)
    expect(profileRow({ picked: null, locked: false, offered: false }, [])).toEqual(nothing)
    // Asked again with one shown (the server refused): its one chip.
    expect(profileRow(ASK, ONE).options.map(o => o.id)).toEqual(['default'])
  })

  test('the body: the profile when offered or locked to one not the only shown, and the card it came from', () => {
    expect(profileBody(LOCKED('work'), TWO, 's1')).toEqual({ profile: 'work', parent: 's1' })
    expect(profileBody(LOCKED('gamedev'), ONE.concat(GAMEDEV), 's1')).toEqual({ profile: 'gamedev', parent: 's1' })
    expect(profileBody({ picked: 'work', locked: false, offered: true }, TWO, null)).toEqual({ profile: 'work' })
    // Picked for a card whose profile is unknown: the server checks it against that card.
    expect(profileBody({ picked: 'work', locked: false, offered: true }, TWO, 's1')).toEqual({
      profile: 'work',
      parent: 's1',
    })
    // Nothing picked, or one shown and in it: nothing new.
    expect(profileBody(ASK, TWO, 's1')).toEqual({})
    expect(profileBody(LOCKED('default'), ONE, 's1')).toEqual({})
    expect(profileBody({ picked: 'default', locked: false, offered: false }, ONE, null)).toEqual({})
    expect(profileBody({ picked: null, locked: false, offered: false }, [], 's1')).toEqual({})
  })

  test('Start waits for a profile while one is offered and none picked', () => {
    const fields = (f: Partial<LaunchFields> = {}): LaunchFields => ({
      name: 'acme',
      cwd: 'C:\\Work\\acme',
      workspace: 'w2',
      newWorkspace: '',
      wt: false,
      branch: '',
      message: '',
      ...f,
    })
    const ok = { input: 'C:\\Work\\acme', path: 'C:\\Work\\acme', exists: true, dir: true }
    const problems = formProblems(fields(), ok, null, t, ASK)
    expect(problems).toEqual({ profile: t('launch.err.profileChoose') })
    expect(goButton({ canMutate: true, problems, checking: false, sending: false }, t)).toEqual({
      disabled: true,
      title: 'Choose a profile',
    })
    // In the form's order: after the folder, before where it opens.
    const all = formProblems(fields({ name: ' ', workspace: '', newWorkspace: '' }), ok, null, t, ASK)
    expect(Object.keys(all)).toEqual(['name', 'profile', 'workspace'])
    for (const pick of [LOCKED('work'), { picked: 'work', locked: false, offered: true }, { ...ASK, offered: false }])
      expect(formProblems(fields(), ok, null, t, pick)).toEqual({})
  })
})
