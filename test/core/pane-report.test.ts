// #243: `board doctor`'s line on what herdr's panes hold, and the panes labelled asleep that wake
// has no record of.
import { expect, test } from 'bun:test'
import { asMemoryTable, bareShell, treeBytes } from '../../src/adapters/pane-facts.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { type PaneFacts, paneChecks, wakeKeepsSleepers } from '../../src/core/pane-report.ts'

const MB = 2 ** 20
const en = translator('en')

/** A laptop after a reboot: Claude, two sleepers (one wake does not know), sidebars with and without one, a terminal and a server. */
const FACTS: PaneFacts = {
  panes: [
    { pane_id: 'w1:p1', agent: 'claude', label: '' },
    { pane_id: 'w1:p2', label: 'Sidebar', tokens: { 'herdr-sidebar-git': '1' } },
    { pane_id: 'w2:p1', label: '💤 Счета 100%' },
    { pane_id: 'w2:p2', label: 'Sidebar' },
    { pane_id: 'w3:p1', label: '💤 docs-8d' },
    { pane_id: 'w3:p2', label: 'Sidebar' },
    { pane_id: 'w4:p1', label: '' },
    { pane_id: 'w4:p2', label: 'Wake' },
  ],
  held: new Map([
    ['w1:p1', { bare: false, bytes: 600 * MB }],
    ['w1:p2', { bare: false, bytes: 100 * MB }],
    ['w2:p1', { bare: true, bytes: 75 * MB }],
    ['w2:p2', { bare: true, bytes: 75 * MB }],
    ['w3:p1', { bare: true, bytes: 75 * MB }],
    ['w3:p2', { bare: true, bytes: 75 * MB }],
    ['w4:p1', { bare: true, bytes: 75 * MB }],
    ['w4:p2', { bare: false, bytes: 125 * MB }],
  ]),
  sleepers: new Set(['w2:p1']),
}

test('what the panes hold: by kind, with their memory and how many are a bare shell', () => {
  const [line, ...rest] = paneChecks(FACTS, en)
  expect(line).toMatchObject({ id: 'panes', level: 'ok', title: 'herdr panes' })
  expect(line?.detail).toBe(
    '8 in all, 1.2 GB: agents: 1 (600 MB) · asleep in their pane: 2 (150 MB) · sidebars: 3 (250 MB), 2 of them a bare shell with no sidebar (150 MB) · other: 2 (200 MB), 1 of them a bare shell',
  )
  expect(rest).toEqual([
    {
      id: 'panes-unknown',
      level: 'warn',
      title: '1 pane is labelled asleep, but wake has no record of it',
      detail: '💤 docs-8d (w3:p1)',
      fix: expect.stringContaining('board resume <session id>'),
      code: '',
    },
  ])
})

test('wake off (herdr-wake keeps its own records): no pane is named; memory not read: a question mark', () => {
  const held = new Map([...FACTS.held.keys()].map(pane => [pane, { bare: null, bytes: null }]))
  const checks = paneChecks({ ...FACTS, held, sleepers: null }, en)
  expect(checks.map(c => c.id)).toEqual(['panes'])
  expect(checks[0]?.detail).toBe(
    '8 in all, ?: agents: 1 (?) · asleep in their pane: 2 (?) · sidebars: 3 (?) · other: 2 (?)',
  )
})

test('in Russian, with its plural', () => {
  const ru = translator('ru')
  const checks = paneChecks({ ...FACTS, sleepers: new Set() }, ru)
  expect(checks[0]?.title).toBe('Панели herdr')
  expect(checks[0]?.detail).toContain('спят в своей панели: 2 (150 МБ)')
  expect(checks[1]?.title).toBe('2 панели помечены спящими, но у сна нет о них записи')
})

test('the process table: PowerShell’s working set in bytes, ps’s resident size in KiB, names without folder or .exe', () => {
  expect(asMemoryTable('4000 12 78643200 pwsh.exe\r\n4001 4000 52428800 herdr-sidebar.exe\r\n\r\n', 1)).toEqual([
    { pid: 4000, ppid: 12, bytes: 75 * MB, name: 'pwsh' },
    { pid: 4001, ppid: 4000, bytes: 50 * MB, name: 'herdr-sidebar' },
  ])
  expect(asMemoryTable('  501     1  2048 -zsh\n  502   501 10240 /usr/local/bin/My App\n', 1024)).toEqual([
    { pid: 501, ppid: 1, bytes: 2 * MB, name: 'zsh' },
    { pid: 502, ppid: 501, bytes: 10 * MB, name: 'my app' },
  ])
  expect(asMemoryTable('', 1)).toBeNull()
})

test('a bare shell: a shell with nothing under it but Windows’ console host; a tree’s memory counts everything under it', () => {
  const table = [
    { pid: 10, ppid: 1, bytes: 75 * MB, name: 'pwsh' },
    { pid: 11, ppid: 10, bytes: 7 * MB, name: 'conhost' },
    { pid: 20, ppid: 1, bytes: 75 * MB, name: 'pwsh' },
    { pid: 21, ppid: 20, bytes: 30 * MB, name: 'herdr-sidebar' },
    { pid: 30, ppid: 1, bytes: 40 * MB, name: 'bun' },
    { pid: 40, ppid: 1, bytes: 5 * MB, name: 'cmd' },
    { pid: 41, ppid: 40, bytes: 300 * MB, name: 'claude' },
    { pid: 42, ppid: 41, bytes: 100 * MB, name: 'node' },
  ]
  expect([10, 20, 30, 40, 99].map(pid => bareShell(table, pid))).toEqual([true, false, false, false, null])
  expect([10, 20, 30, 40, 99].map(pid => treeBytes(table, pid))).toEqual([82 * MB, 105 * MB, 40 * MB, 405 * MB, null])
})

test('wake’s records name what is asleep only while the board’s wake runs, or is starting', () => {
  expect(wakeKeepsSleepers('running')).toBe(true)
  expect(wakeKeepsSleepers('starting')).toBe(true)
  // herdr-wake holds the line (its own records), or the board's wake is not there to keep them.
  for (const state of ['held', 'portTaken', 'off', 'crashed', 'notRunning', undefined] as const)
    expect([state, wakeKeepsSleepers(state)]).toEqual([state, false])
})
