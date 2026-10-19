// The archive's menus (upstream's test/archive.test.mjs "menus" at #56, 2b9e6b7): Archive on a
// Claude session's card, gray with the reason; "Idle"'s column menu and a lane's take their
// sleeping ones, with a count for each age; the board's opens the archive. Then the same items
// as upstream's own menu-model.js gave them, case by case, and which menu opens where (the
// column heads, a lane's own column label) with what its picks do, against upstream's
// board-menus.js at the same merge (support/board-menu-sides.ts).
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { cardMenu, columnMenu, laneMenu, type MenuEntry, type MenuItem } from '../../web/src/models/menu-model.ts'
import { item } from './support/board.tsx'
import { type BoardScene, type MenuSide, oldBoardMenus, reactBoardMenus, scene } from './support/board-menu-sides.ts'
import { oldCode, oldFunction } from './support/old-app.ts'

const MERGE = '2b9e6b7'
const t = translator('en')
const S = '0f8fad5b-d9cb-469f-a165-70867728950e'

const isItem = (i: MenuEntry): i is MenuItem => !i.separator
const ids = (items: readonly MenuEntry[]) => items.filter(isItem).map(i => i.id)
const find = (items: readonly MenuEntry[] | null | undefined, id: string) =>
  (items ?? []).filter(isItem).find(i => i.id === id)

test('menus: Archive on a Claude session’s card, gray with the reason; "Idle" and a lane take their sleeping ones', () => {
  const ctx = { t, canMutate: true, canEdit: true, categories: [], column: 'idle', category: 'other' }
  const it = {
    key: S,
    session: S,
    agent: 'claude',
    pane: 'wP:p1',
    cwd: 'C:\\x',
    status: 'idle',
    column: 'idle',
    auto: 'idle',
  }
  expect(ids(cardMenu(it, ctx)).slice(-2)).toEqual(['archive', 'clear'])
  const gray = find(cardMenu(it, { ...ctx, archiveWhy: 'archive.why.working' }), 'archive')
  expect(gray?.disabled).toBe(true)
  expect(gray?.reason ?? '').toMatch(/working/)
  expect(find(cardMenu(it, { ...ctx, canMutate: false }), 'archive')?.disabled).toBe(true)
  expect(find(cardMenu({ ...it, agent: 'codex' }, ctx), 'archive')).toBe(undefined)

  const counts: Record<number, number> = { 0: 5, 1: 4, 3: 2, 7: 0 }
  const idle = columnMenu('idle', { ...ctx, tidyCount: d => counts[d] ?? 0 })
  expect((find(idle, 'tidy')?.submenu ?? []).filter(isItem).map(i => [i.id, i.label, i.hint, !!i.disabled])).toEqual([
    ['tidy:1', 'Asleep over 1 day', '4', false],
    ['tidy:3', 'Asleep over 3 days', '2', false],
    ['tidy:7', 'Asleep over a week', '0', true],
    ['tidy:0', 'All sleeping ones', '5', false],
  ])
  expect(columnMenu('done', { ...ctx, tidyCount: () => 1 })).toBe(null)
  const none = find(columnMenu('idle', { ...ctx, tidyCount: () => 0 }), 'tidy')
  expect([none?.disabled, none?.reason]).toEqual([true, 'No session sleeps in “Idle”'])
  expect(find(columnMenu('idle', { ...ctx, canMutate: false, tidyCount: () => 3 }), 'tidy')?.disabled).toBe(true)
  expect(
    find(
      laneMenu({ id: 'acme', title: 'Acme', color: '' }, { ...ctx, filter: 'all', tidyCount: d => counts[d] ?? 0 }),
      'tidy',
    )?.submenu,
  ).toBeTruthy()
})

test('the column’s and the lane’s menus are upstream’s columnMenu and laneMenu, case by case', () => {
  const archive = oldCode('web/archive-model.js', ['DAY', 'TIDY_DAYS'], {}, MERGE)
  const old = oldCode(
    'web/menu-model.js',
    ['SEP', 'tidy', 'tidyItem', 'columnMenu', 'laneMenu'],
    { TIDY_DAYS: archive.get('TIDY_DAYS') },
    MERGE,
  )
  const lane = { id: 'acme', title: 'Acme', color: '#007AFF' }
  for (const tr of [t, translator('ru')])
    for (const canMutate of [true, false])
      for (const canEdit of [true, false])
        for (const counts of [{}, { 0: 3 }, { 0: 5, 1: 4, 3: 2, 7: 0 }, { 0: 9, 1: 9, 3: 9, 7: 9 }]) {
          const tidyCount = (d: number): number => (counts as Record<number, number>)[d] ?? 0
          const c = { t: tr, canMutate, canEdit, tidyCount }
          for (const col of ['work', 'me', 'ext', 'done', 'idle', undefined])
            expect<unknown>(columnMenu(col, c)).toEqual(oldFunction(old, 'columnMenu')(col, c))
          for (const filter of ['all', 'acme']) {
            expect<unknown>(laneMenu(lane, { ...c, filter })).toEqual(
              oldFunction(old, 'laneMenu')(lane, { ...c, filter }),
            )
            // Without a count (the board's own lanes before #56): no tidy-up.
            const plain = { t: tr, canMutate, canEdit, filter }
            expect<unknown>(laneMenu(lane, plain)).toEqual(oldFunction(old, 'laneMenu')(lane, plain))
          }
        }
})

// ---------------------------------------------------------------- which menu opens, and its picks

type Step = (side: MenuSide) => Promise<unknown> | unknown

async function run(make: () => MenuSide, steps: Step[]): Promise<string[]> {
  const side = make()
  try {
    for (const step of steps) await step(side)
    return side.log
  } finally {
    await side.dispose()
  }
}

async function compare(s: BoardScene, steps: Step[]): Promise<string[]> {
  const baseline = await run(() => oldBoardMenus(s), steps)
  const react = await run(() => reactBoardMenus(s), steps)
  expect(react.join('\n')).toBe(baseline.join('\n'))
  return baseline
}

const session = item({
  key: 's1',
  name: 'acme',
  cwd: 'C:\\Acme',
  pane: 'w1:p1',
  category: 'acme',
  column: 'idle',
  agent: 'claude',
  sleeping: true,
  status: 'sleeping',
})
const TIDY = {
  'shown:0': 4,
  'shown:1': 3,
  'shown:3': 1,
  'shown:7': 0,
  'acme:0': 2,
  'acme:1': 1,
  'acme:3': 0,
  'acme:7': 0,
}
const right =
  (id: string, x = 50, y = 50) =>
  (side: MenuSide) =>
    side.fire(side.page(id), 'contextmenu', { button: 2, clientX: x, clientY: y })

describe('which menu opens, against upstream’s board-menus.js at #56', () => {
  test('a card’s Archive, gray with the reason while it cannot go; its pick archives it', async () => {
    const log = await compare(scene({ items: [session], tidy: TIDY }), [right('card'), s => s.pick('archive')])
    expect(log.join('\n')).toMatch(/do\.archive\("s1"/)
    const working = { ...session, sleeping: false, status: 'working' as const, column: 'work' as const }
    const gray = await compare(scene({ items: [working] }), [right('card')])
    expect(gray.join('\n')).toMatch(/archive \(gray\)/)
  })

  test('"Idle"’s head in the toolbar: the tidy-up of the lanes on show, by age, and the archive; other heads have none', async () => {
    const log = await compare(scene({ items: [session], tidy: TIDY }), [
      right('head-idle-t'),
      s => s.pick('tidy:3'),
      right('head-idle'),
      s => s.pick('archiveOpen'),
      right('head-work-t'),
    ])
    expect(log.join('\n')).toMatch(/do\.tidy\(3, null\)/)
    expect(log.join('\n')).toMatch(/do\.archiveOpen\(\)/)
  })

  test('a lane’s own "Idle" label (a narrow window): that lane’s tidy-up; its other labels give the lane’s menu', async () => {
    const log = await compare(scene({ items: [session], tidy: TIDY }), [
      right('col-label-idle-t'),
      s => s.pick('tidy:1'),
      right('col-label-work'),
    ])
    expect(log.join('\n')).toMatch(/do\.tidy\(1, "acme"\)/)
  })

  test('a lane’s menu has its tidy-up; the board’s opens the archive; nothing asleep: gray, with why', async () => {
    const log = await compare(scene({ items: [session], tidy: TIDY }), [
      right('lane-head'),
      s => s.pick('tidy:0'),
      right('board-empty'),
      s => s.pick('archiveOpen'),
    ])
    expect(log.join('\n')).toMatch(/do\.tidy\(0, "acme"\)/)
    await compare(scene({ items: [session] }), [right('lane-head'), right('head-idle')])
    await compare(scene({ items: [session], tidy: TIDY, canMutate: false }), [right('lane-head'), right('head-idle')])
  })
})
