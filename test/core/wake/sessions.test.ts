import { expect, test } from 'bun:test'
import type { ReapEntry, ReapPane } from '../../../src/core/wake/reaper.ts'
import {
  asWakeSessions,
  awakeOf,
  findSession,
  KEEP_GONE_MS,
  markAwake,
  rememberSeen,
  type Seen,
  type SeenSnapshot,
  sleepingOf,
  type WakeSessions,
} from '../../../src/core/wake/sessions.ts'

const now = Date.parse('2026-10-21T12:00:00Z')
const min = (m: number) => now - m * 60_000
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const SID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const SID3 = '16fd2706-8baf-433b-82eb-8c7fada847da'
const WORK = 'C:\\h\\.claude-work'
const PROJECT = 'C:\\Work\\Проект x 50%'
const work: Seen = { name: 'Billing', profileDir: WORK, profile: 'work' }
const workspaces = [{ workspace_id: 'w1', label: 'Счета 100%' }]

const claude = (pane: string, session: string, more: Partial<ReapPane> = {}): ReapPane => ({
  pane_id: pane,
  workspace_id: 'w1',
  agent: 'claude',
  agent_status: 'idle',
  agent_session: { value: session },
  ...more,
})
const shell = (pane: string, more: Partial<ReapPane> = {}): ReapPane => ({
  pane_id: pane,
  workspace_id: 'w1',
  agent: null,
  ...more,
})
const view = (panes: ReapPane[], takenAt = now): SeenSnapshot => ({ workspaces, panes, takenAt })

/** The previous sessions frozen through and through: a function that changes them throws. */
function frozen(sessions: WakeSessions): WakeSessions {
  for (const e of Object.values(sessions)) Object.freeze(e)
  return Object.freeze(sessions)
}

test('a Claude seen in a pane is remembered with its name and its profile folder', () => {
  const snap = view([claude('w1:p1', SID, { cwd: PROJECT, terminal_title_stripped: 'Billing work' })])
  const r = rememberSeen(snap, frozen({}), new Map([[SID, work]]), now)
  expect(r).toEqual({
    sessions: {
      'w1:p1': {
        session: SID,
        name: 'Billing',
        cwd: PROJECT,
        title: 'Billing work',
        seen_at: now,
        profileDir: WORK,
        profile: 'work',
      },
    },
    changed: true,
    renames: [],
    exited: [],
  })
  expect(Object.keys(r.sessions['w1:p1'] ?? {})).toEqual([
    'session',
    'name',
    'cwd',
    'title',
    'seen_at',
    'profileDir',
    'profile',
  ])

  // The default folder has no listed id: the folder only.
  const dflt = rememberSeen(snap, {}, new Map([[SID, { name: 'Billing', profileDir: 'C:\\h\\.claude' }]]), now)
  expect(dflt.sessions['w1:p1']?.profileDir).toBe('C:\\h\\.claude')
  expect('profile' in (dflt.sessions['w1:p1'] ?? {})).toBe(false)

  // Seen again within a minute, unchanged: nothing to write.
  expect(rememberSeen(snap, frozen(r.sessions), new Map([[SID, work]]), now + 30_000).changed).toBe(false)
  // Renamed within that minute: written again under its new name.
  const renamed = rememberSeen(snap, frozen(r.sessions), new Map([[SID, { ...work, name: 'Счета' }]]), now + 30_000)
  expect(renamed.changed).toBe(true)
  expect(renamed.sessions['w1:p1']).toMatchObject({ name: 'Счета', seen_at: now + 30_000, profile: 'work' })

  // Out of the registries for a moment (e.g. on its way out): the name and folder it had are kept.
  const later = rememberSeen(snap, frozen(r.sessions), new Map(), now + 90_000)
  expect(later.changed).toBe(true)
  expect(later.sessions['w1:p1']).toMatchObject({ name: 'Billing', seen_at: now + 90_000, profileDir: WORK })
  expect(later.sessions['w1:p1']?.profile).toBe('work')
  // What the registries show wins over what the entry had.
  const moved = rememberSeen(snap, frozen(r.sessions), new Map([[SID, { profileDir: 'C:\\h\\.claude' }]]), now + 90_000)
  expect(moved.sessions['w1:p1']).toMatchObject({ name: 'Billing', profileDir: 'C:\\h\\.claude' })
  expect('profile' in (moved.sessions['w1:p1'] ?? {})).toBe(false)

  // Another session in the pane: nothing of the one before but the title.
  const other = rememberSeen(view([claude('w1:p1', SID2)]), frozen(r.sessions), new Map(), now + 90_000)
  expect(other.sessions['w1:p1']).toEqual({ session: SID2, name: '', title: 'Billing work', seen_at: now + 90_000 })

  // A profile id without its folder is not written.
  const noDir = rememberSeen(snap, {}, new Map([[SID, { name: 'Billing', profileDir: '', profile: 'work' }]]), now)
  expect(noDir.sessions['w1:p1']).toEqual({
    session: SID,
    name: 'Billing',
    cwd: PROJECT,
    title: 'Billing work',
    seen_at: now,
  })

  // Not Claude, or no session id: not remembered.
  const none = rememberSeen(view([{ ...claude('w1:p1', SID), agent: 'pi' }, shell('w1:p2')]), {}, new Map(), now)
  expect(none).toEqual({ sessions: {}, changed: false, renames: [], exited: [] })
})

test('a profile the registries show only after the first look is written within the minute, so the exit sleeps in that profile', () => {
  const panes = [claude('w1:p1', SID)]
  // First look: the registry has not got the session yet.
  const first = rememberSeen(view(panes), frozen({}), new Map(), now)
  expect(first.sessions['w1:p1']).toEqual({ session: SID, name: '', title: '', seen_at: now })

  // Late in the default folder's registry (a folder without an id): written as well.
  const dflt = rememberSeen(
    view(panes, now + 15_000),
    frozen(first.sessions),
    new Map([[SID, { profileDir: 'C:\\h\\.claude' }]]),
    now + 15_000,
  )
  expect(dflt.changed).toBe(true)
  expect(dflt.sessions['w1:p1']?.profileDir).toBe('C:\\h\\.claude')

  // 15 s later the work profile's registry has it (no name yet): written with its folder and id.
  const late = rememberSeen(
    view(panes, now + 15_000),
    frozen(first.sessions),
    new Map([[SID, { profileDir: WORK, profile: 'work' }]]),
    now + 15_000,
  )
  expect(late.changed).toBe(true)
  expect(late.sessions['w1:p1']).toEqual({
    session: SID,
    name: '',
    title: '',
    seen_at: now + 15_000,
    profileDir: WORK,
    profile: 'work',
  })

  // Exited at 30 s: asleep in the work profile.
  const gone = rememberSeen(view([shell('w1:p1')], now + 30_000), frozen(late.sessions), new Map(), now + 30_000)
  expect(gone.exited).toEqual(['w1:p1'])
  expect(sleepingOf(view([shell('w1:p1')]), gone.sessions)[0]?.profile).toEqual({ dir: WORK, id: 'work' })

  // Within the minute, the registries showing another folder, or the same folder without its id: written.
  const r = frozen(late.sessions)
  const at = now + 30_000
  const other = rememberSeen(view(panes, at), r, new Map([[SID, { profileDir: 'C:\\h\\.claude' }]]), at)
  expect(other.changed).toBe(true)
  expect(other.sessions['w1:p1']).toEqual({
    session: SID,
    name: '',
    title: '',
    seen_at: at,
    profileDir: 'C:\\h\\.claude',
  })
  expect(rememberSeen(view(panes, at), r, new Map([[SID, { profileDir: WORK }]]), at).changed).toBe(true)
  // The same folder and id, or out of the registries for a moment: nothing to write.
  expect(rememberSeen(view(panes, at), r, new Map([[SID, { profileDir: WORK, profile: 'work' }]]), at).changed).toBe(
    false,
  )
  expect(rememberSeen(view(panes, at), r, new Map(), at).changed).toBe(false)
})

test('a session the user exited counts as asleep, its pane renamed 💤 <name>', () => {
  const prev = frozen({
    'w1:p2': {
      session: SID,
      name: 'Billing',
      cwd: PROJECT,
      title: 'Billing work',
      seen_at: min(5),
      profileDir: WORK,
      profile: 'work',
    },
  })
  const r = rememberSeen(view([shell('w1:p2')]), prev, new Map(), now)
  const e = r.sessions['w1:p2']
  expect(e?.slept_at).toBe(e?.seen_at ?? -1)
  expect(e).toEqual({
    ...prev['w1:p2'],
    session: SID,
    name: 'Billing',
    seen_at: min(5),
    slept_at: min(5),
    exited: true,
  })
  expect(r.renames).toEqual([{ pane: 'w1:p2', label: '💤 Billing' }])
  expect(r.exited).toEqual(['w1:p2'])
  expect(r.changed).toBe(true)

  // No name: the title it had.
  const untitled = frozen({ 'w1:p2': { session: SID, name: '', title: 'Docs', seen_at: min(5) } })
  expect(rememberSeen(view([shell('w1:p2')]), untitled, new Map(), now).renames).toEqual([
    { pane: 'w1:p2', label: '💤 Docs' },
  ])

  // On its way to sleep (between /exit and the prompt): not an exit by hand.
  const going = rememberSeen(view([shell('w1:p2')]), prev, new Map(), now, new Set(['w1:p2']))
  expect(going).toEqual({ sessions: prev, changed: false, renames: [], exited: [] })

  // Still in a registry: it runs somewhere, it was not exited.
  const running = rememberSeen(view([shell('w1:p2')]), prev, new Map([[SID, work]]), now)
  expect(running.exited).toEqual([])
  expect(running.sessions['w1:p2']?.slept_at).toBeUndefined()
})

test('Claude back in a sleeping pane after the sleep is awake; a view older than the sleep is not', () => {
  const prev = frozen({
    'w1:p2': {
      session: SID,
      name: 'Billing',
      title: 'Billing',
      seen_at: now - 30_000,
      slept_at: now - 10_000,
      exited: true,
      profileDir: WORK,
      profile: 'work',
    },
  })
  const panes = [claude('w1:p2', SID)]

  const older = rememberSeen(view(panes, now - 20_000), prev, new Map(), now)
  expect(older).toEqual({ sessions: prev, changed: false, renames: [], exited: [] })

  const newer = rememberSeen(view(panes, now - 5_000), prev, new Map(), now)
  expect(newer.renames).toEqual([{ pane: 'w1:p2', label: null }])
  expect(newer.changed).toBe(true)
  expect(newer.sessions['w1:p2']).toEqual({
    session: SID,
    name: 'Billing',
    title: 'Billing',
    seen_at: now - 30_000,
    profileDir: WORK,
    profile: 'work',
  })

  // A view without its time counts as older than any sleep.
  expect(rememberSeen({ workspaces, panes }, prev, new Map(), now).renames).toEqual([])
  // Still on its way to sleep: not awake, and the sleep is kept when the entry is written again.
  const going = rememberSeen(view(panes, now - 5_000), prev, new Map(), now + 60_000, new Set(['w1:p2']))
  expect(going.renames).toEqual([])
  expect(going.sessions['w1:p2']).toMatchObject({ seen_at: now + 60_000, slept_at: now - 10_000, profileDir: WORK })
})

test('a session running in another pane is awake there; a pane gone for 7 days is forgotten, one gone for 6 is kept', () => {
  const prev = frozen({
    'w1:p2': { session: SID, name: 'Billing', title: 'Billing', seen_at: min(180), slept_at: min(180) },
    'w2:p1': { session: SID2, name: 'Old', seen_at: now - KEEP_GONE_MS - 1 },
    'w2:p2': { session: SID3, name: 'Six', seen_at: now - 6 * 86_400_000 },
    'w2:p3': { session: SID3, name: 'Seven to the ms', seen_at: now - KEEP_GONE_MS },
  })
  const snap = view([shell('w1:p2'), claude('w1:p3', SID, { cwd: PROJECT })])
  const r = rememberSeen(snap, prev, new Map([[SID, work]]), now)
  expect(r.renames).toEqual([{ pane: 'w1:p2', label: null }])
  expect(r.sessions['w1:p2']).toEqual({ session: SID, name: 'Billing', title: 'Billing', seen_at: min(180) })
  expect(r.sessions['w1:p3']).toMatchObject({ session: SID, name: 'Billing', seen_at: now, profileDir: WORK })
  expect(Object.keys(r.sessions).sort()).toEqual(['w1:p2', 'w1:p3', 'w2:p2', 'w2:p3'])
  expect(r.changed).toBe(true)
  expect(KEEP_GONE_MS).toBe(7 * 86_400_000)

  // While its old pane is on its way to sleep, that pane stays asleep.
  const going = rememberSeen(snap, prev, new Map([[SID, work]]), now, new Set(['w1:p2']))
  expect(going.renames).toEqual([])
  expect(going.sessions['w1:p2']?.slept_at).toBe(min(180))
})

test('markAwake: the pane’s entry without its sleep, the rest kept; nothing to do for one awake', () => {
  const prev = frozen({
    'w1:p2': { session: SID, name: 'Billing', seen_at: min(5), slept_at: min(5), exited: true, profileDir: WORK, x: 1 },
    'w1:p3': { session: SID2, name: 'Docs', seen_at: min(1) },
  })
  expect(markAwake(prev, 'w1:p2')).toEqual({
    'w1:p2': { session: SID, name: 'Billing', seen_at: min(5), profileDir: WORK, x: 1 },
    'w1:p3': { session: SID2, name: 'Docs', seen_at: min(1) },
  })
  expect(markAwake(prev, 'w1:p3')).toBeNull()
  expect(markAwake(prev, 'w9:p9')).toBeNull()
})

test('the sleeping list: field for field as the old router’s, plus each session’s profile', () => {
  const at = Date.parse('2026-10-21T11:00:00Z')
  const sessions: WakeSessions = {
    'w1:p2': {
      session: SID,
      name: 'Billing',
      title: 'Billing',
      seen_at: at,
      slept_at: at,
      profileDir: WORK,
      profile: 'work',
    },
    'w1:p3': { session: SID2, name: '', title: 'Docs', seen_at: at, slept_at: at, exited: true },
    'w1:p4': { session: SID3, name: 'Running', seen_at: at, slept_at: at },
    'w9:p1': { session: SID3, name: 'Gone', seen_at: at, slept_at: at },
    'w1:p5': { session: SID3, name: 'Awake', seen_at: at },
    'w1:p6': { session: SID3, name: 'No label', seen_at: at, slept_at: at, profileDir: 'C:\\h\\.claude' },
  }
  const snap: SeenSnapshot = {
    workspaces,
    panes: [
      shell('w1:p2'),
      shell('w1:p3'),
      claude('w1:p4', SID3),
      shell('w1:p5'),
      shell('w1:p6', { workspace_id: 'w7' }),
    ],
  }
  const list = sleepingOf(snap, sessions)
  expect(list).toEqual([
    {
      name: 'Billing',
      pane: 'w1:p2',
      session: SID,
      workspace: 'Счета 100%',
      slept_at: '2026-10-21T11:00:00.000Z',
      exited: false,
      profile: { dir: 'C:\\h\\.claude-work', id: 'work' },
    },
    {
      name: 'Docs',
      pane: 'w1:p3',
      session: SID2,
      workspace: 'Счета 100%',
      slept_at: '2026-10-21T11:00:00.000Z',
      exited: true,
    },
    {
      name: 'No label',
      pane: 'w1:p6',
      session: SID3,
      workspace: '',
      slept_at: '2026-10-21T11:00:00.000Z',
      exited: false,
      profile: { dir: 'C:\\h\\.claude' },
    },
  ])
  expect(Object.keys(list[0] ?? {})).toEqual(['name', 'pane', 'session', 'workspace', 'slept_at', 'exited', 'profile'])
  expect('profile' in (list[1] ?? {})).toBe(false)
  expect(Object.keys(list[2]?.profile ?? {})).toEqual(['dir'])
})

test('the awake list: field for field as the old router’s, plus each session’s profile; a missing since does not throw', () => {
  const ws = 'Счета 100%'
  const plan: ReapEntry[] = [
    {
      pane: 'w1:p1',
      name: 'Billing',
      workspace: ws,
      sleep: true,
      reason: 'idle 75 min',
      status: 'idle',
      since: min(75),
      idleMin: 75,
      session: SID,
    },
    {
      pane: 'w1:p3',
      name: 'Docs',
      workspace: ws,
      sleep: false,
      reason: 'idle 20 min',
      waiting: true,
      status: 'idle',
      since: min(20),
      idleMin: 20,
    },
    {
      pane: 'w1:p4',
      name: 'Build',
      workspace: ws,
      sleep: false,
      reason: 'status busy',
      status: 'busy',
      since: min(2),
      idleMin: 2,
    },
    { pane: 'w1:p5', name: 'w1:p5', workspace: ws, sleep: false, reason: 'not in the session registry' },
    { pane: 'w1:p6', name: 'New', workspace: ws, sleep: false, reason: 'idle time unknown', status: 'idle' },
  ]
  const profiles = new Map([
    ['w1:p1', { dir: WORK, id: 'work' }],
    ['w1:p3', { dir: 'C:\\h\\.claude' }],
  ])
  const on = awakeOf(plan, { enabled: true, idleMinutes: 60 }, profiles)
  expect(on).toEqual([
    {
      name: 'Billing',
      pane: 'w1:p1',
      workspace: ws,
      status: 'idle',
      since: '2026-10-21T10:45:00.000Z',
      sleeps_in_min: 0,
      kept: null,
      profile: { dir: WORK, id: 'work' },
    },
    {
      name: 'Docs',
      pane: 'w1:p3',
      workspace: ws,
      status: 'idle',
      since: '2026-10-21T11:40:00.000Z',
      sleeps_in_min: 40,
      kept: null,
      profile: { dir: 'C:\\h\\.claude' },
    },
    {
      name: 'Build',
      pane: 'w1:p4',
      workspace: ws,
      status: 'busy',
      since: '2026-10-21T11:58:00.000Z',
      sleeps_in_min: null,
      kept: 'status busy',
    },
    {
      name: 'New',
      pane: 'w1:p6',
      workspace: ws,
      status: 'idle',
      since: '',
      sleeps_in_min: null,
      kept: 'idle time unknown',
    },
  ])
  expect(Object.keys(on[0] ?? {})).toEqual([
    'name',
    'pane',
    'workspace',
    'status',
    'since',
    'sleeps_in_min',
    'kept',
    'profile',
  ])
  expect('profile' in (on[2] ?? {})).toBe(false)

  const off = awakeOf(plan, { enabled: false, idleMinutes: 60 }, profiles)
  expect(off.map(a => [a.sleeps_in_min, a.kept])).toEqual([
    [null, 'reaper off'],
    [null, 'reaper off'],
    [null, 'reaper off'],
    [null, 'reaper off'],
  ])
})

test('findSession: by name with a [hex] suffix, by pane, by session id, any case; a pane herdr no longer has finds nothing', () => {
  const sessions: WakeSessions = {
    'w1:p2': { session: SID, name: 'Billing', seen_at: min(5), slept_at: min(5), profileDir: WORK, pane: 'w7:p7' },
    'w1:p3': { session: SID2, name: 'Docs', seen_at: min(1) },
    'w9:p1': { session: SID3, name: 'Gone', seen_at: min(1) },
    'w1:p4': { session: 'x', name: '', seen_at: min(1) },
  }
  const snap = view([shell('w1:p2'), claude('w1:p3', SID2), shell('w1:p4')])

  expect(findSession('billing [1a2b3c]', snap, sessions)).toEqual({
    session: SID,
    name: 'Billing',
    seen_at: min(5),
    slept_at: min(5),
    profileDir: WORK,
    pane: 'w1:p2',
    live: false,
  })
  expect(findSession('  BILLING  ', snap, sessions)?.pane).toBe('w1:p2')
  expect(findSession('W1:P3', snap, sessions)).toMatchObject({ pane: 'w1:p3', name: 'Docs', live: true })
  expect(findSession(SID.toUpperCase(), snap, sessions)?.pane).toBe('w1:p2')
  expect(findSession('w7:p7', snap, sessions)).toBeUndefined()
  expect(findSession('Gone', snap, sessions)).toBeUndefined()
  expect(findSession('w9:p1', snap, sessions)).toBeUndefined()
  expect(findSession(SID3, snap, sessions)).toBeUndefined()
  expect(findSession('', snap, sessions)).toBeUndefined()
  expect(findSession(undefined, snap, sessions)).toBeUndefined()
})

test('asWakeSessions keeps unknown fields and drops what is not an entry', () => {
  expect(asWakeSessions({ 'w1:p1': { session: 's', seen_at: 1, extra: 1 }, bad: 3, 'w1:p2': { session: 2 } })).toEqual({
    'w1:p1': { session: 's', name: '', seen_at: 1, extra: 1 },
  })
  for (const v of [null, undefined, [], 'x', 3, true]) expect(asWakeSessions(v)).toBeNull()
  expect(asWakeSessions({})).toEqual({})

  // A known field of the wrong type is left out, so what the type says holds.
  const odd = asWakeSessions({
    'w1:p3': { session: SID, name: 5, seen_at: 1, slept_at: 'x', exited: 'yes', cwd: 3, title: [] },
    'w1:p4': { session: SID, seen_at: '1' },
    'w1:p5': { session: SID, seen_at: Number.POSITIVE_INFINITY },
    'w1:p6': [SID],
  })
  expect(odd).toStrictEqual({ 'w1:p3': { session: SID, name: '', seen_at: 1 } })

  const whole = {
    session: SID,
    name: 'Billing',
    cwd: PROJECT,
    title: 't',
    seen_at: 1,
    slept_at: 2,
    exited: true,
    profileDir: WORK,
    profile: 'work',
  }
  expect(asWakeSessions(JSON.parse(JSON.stringify({ 'w1:p1': whole })))).toStrictEqual({ 'w1:p1': whole })
})

test('a broken profile in the file drops the entry: never listed or woken in the default profile instead of its own', () => {
  const at = now - 60_000
  const asleep = { session: SID, name: 'Billing', seen_at: at, slept_at: at }
  const read = asWakeSessions({
    'w1:p1': { ...asleep, profileDir: 7, profile: 'work' },
    'w1:p2': { ...asleep, profileDir: WORK, profile: null },
    'w1:p3': { ...asleep, profileDir: '', profile: 'work' },
    'w1:p4': { ...asleep, profileDir: WORK, profile: '' },
    'w1:p5': { ...asleep, profile: 'work' },
    'w1:p6': { ...asleep, profileDir: null },
    // A folder without a listed id (the default folder), and no profile at all (the default one): kept.
    'w1:p7': { ...asleep, profileDir: 'C:\\h\\.claude' },
    'w1:p8': { ...asleep },
  })
  expect(read).toStrictEqual({ 'w1:p7': { ...asleep, profileDir: 'C:\\h\\.claude' }, 'w1:p8': asleep })

  const panes = ['w1:p1', 'w1:p2', 'w1:p3', 'w1:p4', 'w1:p5', 'w1:p6'].map(p => shell(p))
  expect(sleepingOf(view(panes), read ?? {})).toEqual([])
  expect(findSession('Billing', view(panes), read ?? {})).toBeUndefined()
})

// #204: a sleeper whose pane wake closed, kept under its session id.
const FREED = {
  pane: 'w1:p9',
  workspace: 'w1',
  workspaceLabel: 'Счета 100%',
  tabLabel: 'Billing',
  topic: 'topic: 100% / Billing',
  at: min(30),
}
const freedEntry = {
  session: SID,
  name: 'Billing',
  cwd: PROJECT,
  seen_at: min(31),
  slept_at: min(31),
  profileDir: WORK,
  profile: 'work',
  freed: FREED,
}

test('#204: a sleeper whose pane was closed is listed, without a pane, with its folder and workspace', () => {
  const sessions = asWakeSessions({ [SID]: freedEntry, [SID2]: { ...freedEntry, session: SID2, freed: { pane: '' } } })
  // A `freed` that does not read as one is left out: that entry is an old one, under a gone pane.
  expect(sessions?.[SID2]).not.toHaveProperty('freed')
  expect(sleepingOf(view([]), sessions ?? {})).toEqual([
    {
      name: 'Billing',
      pane: '',
      session: SID,
      workspace: 'Счета 100%',
      slept_at: new Date(min(31)).toISOString(),
      exited: false,
      profile: { dir: WORK, id: 'work' },
      cwd: PROJECT,
    },
  ])
  // Its workspace renamed since: herdr's label now.
  const renamed = { workspaces: [{ workspace_id: 'w1', label: 'Bills' }], panes: [], takenAt: now }
  expect(sleepingOf(renamed, { [SID]: freedEntry })[0]?.workspace).toBe('Bills')
})

test('#204: found by name or session id, never by a pane id herdr may have given to another pane', () => {
  const sessions: WakeSessions = { [SID]: freedEntry }
  for (const t of ['billing [0f8f]', SID.toUpperCase()])
    expect(findSession(t, view([]), sessions)).toMatchObject({ pane: SID, live: false, freed: FREED })
  expect(findSession('w1:p9', view([shell('w1:p9')]), sessions)).toBeUndefined()
  // An entry of a pane herdr has goes first.
  const both: WakeSessions = {
    ...sessions,
    'w1:p1': { session: SID2, name: 'Billing', seen_at: min(5), slept_at: min(5) },
  }
  expect(findSession('Billing', view([shell('w1:p1')]), both)?.pane).toBe('w1:p1')
})

test('#204: kept past 7 days without a pane; forgotten once it runs in a pane, never on an older view', () => {
  const sessions = frozen({ [SID]: { ...freedEntry, seen_at: min(30 * 1440) } })
  expect(rememberSeen(view([]), sessions, new Map(), now)).toMatchObject({ changed: false, sessions })
  // A view taken before its pane was closed still shows it there: not woken.
  const before = view([claude('w1:p9', SID)], min(31))
  expect(rememberSeen(before, sessions, new Map(), now).sessions[SID]).toEqual(sessions[SID])
  // Resumed in a new pane: that pane's entry, and the sleeper forgotten.
  const after = rememberSeen(view([claude('w1:p20', SID)]), sessions, new Map([[SID, work]]), now)
  expect(Object.keys(after.sessions)).toEqual(['w1:p20'])
  expect(after.renames).toEqual([])
  // A registry still has it just after its pane closed: kept; a minute on, outside herdr: forgotten.
  const fresh = frozen({ [SID]: { ...freedEntry, freed: { ...FREED, at: now - 5000 } } })
  expect(rememberSeen(view([]), fresh, new Map([[SID, work]]), now).sessions).toEqual(fresh)
  expect(rememberSeen(view([]), sessions, new Map([[SID, work]]), now).sessions).toEqual({})
})

test('#243: a sleeper keeps the terminal it was judged in; awake again it has none, and one that is no string is left out', () => {
  const read = asWakeSessions({
    'w1:p2': { session: SID, name: 'Billing', seen_at: min(5), slept_at: min(5), terminal: 'term_65ef9516d93293' },
    'w1:p3': { session: SID2, name: 'Docs', seen_at: min(5), slept_at: min(5), terminal: 7 },
    'w1:p4': { session: SID3, name: 'Ops', seen_at: min(5), slept_at: min(5), terminal: '' },
  })
  expect(read?.['w1:p2']?.terminal).toBe('term_65ef9516d93293')
  expect(read?.['w1:p3']).not.toHaveProperty('terminal')
  expect(read?.['w1:p4']).not.toHaveProperty('terminal')
  expect(markAwake(read ?? {}, 'w1:p2')?.['w1:p2']).toEqual({ session: SID, name: 'Billing', seen_at: min(5) })
  // Claude seen back in the pane: awake, and its terminal note gone with its sleep.
  const snap: SeenSnapshot = { panes: [claude('w1:p2', SID)], workspaces, takenAt: now }
  const r = rememberSeen(snap, read ?? {}, new Map([[SID, work]]), now)
  expect(r.sessions['w1:p2']).not.toHaveProperty('terminal')
  expect(r.sessions['w1:p2']).not.toHaveProperty('slept_at')
})
