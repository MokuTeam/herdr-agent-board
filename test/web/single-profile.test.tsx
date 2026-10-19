// One profile shown, the page is phase 1's: each surface drawn as its own parity test draws it,
// once for a phase-1 board and once for the same board with its profile in the payload (and on its
// sessions), and the two markups held equal. The phase-1 render is pinned to upstream's page by
// those parity tests, so this pins the one-profile page to it. Later surfaces join here.
import { expect, test } from 'bun:test'
import { createRef } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardCategory, BoardLimits, BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import type { Item } from '../../src/core/types.ts'
import { Board } from '../../web/src/components/Board.tsx'
import { CategoriesPanel } from '../../web/src/components/categories/CategoriesPanel.tsx'
import { Limits } from '../../web/src/components/Limits.tsx'
import { LimitsPop } from '../../web/src/components/LimitsPop.tsx'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import type { LaunchContext } from '../../web/src/models/launch-form.ts'
import { LAUNCH_PROFILES } from '../../web/src/models/launch-profile.ts'
import type { BoardUi } from '../../web/src/state/board-ui.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board as boardContext, item, payload, renderInBoard } from './support/board.tsx'
import { type LaunchScene, type LaunchSide, reactLaunchSide } from './support/launch-sides.tsx'
import { canonical } from './support/markup.ts'

const MIN = 60_000
const NOW = Date.now()
const ago = (minutes: number) => NOW - (minutes + 0.5) * MIN

const ITEMS = [
  item({ key: 'a', name: 'Alpha', column: 'work', status: 'working', category: 'proj', activity: ago(1) }),
  item({ key: 'b', name: 'Beta', column: 'me', attention: 'ask', category: 'proj', askSince: ago(5) }),
  item({ key: 'e', name: 'Eps', column: 'ext', category: 'proj', wait: 'review', activity: ago(8) }),
  item({ key: 'c', name: 'Gamma', column: 'done', status: 'done', result: 'Fixed', activity: ago(100) }),
  item({ key: 'd', name: 'Delta', column: 'idle', status: 'sleeping', sleeping: true, activity: ago(300) }),
]
const CATEGORIES: BoardCategory[] = [
  { id: 'proj', title: 'Project', color: '#007AFF', colorName: 'blue', paths: [], configured: true, fallback: false },
  { id: 'other', title: 'Other', color: '#8E8E93', colorName: 'gray', paths: [], configured: true, fallback: true },
  {
    id: 'unused',
    title: 'Unused',
    color: '#FF9500',
    colorName: 'orange',
    paths: [],
    configured: true,
    fallback: false,
  },
]
const READING: BoardLimits = {
  source: 'statusline',
  observedAt: NOW - MIN,
  stale: false,
  windows: [
    { minutes: 300, usedPercentage: 92, resetsAt: null, expired: false },
    { minutes: 10080, usedPercentage: 40.4, resetsAt: null, expired: false },
  ],
}

const DEFAULT: BoardProfile = {
  id: 'default',
  title: 'Default',
  color: '#5856D6',
  colorName: 'indigo',
  dir: 'C:\\Users\\me\\.claude',
  hidden: false,
  inherited: true,
  exists: true,
  hooks: true,
  sessions: 5,
  limits: READING,
}
/** A board before profiles. */
const PHASE1 = payload({ items: ITEMS, categories: CATEGORIES, limits: READING })
/** The same board with its one profile. */
const ONE: BoardPayload = {
  ...PHASE1,
  items: PHASE1.items.map(i => ({ ...i, profile: 'default' })),
  profiles: [DEFAULT],
}
/** The same board with a second profile folder found, hidden as every found one starts. */
const FOLDERS: BoardPayload = {
  ...ONE,
  profiles: [
    DEFAULT,
    {
      id: 'work',
      title: 'Work',
      color: '#30B0C7',
      colorName: 'teal',
      dir: 'C:\\Users\\me\\.claude-work',
      hidden: true,
      inherited: false,
      exists: true,
      hooks: null,
      sessions: 0,
      limits: null,
    },
  ],
}

const ui = (fields: Partial<BoardUi>) => fields

/** The lanes and their cards, as board.test.tsx draws them (support/board-scene.tsx). */
const board = (data: BoardPayload, more: Partial<BoardUi> = {}): string =>
  canonical(
    renderInBoard(
      <Board />,
      boardContext({ data, now: NOW, ui: ui({ filter: 'all', query: '', sleepers: true, open: null, ...more }) }),
    ),
    { spaces: true },
  )

/** The toolbar, as toolbar.test.tsx draws it. */
const toolbar = (data: BoardPayload, more: Partial<BoardUi> = {}): string =>
  canonical(
    renderInBoard(
      <Toolbar limitsAnchor={createRef<HTMLButtonElement>()} />,
      boardContext({ data, now: NOW, ui: ui({ filter: 'all', sleepers: true, ...more }) }),
    ),
  )

/** The usage popover, open, as limits-pop.test.tsx draws it. */
const usagePop = (data: BoardPayload, connected = true): string =>
  canonical(
    renderInBoard(
      <LimitsPop anchor={createRef<HTMLButtonElement>()} />,
      boardContext({ data, now: NOW, connected, ui: ui({ limitsOpen: true }) }),
    ),
  )

/** The usage pill, as the toolbar holds it (toolbar.test.tsx). */
const usagePill = (data: BoardPayload, connected = true): string =>
  canonical(
    renderInBoard(<Limits anchor={createRef<HTMLButtonElement>()} />, boardContext({ data, now: NOW, connected })),
  )

/** The categories panel, as categories-panel.test.tsx draws it. */
const categoriesPanel = (data: BoardPayload): string =>
  canonical(
    renderInBoard(
      <PanelProvider viewport={() => ({ w: 1600, h: 1000 })}>
        <CategoriesPanel open={false} focus={null} onClose={() => {}} onOpen={() => {}} />
      </PanelProvider>,
      boardContext({ data, now: NOW }),
    ),
  )

test('one profile: the board, its lanes and cards are phase 1’s', () => {
  expect(board(PHASE1)).toContain('Alpha')
  expect(board(ONE)).toBe(board(PHASE1))
})

test('one profile: the toolbar is phase 1’s', () => {
  expect(toolbar(PHASE1)).toContain('92%')
  expect(toolbar(ONE)).toBe(toolbar(PHASE1))
})

test('one profile: the usage popover is phase 1’s', () => {
  expect(usagePop(PHASE1)).toContain('92%')
  expect(usagePop(ONE)).toBe(usagePop(PHASE1))
})

test('one profile shown: the categories panel is phase 1’s, a lane’s usual profile and all', () => {
  expect(categoriesPanel(PHASE1)).toContain('Project')
  expect(categoriesPanel(ONE)).toBe(categoriesPanel(PHASE1))
  expect(categoriesPanel(FOLDERS)).toBe(categoriesPanel(PHASE1))
  // A usual profile set while two were shown: the shown one, or Work hidden since.
  for (const profile of ['default', 'work']) {
    const usual = (data: BoardPayload): BoardPayload => ({
      ...data,
      categories: data.categories.map(c => (c.id === 'proj' ? { ...c, profile } : c)),
    })
    expect(categoriesPanel(usual(ONE))).toBe(categoriesPanel(PHASE1))
    expect(categoriesPanel(usual(FOLDERS))).toBe(categoriesPanel(PHASE1))
  }
})

test('several folders, one shown: the board and toolbar are still phase 1’s', () => {
  expect(board(FOLDERS)).toBe(board(PHASE1))
  expect(toolbar(FOLDERS)).toBe(toolbar(PHASE1))
})

test('one profile shown, a profile picked before: the board and toolbar are still phase 1’s', () => {
  // Work picked while it was shown, hidden since; or the one shown picked.
  for (const profile of ['work', 'default', 'gone']) {
    expect(board(FOLDERS, { profile })).toBe(board(PHASE1))
    expect(toolbar(FOLDERS, { profile })).toBe(toolbar(PHASE1))
    expect(board(ONE, { profile })).toBe(board(PHASE1))
    expect(toolbar(ONE, { profile })).toBe(toolbar(PHASE1))
  }
  // Sessions that report no profile (no card yet, or from before profiles) still show.
  const unreported: BoardPayload = { ...FOLDERS, items: PHASE1.items }
  expect(board(unreported, { profile: 'default' })).toBe(board(PHASE1))
  expect(toolbar(unreported, { profile: 'default' })).toBe(toolbar(PHASE1))
})

test('one profile shown: the usage pill and popover are phase 1’s, whatever its or a hidden profile’s reading', () => {
  expect(usagePill(PHASE1)).toContain('92%')
  const work = FOLDERS.profiles?.[1]
  if (!work) throw new Error('FOLDERS has Work')
  // Work hidden with a fresh reading of its own; the shown one's own reading missing, or another.
  const other: BoardLimits = {
    ...READING,
    windows: [{ minutes: 300, usedPercentage: 5, resetsAt: null, expired: false }],
  }
  const boards: BoardPayload[] = [
    ONE,
    FOLDERS,
    {
      ...FOLDERS,
      profiles: [
        { ...DEFAULT, limits: null },
        { ...work, limits: other },
      ],
    },
    { ...ONE, profiles: [{ ...DEFAULT, limits: other }] },
  ]
  for (const data of boards) {
    expect(usagePill(data)).toBe(usagePill(PHASE1))
    expect(usagePop(data)).toBe(usagePop(PHASE1))
    // Not connected: phase 1's old reading.
    expect(usagePill(data, false)).toBe(usagePill(PHASE1, false))
    expect(usagePop(data, false)).toBe(usagePop(PHASE1, false))
  }
  // No reading on the board: phase 1's "Usage —" and its note, whatever a hidden profile used.
  const none = { ...PHASE1, limits: null }
  expect(usagePill(none)).toContain('Usage —')
  for (const data of [
    { ...ONE, limits: null },
    { ...FOLDERS, limits: null, profiles: [DEFAULT, { ...work, limits: READING }] },
  ]) {
    expect(usagePill(data)).toBe(usagePill(none))
    expect(usagePop(data)).toBe(usagePop(none))
  }
})

// ---------------------------------------------------------------- the new-session window
// Its lanes and sessions in the folders of the window's fake machine (support/launch-sides.tsx),
// drawn as launch-dialog.test.tsx draws it.

const lane = (id: string, title: string, paths: string[], fallback = false): BoardCategory => ({
  id,
  title,
  color: '#007AFF',
  colorName: 'blue',
  paths,
  configured: true,
  fallback,
})
const LANES = [
  lane('acme', 'Acme', ['C:\\Work\\acme']),
  lane('web', 'Web', ['/srv/web']),
  lane('other', 'Other', [], true),
]
const SESSIONS = [
  item({ key: 's1', name: 'acme', cwd: 'C:\\Work\\acme', category: 'acme', workspace: 'Acme', activity: 50 }),
  item({ key: 's2', name: 'site', cwd: '/srv/web', category: 'web', workspace: 'Ops', activity: 40 }),
]

/** The window's board: its profiles (none before them), what its sessions report, Acme's usual profile. */
function windowBoard(profiles: BoardProfile[] | undefined, report?: string | null, usual?: string): LaunchScene {
  const items: Item[] = SESSIONS.map(i => (report === undefined ? i : { ...i, profile: report }))
  return {
    t: translator('en'),
    categories: LANES.map(c => (usual !== undefined && c.id === 'acme' ? { ...c, profile: usual } : c)),
    items,
    launches: [],
    filter: 'all',
    canMutate: true,
    ...(profiles === undefined ? {} : { profiles }),
  }
}

type Step = (side: LaunchSide) => Promise<unknown>

/** The window after each step, as launch-dialog.test.tsx takes it. */
async function windowShots(scene: LaunchScene): Promise<string[]> {
  const side = reactLaunchSide(scene)
  const key =
    (k: string, ctrlKey = false): Step =>
    async s => {
      const el = s.world.document.activeElement
      if (!el) throw new Error('nothing has the focus')
      await s.world.fire(el, 'keydown', { key: k, ctrlKey })
    }
  const openAt = (ctx: (s: LaunchSide) => LaunchContext, from: string): Step[] => [
    s => s.open(ctx(s), from),
    s => s.world.tick(30),
    s => s.world.tick(160),
    s => s.world.settle(),
  ]
  const steps: Step[] = [
    // A profile remembered for each folder: Work (hidden, or not there) and the one shown.
    async s => {
      s.world.storage.set(LAUNCH_PROFILES, JSON.stringify({ 'c:/work/acme': 'work', '/srv/web': 'default' }))
    },
    ...openAt(() => ({}), 'new-session'),
    key('Escape'),
    s => s.world.settle(),
    ...openAt(() => ({ category: 'acme' }), 'lane-new'),
    key('Enter', true),
    s => s.world.tick(16),
    s => s.world.settle(),
    ...openAt(s => {
      const card = s.scene.items[0]
      if (!card) throw new Error('no card')
      return { item: card }
    }, 'card'),
    key('Enter', true),
    s => s.world.tick(16),
    s => s.world.settle(),
  ]
  try {
    const shots: string[] = []
    for (const step of steps) {
      await step(side)
      for (let i = 0; i < 6; i++) await side.world.flush()
      shots.push(side.snapshot())
    }
    await side.world.settle()
    shots.push(side.snapshot())
    return shots
  } finally {
    await side.dispose()
  }
}

test('one profile shown: the new-session window is phase 1’s, from the toolbar, a lane’s + and a card; the body has no profile or parent', async () => {
  const phase1 = await windowShots(windowBoard(undefined))
  const sent =
    phase1
      .at(-1)
      ?.split('\n')
      .find(line => line.startsWith('log:')) ?? ''
  expect(sent.split('POST /api/launch {').length).toBe(3)
  expect(sent).not.toContain('"profile"')
  expect(sent).not.toContain('"parent"')
  const work = FOLDERS.profiles?.[1]
  if (!work) throw new Error('FOLDERS has Work')
  const boards: [string, LaunchScene][] = [
    ['one profile', windowBoard([DEFAULT], 'default')],
    ['one profile, Acme usually in it', windowBoard([DEFAULT], 'default', 'default')],
    ['a hidden folder found', windowBoard([DEFAULT, work], 'default')],
    ['a hidden folder found, cards with no report', windowBoard([DEFAULT, work], null)],
    ['a hidden folder found, cards from before profiles', windowBoard([DEFAULT, work])],
    ['a hidden folder found, Acme usually in it', windowBoard([DEFAULT, work], null, 'work')],
  ]
  for (const [name, scene] of boards) {
    const shots = await windowShots(scene)
    expect(shots.length).toBe(phase1.length)
    for (const [i, shot] of phase1.entries())
      expect(`${name}, step ${i}\n${shots[i]}`).toBe(`${name}, step ${i}\n${shot}`)
  }
})
