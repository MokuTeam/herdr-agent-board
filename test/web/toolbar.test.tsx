// Hybrid B+C header (#651): slim 46px command bar (search, quiet Profile/Device dropdowns,
// promoted imminent call chip, Away journal, composite Status & Usage readout, Next triage,
// primary + New), foldable flat typographic lane tabs strip + quiet summary, connection banner,
// column heads, and the unified Status & Usage popover.
import { describe, expect, test } from 'bun:test'
import { createRef } from 'react'
import type { BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import { LimitsPop } from '../../web/src/components/LimitsPop.tsx'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import type { BoardUi } from '../../web/src/state/board-ui.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { byClass, byId, findAll, hasClass, type Node } from './support/markup.ts'

const NOW = Date.now()
const ITEMS = [
  item({ key: 'a', name: 'atlas-api', column: 'work', status: 'working', category: 'proj' }),
  item({ key: 'b', name: 'atlas-auth', column: 'me', attention: 'ask', category: 'proj', askSince: NOW - 5000 }),
  item({ key: 'e', name: 'atlas-review', column: 'ext', category: 'proj', wait: 'review' }),
  item({ key: 'c', name: 'atlas-done', column: 'done', status: 'done', result: 'Fixed', activity: 100 }),
  item({ key: 'd', name: 'atlas-idle', column: 'idle', status: 'sleeping', sleeping: true }),
]
const CATEGORIES: BoardPayload['categories'] = [
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
const LIMITS: BoardPayload['limits'] = {
  source: 'usagebar',
  observedAt: NOW - 60_000,
  stale: false,
  windows: [
    { minutes: 300, usedPercentage: 92, resetsAt: null, expired: false },
    { minutes: 10080, usedPercentage: 40.4, resetsAt: null, expired: false },
  ],
}
const PROFILES: BoardProfile[] = [
  {
    id: 'default',
    title: 'Private',
    color: '#5856D6',
    colorName: 'indigo',
    dir: 'default',
    hidden: false,
    inherited: false,
    exists: true,
    hooks: true,
    sessions: 2,
    limits: null,
  },
  {
    id: 'work',
    title: 'Work',
    color: '#30B0C7',
    colorName: 'teal',
    dir: 'work',
    hidden: false,
    inherited: false,
    exists: true,
    hooks: true,
    sessions: 3,
    limits: null,
  },
]

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
const ui = (fields: Partial<BoardUi>) => fields

function renderToolbar(
  value: ReturnType<typeof board>,
  lang = 'en',
  props: Partial<Parameters<typeof Toolbar>[0]> = {},
): Node[] {
  return renderInBoard(<Toolbar limitsAnchor={createRef<HTMLButtonElement>()} {...props} />, value, lang)
}

describe('Hybrid B+C header markup (#651)', () => {
  test('fresh board in English: slim top bar, flat lane tabs, composite Status & Usage, Next triage, + New, and column heads', () => {
    const data = payload({ items: ITEMS, categories: CATEGORIES, limits: LIMITS })
    const nodes = renderToolbar(board({ data, ui: ui({ filter: [], sleepers: true }) }), 'en')

    // Row 1: search with / keycap, Status & Usage composite control, Next triage, primary + New.
    expect(byId(nodes, 'search').attrs.get('type')).toBe('search')
    expect(findAll(nodes, el => hasClass(el, 'search-kbd')).map(textOf)).toEqual(['/'])

    const status = byId(nodes, 'limits')
    expect(hasClass(status, 'status-control')).toBe(true)
    expect(hasClass(byId(nodes, 'live'), 'on')).toBe(true)
    expect(textOf(status)).toContain('5h 92%')

    const next = byId(nodes, 'next-attention')
    expect(hasClass(next, 'triage')).toBe(true)
    expect(textOf(next)).toContain('Next · 2')
    expect(findAll([next], el => hasClass(el, 'next-kbd')).map(textOf)).toEqual(['N'])

    const add = byId(nodes, 'new-session')
    expect(hasClass(add, 'tb-primary')).toBe(true)
    expect(add.attrs.has('disabled')).toBe(false)
    expect(textOf(add)).toBe('New')

    // Row 2: flat typographic lane tabs (All + categories with sessions, no count badges) + summary.
    const lanes = byId(nodes, 'lanes')
    expect(lanes.attrs.get('class')).toBe('lane-tabs')
    const tabs = findAll([lanes], el => el.tag === 'button')
    expect(tabs.map(b => [b.attrs.get('data-id'), textOf(b), b.attrs.get('aria-pressed')])).toEqual([
      ['all', 'All', 'true'],
      ['proj', 'Project', 'false'],
      ['other', 'Other', 'false'],
    ])
    // Category tabs have small 6px color square; "All" does not.
    const [allTab, projTab] = tabs
    if (!allTab || !projTab) throw new Error('expected All and Project lane tabs')
    expect(findAll([allTab], el => hasClass(el, 'lane-dot'))).toHaveLength(0)
    expect(findAll([projTab], el => hasClass(el, 'lane-dot'))).toHaveLength(1)

    expect(textOf(byId(nodes, 'summary'))).toContain('5 sessions')
    expect(byId(nodes, 'connection-state').attrs.has('hidden')).toBe(true)

    const heads = findAll([byId(nodes, 'columns-head')], el => hasClass(el, 'col-head'))
    expect(heads.map(h => h.attrs.get('data-col'))).toEqual(['work', 'me', 'ext', 'done', 'idle'])
  })

  test('stale data in Russian, one lane picked, nothing needing attention: read-only banner, disabled + New, active lane pressed', () => {
    const quiet = [item({ key: 'a', name: 'atlas-api', column: 'work', status: 'working', category: 'proj' })]
    const data = payload({ items: quiet, categories: CATEGORIES, limits: { ...LIMITS, stale: true } })
    const nodes = renderToolbar(
      board({ data, ui: ui({ filter: ['proj'], sleepers: false }), canMutate: false, canEdit: true, connected: false }),
      'ru',
    )

    expect(byId(nodes, 'connection-state').attrs.has('hidden')).toBe(false)
    expect(byId(nodes, 'new-session').attrs.has('disabled')).toBe(true)
    expect(byId(nodes, 'next-attention').attrs.has('disabled')).toBe(true)
    expect(hasClass(byId(nodes, 'next-attention'), 'triage')).toBe(false)
    expect(hasClass(byId(nodes, 'live'), 'on')).toBe(false)
    expect(hasClass(byId(nodes, 'limits'), 'stale')).toBe(true)

    const tabs = findAll([byId(nodes, 'lanes')], el => el.tag === 'button')
    expect(tabs.map(b => [b.attrs.get('data-id'), b.attrs.get('aria-pressed')])).toEqual([
      ['all', 'false'],
      ['proj', 'true'],
    ])
  })

  test('before first payload: loading summary, empty lanes and heads, offline dot', () => {
    const nodes = renderToolbar(board({ data: null, connected: false, canMutate: false, canEdit: false }), 'en')
    expect(textOf(byId(nodes, 'summary'))).toContain('Loading')
    expect(findAll([byId(nodes, 'lanes')], el => el.tag === 'button')).toEqual([])
    expect(findAll([byId(nodes, 'columns-head')], el => hasClass(el, 'col-head'))).toEqual([])
    expect(hasClass(byId(nodes, 'live'), 'on')).toBe(false)
  })

  test('quiet Profile dropdown appears in top bar when 2+ profiles exist; Away journal & alerts surface cleanly', () => {
    const data = payload({ items: ITEMS, categories: CATEGORIES, profiles: PROFILES })
    const nodes = renderToolbar(board({ data }), 'en', {
      journal: { label: 'Since 09:15', open: false, onToggle() {} },
      onOpenDrawer() {},
      railAlert: true,
    })
    const top = byClass(nodes, 'tb-top')
    expect(findAll([top], el => el.attrs.get('id') === 'profiles-pick')).toHaveLength(1)
    expect(findAll([top], el => el.attrs.get('id') === 'journal-open')).toHaveLength(1)
    expect(findAll([top], el => el.attrs.get('id') === 'rail-toggle')).toHaveLength(1)
    expect(findAll([top], el => hasClass(el, 'tb-menu-dot'))).toHaveLength(1)
  })

  test('unified Status & Usage popover shows connection state, presence switcher, session summary, alerts, and usage report', () => {
    const data = payload({
      items: ITEMS,
      categories: CATEGORIES,
      limits: LIMITS,
      presence: {
        mode: 'auto',
        state: 'here',
        by: 'user',
        since: NOW - 60_000,
        idleMinutes: 15,
        hint: null,
        detects: true,
        calls: true,
      },
      backup: { last: NOW - 3_600_000, problem: { kind: 'offline', target: 'cloud' } },
    })
    const nodes = renderInBoard(
      <LimitsPop
        anchor={createRef<HTMLButtonElement>()}
        unified
        onBackup={() => {}}
        setup={{
          open: false,
          opened: false,
          shown: true,
          hidden: true,
          checks: null,
          loadFailed: false,
          loading: false,
          busy: false,
          summary: null,
          copied: new Set(),
          noteRef: createRef<HTMLButtonElement>(),
          popRef: createRef<HTMLDivElement>(),
          toggle() {},
          close() {},
          recheck() {},
          hide() {},
          copy() {},
        }}
      />,
      board({ data, connected: true, ui: ui({ limitsOpen: true }) }),
      'en',
    )
    const pop = byId(nodes, 'limits-pop')
    const [head] = findAll([pop], el => hasClass(el, 'status-pop-head'))
    if (!head) throw new Error('expected status-pop-head')
    const text = textOf(head)
    expect(text).toContain('Live')
    expect(text).toContain('5 sessions')
    expect(findAll([pop], el => hasClass(el, 'status-seg-btn')).length).toBeGreaterThanOrEqual(2)
    expect(findAll([pop], el => hasClass(el, 'status-pop-alert')).length).toBeGreaterThanOrEqual(2)
    // LimitsReport is still rendered beneath the status summary.
    expect(textOf(pop)).toContain('92%')
  })
})
