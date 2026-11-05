// A session moved to another Claude profile from the board (#256): the card's Profile, the lane's
// "Move the lane's sessions to", what their picks do (models/board-menus.ts), and the toasts and
// calls behind them (models/profile-move.ts). One profile shown, or none: no new item, the menus
// as before.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Item } from '../../src/core/types.ts'
import type { Reply } from '../../web/src/api/client.ts'
import { type BoardMenuDeps, menuFor } from '../../web/src/models/board-menus.ts'
import { ALL_LANES } from '../../web/src/models/lane-picks.ts'
import { cardMenu, laneMenu, type MenuEntry, type MenuItem } from '../../web/src/models/menu-model.ts'
import {
  cardToast,
  laneToast,
  type MoveDeps,
  type MoveResult,
  moveCard,
  moveLane,
} from '../../web/src/models/profile-move.ts'
import type { ToastOptions } from '../../web/src/state/board-ui.ts'
import { item } from './support/board.tsx'
import { FakeWorld } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'

const t = translator('en')
const ru = translator('ru')
const PROFILES = [
  { id: 'default', title: 'Personal', color: '#007AFF', hidden: false },
  { id: 'work', title: 'Work', color: '#FF9500', hidden: false },
]
const SHOWN = PROFILES.map(({ id, title, color }) => ({ id, title, color }))

const isItem = (i: MenuEntry): i is MenuItem => !i.separator
const find = (items: readonly MenuEntry[] | null | undefined, id: string) =>
  (items ?? []).filter(isItem).find(i => i.id === id)

describe('the menus', () => {
  const ctx = { t, canMutate: true, canEdit: true, categories: [], column: 'idle', category: 'acme' }
  const it = { key: 'k', session: 'k', agent: 'claude', pane: 'p1', cwd: '/w', status: 'idle', auto: 'idle' }

  test('a Claude card’s Profile: each profile shown, its own checked; gray without fresh data', () => {
    const menu = cardMenu(it, { ...ctx, profiles: SHOWN, profile: 'default' })
    expect(find(menu, 'profile')?.submenu).toEqual([
      { id: 'profile:default', label: 'Personal', checked: true, dot: '#007AFF' },
      { id: 'profile:work', label: 'Work', checked: false, dot: '#FF9500' },
    ])
    // Its profile not known: none checked, both offered.
    const unknown = find(cardMenu(it, { ...ctx, profiles: SHOWN, profile: '' }), 'profile')
    expect(unknown?.submenu?.filter(isItem).map(i => i.checked)).toEqual([false, false])
    const stale = find(cardMenu(it, { ...ctx, canMutate: false, profiles: SHOWN, profile: 'default' }), 'profile')
    expect([stale?.disabled, stale?.submenu]).toEqual([true, null])
    // Not a Claude session: nothing to move.
    expect(find(cardMenu({ ...it, agent: 'pi' }, { ...ctx, profiles: SHOWN }), 'profile')).toBeUndefined()
  })

  test('one profile shown, or none: the card’s and the lane’s menus as before', () => {
    const one = SHOWN.slice(0, 1)
    expect(cardMenu(it, { ...ctx, profiles: one, profile: 'default' })).toEqual(cardMenu(it, ctx))
    const lane = { id: 'acme', title: 'Acme', color: '' }
    const plain = { ...ctx, filter: ALL_LANES }
    expect(laneMenu(lane, { ...plain, profiles: one, moving: () => 3, usual: false })).toEqual(laneMenu(lane, plain))
  })

  test('a lane’s move: each profile with how many go there, gray at none; the usual check only for a lane in the config', () => {
    const lane = { id: 'acme', title: 'Acme', color: '' }
    const counts: Record<string, number> = { default: 0, work: 2 }
    const base = { ...ctx, filter: ALL_LANES, profiles: SHOWN, moving: (id: string) => counts[id] ?? 0 }
    expect(find(laneMenu(lane, { ...base, usual: false }), 'laneProfile')).toEqual({
      id: 'laneProfile',
      label: 'Move Acme’s sessions to',
      submenu: [
        { id: 'profile:default', label: 'Personal', dot: '#007AFF', hint: '0', disabled: true },
        { id: 'profile:work', label: 'Work', dot: '#FF9500', hint: '2' },
        { separator: true },
        { id: 'usual', label: 'Also make it Acme’s usual profile', checked: false, keep: true },
      ],
    })
    expect(find(laneMenu(lane, base), 'laneProfile')?.submenu?.map(i => (isItem(i) ? i.id : '-'))).toEqual([
      'profile:default',
      'profile:work',
    ])
    const none = find(laneMenu(lane, { ...base, moving: () => 0 }), 'laneProfile')
    expect([none?.disabled, none?.reason]).toEqual([true, 'No Claude sessions in Acme'])
    expect(find(laneMenu(lane, { ...base, canMutate: false }), 'laneProfile')?.disabled).toBe(true)
  })
})

describe('what the picks do (models/board-menus.ts)', () => {
  const PAGE = `<section class="lane" data-cat="acme" id="lane"><span id="lane-space">x</span>
    <article class="card" data-key="a" id="card-a"><span class="name">a</span></article></section>`
  const items: Item[] = [
    item({ key: 'a', agent: 'claude', category: 'acme', profile: 'default' }),
    item({ key: 'b', agent: 'claude', category: 'acme', profile: 'work' }),
    item({ key: 'c', agent: 'claude', category: 'acme', profile: null }),
    item({ key: 'd', agent: 'pi', category: 'acme' }),
    item({ key: 'e', agent: 'claude', category: 'other', profile: 'default' }),
  ]

  function page(profiles: typeof PROFILES) {
    const world = new FakeWorld({ viewport: { w: 1000, h: 800 } })
    world.install()
    for (const node of parseHtml(PAGE)) if (node.kind === 'element') world.mount(node)
    const log: unknown[] = []
    const updates: MenuEntry[][] = []
    const none = () => undefined
    const deps: BoardMenuDeps = {
      t: () => t,
      canMutate: () => true,
      canEdit: () => true,
      item: key => items.find(i => i.key === key),
      column: () => 'idle',
      category: i => i.category,
      state: () => ({
        open: null,
        filter: ALL_LANES,
        sleepers: true,
        data: { categories: [{ id: 'acme', title: 'Acme', color: '', configured: true }], profiles },
      }),
      items: () => items,
      update: next => void updates.push(next),
      launch: null,
      tidyCount: () => 0,
      do: {
        ...(Object.fromEntries(
          [
            'open',
            'focus',
            'write',
            'wake',
            'sleep',
            'favorite',
            'restart',
            'dismiss',
            'clear',
            'changes',
            'history',
            'terminal',
            'mokupilot',
            'fork',
            'archive',
            'tidy',
            'archiveOpen',
            'rename',
            'renameWorkspace',
            'move',
            'newSession',
            'cats',
            'filter',
            'sleepers',
            'search',
            'copy',
            'openPath',
            'look',
            'focusLaunch',
          ].map(k => [k, none]),
        ) as unknown as BoardMenuDeps['do']),
        profile: (key: string, id: string) => void log.push(['profile', key, id]),
        laneProfile: (lane: { id: string }, id: string, keys: readonly string[], usual: boolean) =>
          void log.push(['lane', lane.id, id, keys, usual]),
      },
    }
    const el = (id: string) => world.document.querySelector(`#${id}`)
    return { world, deps, log, updates, el }
  }

  test('a card’s profile picked moves it; its own does nothing', () => {
    const { world, deps, log, el } = page(PROFILES)
    try {
      const m = menuFor(el('card-a'), { x: 10, y: 10 }, deps)
      expect(
        find(m?.items, 'profile')
          ?.submenu?.filter(isItem)
          .find(i => i.checked)?.id,
      ).toBe('profile:default')
      m?.pick('profile:default')
      m?.pick('profile:work')
      expect(log).toEqual([['profile', 'a', 'work']])
    } finally {
      world.uninstall()
    }
  })

  test('a lane’s move takes its Claude sessions not in the profile; the check turns, and goes with the move', () => {
    const { world, deps, log, updates, el } = page(PROFILES)
    try {
      const m = menuFor(el('lane-space'), { x: 10, y: 10 }, deps)
      // a and the one whose profile is not known go to Work; b and the unknown one to Personal.
      expect(
        find(m?.items, 'laneProfile')
          ?.submenu?.filter(isItem)
          .map(i => `${i.id} ${i.hint ?? ''}`),
      ).toEqual(['profile:default 2', 'profile:work 2', 'usual '])
      m?.pick('usual')
      expect(find(find(updates[0], 'laneProfile')?.submenu, 'usual')?.checked).toBe(true)
      m?.pick('profile:work')
      expect(log).toEqual([['lane', 'acme', 'work', ['a', 'c'], true]])
    } finally {
      world.uninstall()
    }
  })

  test('one profile shown: no Profile on the card, no move on the lane', () => {
    const { world, deps, el } = page(PROFILES.slice(0, 1))
    try {
      expect(find(menuFor(el('card-a'), { x: 10, y: 10 }, deps)?.items, 'profile')).toBeUndefined()
      expect(find(menuFor(el('lane-space'), { x: 10, y: 10 }, deps)?.items, 'laneProfile')).toBeUndefined()
    } finally {
      world.uninstall()
    }
  })
})

describe('the toasts and the calls (models/profile-move.ts)', () => {
  const busy: MoveResult = {
    target: 'a',
    result: 'refused',
    key: 'a',
    name: 'Billing',
    sleep: { result: 'kept', why: 'busy' },
  }

  test('a card: moved, once free, or why it stays, with "Move once it is free" for what passes', () => {
    expect(cardToast({ target: 'a', result: 'moved' }, 'Billing', 'Work', t)).toEqual({
      text: 'Billing moved to Work',
      error: false,
      later: [],
    })
    expect(cardToast(busy, 'Billing', 'Work', t)).toEqual({
      text: 'Billing stays where it is: it is working',
      error: true,
      later: ['a'],
    })
    const other = { target: 'a', result: 'refused' as const, why: 'it is running again' }
    expect(cardToast(other, 'Billing', 'Work', t)).toEqual({
      text: 'Billing stays where it is: it is running again',
      error: true,
      later: [],
    })
    expect(cardToast(busy, 'Billing', 'Work', ru).text).toBe('Billing остаётся, где была: она работает')
  })

  test('a lane: one toast for all of them', () => {
    const results: MoveResult[] = [
      { target: 'a', result: 'moved', key: 'a', name: 'A' },
      { target: 'b', result: 'moved', key: 'b', name: 'B' },
      { target: 'c', result: 'scheduled', key: 'c', name: 'C' },
      busy,
    ]
    expect(laneToast(results, 'Acme', 'Work', t, 'new sessions start in Work')).toEqual({
      text: 'Acme: 2 moved to Work, 1 once free, 1 refused (Billing: it is working), new sessions start in Work',
      error: false,
      later: ['a'],
    })
    expect(laneToast([busy], 'Acme', 'Work', t).error).toBe(true)
  })

  function calls(answers: Reply[]) {
    const posted: [string, unknown][] = []
    const toasts: [string, boolean | undefined, ToastOptions | undefined][] = []
    const busyLog: [string, string | null][] = []
    const deps: MoveDeps = {
      t: () => t,
      post: async (path, body) => {
        posted.push([path, body])
        return answers.shift() ?? { ok: true }
      },
      errorText: err => String(err),
      toast: (text, error, options) => void toasts.push([text, error, options]),
      busy: (key, label) => void busyLog.push([key, label]),
      title: id => (id === 'work' ? 'Work' : id),
      name: key => (key === 'a' ? 'Billing' : key),
    }
    return { deps, posted, toasts, busyLog }
  }

  test('a busy card is refused; "Move once it is free" asks again with whenFree', async () => {
    const { deps, posted, toasts, busyLog } = calls([
      { ok: true, results: [busy] },
      { ok: true, results: [{ target: 'a', result: 'scheduled', key: 'a', name: 'Billing' }] },
    ])
    await moveCard(deps, 'a', 'work')
    expect(posted).toEqual([['/api/move', { targets: ['a'], profile: 'work' }]])
    expect(busyLog).toEqual([
      ['a', 'Moving…'],
      ['a', null],
    ])
    const [text, error, options] = toasts[0] ?? []
    expect([text, error, options?.action?.label]).toEqual([
      'Billing stays where it is: it is working',
      true,
      'Move once it is free',
    ])
    options?.action?.run()
    await Bun.sleep(0)
    expect(posted[1]).toEqual(['/api/move', { targets: ['a'], profile: 'work', whenFree: true }])
    expect(toasts[1]?.slice(0, 2)).toEqual(['Billing moves to Work once it is free', false])
  })

  test('a lane with its check: the move and the lane’s usual profile, one toast', async () => {
    const { deps, posted, toasts } = calls([{ ok: true, results: [{ target: 'a', result: 'moved', name: 'Billing' }] }])
    await moveLane(deps, { id: 'acme', title: 'Acme' }, ['a'], 'work', true)
    expect(posted).toEqual([
      ['/api/move', { targets: ['a'], profile: 'work' }],
      ['/api/categories', { op: 'update', id: 'acme', profile: 'work' }],
    ])
    expect(toasts).toEqual([['Acme: 1 moved to Work, new sessions start in Work', false, {}]])
  })
})
