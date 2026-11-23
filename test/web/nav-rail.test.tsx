// Collapsible left navigation rail (#651, Hybrid B+C header): Board, all 9 Places panels,
// and Settings at the foot; collapsed (52px) vs expanded (196px) with labels & action counts,
// amber alert dots when attention is needed, phone slide-over drawer with Escape handling.
import { describe, expect, test } from 'bun:test'
import type { BoardPayload } from '../../src/core/payload.ts'
import { NavRail, type NavRailProps } from '../../web/src/components/NavRail.tsx'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { byId, findAll, hasClass, type Node } from './support/markup.ts'

const NOW = Date.now()
const noop = () => {}
const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))

function baseProps(overrides: Partial<NavRailProps> = {}): NavRailProps {
  return {
    expanded: false,
    onToggleExpand: noop,
    drawerOpen: false,
    onCloseDrawer: noop,
    activePlace: 'board',
    onBoard: noop,
    onSchedule: noop,
    onCategories: noop,
    onArchive: noop,
    onSettings: noop,
    ...overrides,
  }
}

describe('NavRail (#651)', () => {
  test('renders Board, all 9 Places when configured, and Settings with expected DOM IDs', () => {
    const data: BoardPayload = payload({
      items: [
        item({
          key: 'a',
          name: 'atlas-api',
          todos: [
            { id: 't1', text: 'Verify build', owner: 'user', by: 'user', at: NOW - 10_000 },
            {
              id: 't2',
              text: 'Confirm deploy',
              owner: 'user',
              by: 'agent',
              at: NOW - 5_000,
              proposed: { at: NOW - 1_000, why: 'Deployed' },
            },
          ],
        }),
      ],
      schedules: [{ id: 's1', key: 'a', text: 'check', next: NOW - 10_000 }],
      todos: { agents: true },
      calendar: { rev: '1', busy: false, failing: 1, next: null },
      time: { seq: 1, date: '2026-11-23', today: {} },
      threads: { rev: 2, needsOwner: 3 },
      teamRev: 1,
      teamUnread: 2,
      decisions: {
        defaults: false,
        items: [
          {
            id: 'd1',
            key: 'a',
            who: 'atlas-api',
            question: 'Ship?',
            options: ['Yes'],
            recommend: null,
            askedAt: NOW - 5_000,
            defaultAt: null,
            held: false,
          },
        ],
        defaulted: [],
      },
    })
    const nodes = renderInBoard(
      <NavRail
        {...baseProps({
          expanded: true,
          activePlace: 'threads',
          onDecisions: noop,
          onThreads: noop,
          onTeam: noop,
          onTodos: noop,
          onCalendar: noop,
          onTime: noop,
          systemAlert: true,
        })}
      />,
      board({ data, now: NOW }),
      'en',
    )

    const rail = byId(nodes, 'nav-rail')
    expect(hasClass(rail, 'expanded')).toBe(true)
    expect(rail.attrs.has('data-expanded')).toBe(true)

    // Every Place ID and Settings ID is present and reachable.
    for (const id of [
      'rail-expand',
      'decisions-open',
      'threads-open',
      'team-open',
      'todos-open',
      'calendar-open',
      'sched-open',
      'time-open',
      'cats-open',
      'archive-open',
      'settings',
    ]) {
      expect(byId(nodes, id)).toBeTruthy()
    }

    // Active place carries aria-current="page" and .on.
    const threadsBtn = byId(nodes, 'threads-open')
    expect(threadsBtn.attrs.get('aria-current')).toBe('page')
    expect(hasClass(threadsBtn, 'on')).toBe(true)
    expect(hasClass(threadsBtn, 'alert')).toBe(true)
    expect(textOf(threadsBtn)).toContain('3')

    // Decisions, Team, Tasks (proposed), Calendar (failing), Schedule (due), and Settings (systemAlert) flag alert.
    for (const id of ['decisions-open', 'team-open', 'todos-open', 'calendar-open', 'sched-open', 'settings']) {
      expect(hasClass(byId(nodes, id), 'alert')).toBe(true)
    }

    // Settings shows its ',' keyboard shortcut hint.
    expect(findAll([byId(nodes, 'settings')], el => hasClass(el, 'rail-kbd')).map(textOf)).toEqual([','])
  })

  test('omits optional Places when their callbacks are not supplied', () => {
    const nodes = renderInBoard(<NavRail {...baseProps()} />, board(), 'en')
    for (const absent of ['decisions-open', 'threads-open', 'team-open', 'todos-open', 'calendar-open', 'time-open']) {
      expect(findAll(nodes, el => el.attrs.get('id') === absent)).toHaveLength(0)
    }
    // Always-present Places remain.
    for (const present of ['sched-open', 'cats-open', 'archive-open', 'settings']) {
      expect(byId(nodes, present)).toBeTruthy()
    }
  })

  test('collapsed rail shows amber dots for alert items; phone drawer renders scrim and data-drawer="open"', () => {
    const data = payload({ threads: { rev: 1, needsOwner: 1 } })
    const collapsed = renderInBoard(
      <NavRail {...baseProps({ expanded: false, onThreads: noop })} />,
      board({ data }),
      'en',
    )
    const threadsBtn = byId(collapsed, 'threads-open')
    expect(findAll([threadsBtn], el => hasClass(el, 'rail-dot'))).toHaveLength(1)
    expect(findAll(collapsed, el => hasClass(el, 'rail-scrim'))).toHaveLength(0)

    const drawer = renderInBoard(
      <NavRail {...baseProps({ drawerOpen: true, onThreads: noop })} />,
      board({ data }),
      'ru',
    )
    expect(findAll(drawer, el => hasClass(el, 'rail-scrim'))).toHaveLength(1)
    expect(byId(drawer, 'nav-rail').attrs.get('data-drawer')).toBe('open')
    expect(byId(drawer, 'nav-rail').attrs.get('aria-label')).toBe('Навигация')
  })
})
