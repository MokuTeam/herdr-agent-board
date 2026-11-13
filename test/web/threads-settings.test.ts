// Settings → Threads (#410): the row beside Tasks, its modes as the payload says them, Team's
// sharing choice while Team and threads are on, and what a pick asks the board for.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { THREAD_MODES, threadModeOf, threadsConfig, threadsSetting } from '../../src/core/work-threads.ts'
import { settingsMenuFrom, type ThreadsSetting } from '../../web/src/hooks/useSettingsMenu.ts'
import type { MenuEntry } from '../../web/src/models/menu-model.ts'
import { settingPicked, settingsMenu, threadsNow } from '../../web/src/models/settings-menu.ts'

const en = translator('en')
const ru = translator('ru')
const now = {
  t: en,
  theme: 'auto',
  languages: { en: 'English' },
  canEdit: true,
  dock: 'right' as const,
  sleepers: false,
  profiles: false,
}
type Sub = { id: string; label: string; disabled?: boolean; submenu: Record<string, unknown>[] }
const entry = (items: readonly MenuEntry[], id: string) =>
  items.find(i => 'id' in i && i.id === id) as unknown as Sub | undefined
const lines = (sub: Sub | undefined) =>
  (sub?.submenu ?? []).map(i => ('separator' in i ? '---' : `${i.id}${i.checked ? ' ✓' : ''}`))
const ids = (items: MenuEntry[]) => items.flatMap(i => ('id' in i ? [i.id] : []))

test('the row comes right after Tasks, off checked; none on a page that is not given it', () => {
  const items = settingsMenu({ ...now, todos: 'none', threads: 'none', compact: '' })
  expect(ids(items).slice(ids(items).indexOf('todos'), ids(items).indexOf('todos') + 3)).toEqual([
    'todos',
    'threads',
    'compact',
  ])
  const row = entry(items, 'threads')
  expect(row?.label).toBe('Threads')
  expect(lines(row)).toEqual(['threads:none ✓', 'threads:mine', 'threads:agents'])
  expect(row?.submenu.map(i => i.label)).toEqual(['Off', 'Only me', 'Me and agents'])
  // Another device's page, an older board: no row at all, the menu as it was.
  expect(entry(settingsMenu({ ...now, todos: 'none' }), 'threads')).toBeUndefined()
  expect(ids(settingsMenu({ ...now, todos: 'none' }))).not.toContain('threads')
  // Gray without the board, with the reason, as Tasks.
  expect(entry(settingsMenu({ ...now, threads: 'none', canEdit: false }), 'threads')).toMatchObject({ disabled: true })
  expect(entry(settingsMenu({ ...now, t: ru, threads: 'mine' }), 'threads')?.label).toBe('Треды')
})

test("Team's sharing choice: only while threads and Team are on, the board's own checked", () => {
  expect(lines(entry(settingsMenu({ ...now, threads: 'agents' }), 'threads'))).toEqual([
    'threads:none',
    'threads:mine',
    'threads:agents ✓',
  ])
  expect(lines(entry(settingsMenu({ ...now, threads: 'mine', threadsShare: true }), 'threads'))).toEqual([
    'threads:none',
    'threads:mine ✓',
    'threads:agents',
    '---',
    'threadsShare:shared ✓',
    'threadsShare:local',
  ])
  expect(lines(entry(settingsMenu({ ...now, threads: 'agents', threadsShare: false }), 'threads')).slice(-2)).toEqual([
    'threadsShare:shared',
    'threadsShare:local ✓',
  ])
  // Off: nothing to share.
  expect(lines(entry(settingsMenu({ ...now, threads: 'none', threadsShare: true }), 'threads'))).toHaveLength(3)
})

test('the mode as the payload says it: off without its line; mine and local only where config.json says so', () => {
  expect(threadsNow({})).toEqual({ mode: 'none' })
  expect(threadsNow({ teamRev: 3 })).toEqual({ mode: 'none' })
  expect(threadsNow({ threads: {} })).toEqual({ mode: 'agents' })
  expect(threadsNow({ threads: { agents: false } })).toEqual({ mode: 'mine' })
  expect(threadsNow({ threads: {}, teamRev: 3 })).toEqual({ mode: 'agents', share: true })
  expect(threadsNow({ threads: { share: false }, teamRev: 0 })).toEqual({ mode: 'agents', share: false })
})

test('a pick: the mode, or sharing; anything else is no pick', () => {
  expect(settingPicked('threads:none')).toEqual({ kind: 'threads', value: 'none' })
  expect(settingPicked('threads:mine')).toEqual({ kind: 'threads', value: 'mine' })
  expect(settingPicked('threads:agents')).toEqual({ kind: 'threads', value: 'agents' })
  expect(settingPicked('threads:all')).toBeNull()
  expect(settingPicked('threadsShare:shared')).toEqual({ kind: 'threadsShare', value: true })
  expect(settingPicked('threadsShare:local')).toEqual({ kind: 'threadsShare', value: false })
  expect(settingPicked('threadsShare:maybe')).toBeNull()
})

test('each mode maps to its config.json value and back', () => {
  const values = THREAD_MODES.map(mode => threadsSetting(undefined, { mode }))
  expect(values).toEqual([undefined, { agents: false }, true])
  expect(values.map(v => threadModeOf(threadsConfig(v)))).toEqual([...THREAD_MODES])
  // Through the payload's line: test/server/threads-settings.test.ts.
})

test('out of the gear: a pick asks the board for that mode or that sharing', () => {
  const asked: ThreadsSetting[] = []
  let picked: (id: string) => void = () => {}
  let shown: readonly MenuEntry[] = []
  const open = settingsMenuFrom({
    menu: {
      open(items, opts) {
        shown = items
        picked = id => opts.onPick?.(id, { id, label: id })
      },
    },
    t: () => en,
    canEdit: () => true,
    languages: () => ({ en: 'English' }),
    dock: () => 'right',
    sleepers: () => false,
    root: () => ({ dataset: {} }),
    coarse: () => false,
    setTheme() {},
    chooseLanguage() {},
    placePanels() {},
    resetPanelSize() {},
    toggleSleepers() {},
    profiles: () => false,
    openProfiles() {},
    fold: () => null,
    chooseFold() {},
    todos: () => 'none',
    threads: () => 'agents',
    threadsShare: () => true,
    chooseThreads: body => void asked.push(body),
  })
  open({ getBoundingClientRect: () => ({ right: 0, bottom: 0 }) } as HTMLElement, false)
  expect(lines(entry(shown, 'threads'))).toContain('threadsShare:shared ✓')
  picked('threads:mine')
  picked('threads:none')
  picked('threadsShare:local')
  expect(asked).toEqual([{ mode: 'mine' }, { mode: 'none' }, { share: false }])
})
