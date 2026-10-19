// One profile shown, the page is phase 1's: each surface drawn as its own parity test draws it,
// once for a phase-1 board and once for the same board with its profile in the payload (and on its
// sessions), and the two markups held equal. The phase-1 render is pinned to upstream's page by
// those parity tests, so this pins the one-profile page to it. Later surfaces join here.
import { expect, test } from 'bun:test'
import { createRef } from 'react'
import type { BoardCategory, BoardLimits, BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import { Board } from '../../web/src/components/Board.tsx'
import { CategoriesPanel } from '../../web/src/components/categories/CategoriesPanel.tsx'
import { LimitsPop } from '../../web/src/components/LimitsPop.tsx'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import type { BoardUi } from '../../web/src/state/board-ui.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board as boardContext, item, payload, renderInBoard } from './support/board.tsx'
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
const usagePop = (data: BoardPayload): string =>
  canonical(
    renderInBoard(
      <LimitsPop anchor={createRef<HTMLButtonElement>()} />,
      boardContext({ data, now: NOW, ui: ui({ limitsOpen: true }) }),
    ),
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

test('one profile: the categories panel is phase 1’s', () => {
  expect(categoriesPanel(PHASE1)).toContain('Project')
  expect(categoriesPanel(ONE)).toBe(categoriesPanel(PHASE1))
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
