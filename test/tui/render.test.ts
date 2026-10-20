// The expected output in __snapshots__/render.test.ts.snap was generated once from the board's code
// before it was split into src/tui/ (the old functions run on this same state), so these tests
// hold the split to the old output byte for byte. The state does not depend on the machine:
// a fixed clock, English, and a UTC time zone (the header shows the local time).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { useLanguage } from '../../src/core/lang.ts'
import type { Profile } from '../../src/core/profiles.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import type { Config, Item } from '../../src/core/types.ts'
import { render } from '../../src/tui/render.ts'
import { build, createState, type TuiState } from '../../src/tui/state.ts'

const NOW = Date.UTC(2026, 9, 16, 12, 30)
const MIN = 60_000

const cfg: Config = {
  language: 'en',
  categories: [
    { id: 'work', title: 'Work', color: 'cyan', paths: [] },
    { id: 'personal', title: 'Personal', color: 'green', paths: [] },
  ],
  placement: 'workspace',
  workspace: 'Board',
  refreshSec: 2,
  wakeUrl: null,
  scheduleWaitMin: 240,
}

const item = (fields: Partial<Item> & Pick<Item, 'key' | 'name' | 'category' | 'column' | 'status'>): Item => ({
  session: null,
  pane: null,
  workspace: null,
  cwd: '',
  autoName: fields.name,
  categorySet: true,
  attention: '',
  ...fields,
})

/** 2 lanes, 3 items: one working with an alarm, one needing a decision, one asleep. */
function fixedState(): TuiState {
  const state = createState(cfg, true)
  state.now = NOW
  state.loading = false
  state.items = [
    item({
      key: 'k1',
      name: 'api-server',
      category: 'work',
      column: 'work',
      status: 'working',
      activity: NOW - 5 * MIN,
      doing: 'Refactoring the auth middleware',
      pane: 'p1',
    }),
    item({
      key: 'k2',
      name: 'Привет мир',
      category: 'work',
      column: 'me',
      status: 'blocked',
      activity: NOW - 180 * MIN,
      question: 'Delete 日本 build output?',
      pane: 'p2',
    }),
    item({
      key: 'k3',
      name: 'notes',
      category: 'personal',
      column: 'idle',
      status: 'sleeping',
      sleeping: true,
      activity: NOW - 2880 * MIN,
      result: 'finished earlier',
      pane: 'p3',
    }),
  ]
  const alarm: ScheduleEntry = { id: 'a1b2c3', key: 'k1', text: 'ping', next: NOW + 60 * MIN }
  state.alarms = new Map([['k1', alarm]])
  state.scheduled = 1
  build(state)
  return state
}

const BIG = { columns: 120, rows: 40 }
let tz: string | undefined
beforeAll(() => {
  tz = process.env.TZ
  process.env.TZ = 'UTC'
  useLanguage('en')
})
afterAll(() => {
  if (tz === undefined) delete process.env.TZ
  else process.env.TZ = tz
})

test('render 120x40', () => {
  expect(render(fixedState(), BIG)).toMatchSnapshot()
})

test('render 80x30', () => {
  expect(render(fixedState(), { columns: 80, rows: 30 })).toMatchSnapshot()
})

test('render text input 80x30', () => {
  const state = fixedState()
  state.sel = 'k2'
  state.mode = 'input'
  state.input = { label: 'Message for Привет мир', text: 'hello 日本', submit() {} }
  expect(render(state, { columns: 80, rows: 30 })).toMatchSnapshot()
})

test('render category picker with a busy card 120x40', () => {
  const state = fixedState()
  state.mode = 'category'
  state.busy.set('k1', 'sending…')
  expect(render(state, BIG)).toMatchSnapshot()
})

test('render filtered lane with a flash 120x40', () => {
  const state = fixedState()
  state.flash = { text: 'Moved', error: false, until: NOW + 1000 }
  state.filter = 'work'
  build(state)
  expect(render(state, BIG)).toMatchSnapshot()
})

const PRIVATE: Profile = { id: 'default', title: 'Private', dir: 'C:/Users/me/.claude', color: 'indigo', hidden: false }
const WORK: Profile = { id: 'work', title: 'Work', dir: 'C:/Users/me/.claude-work', color: 'teal', hidden: false }

const itemOf = (state: TuiState, key: string): Item => {
  const it = state.items.find(i => i.key === key)
  if (!it) throw new Error(`no item ${key}`)
  return it
}

/** The screen's rows as they read: the cursor moves and the styles taken out. */
const plainRows = (screen: string): string[] =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape sequences are what it splits on and strips
  screen.split(/\x1b\[\d+;1H/).map(row => row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))

test('a profile tag with two shown profiles; none with one', () => {
  const two = fixedState()
  two.profiles = [PRIVATE, WORK]
  itemOf(two, 'k1').profile = 'work'
  // k1's line is the one with its alarm; the lane above it is called Work too.
  for (const size of [
    { columns: 160, rows: 40 },
    { columns: 80, rows: 30 },
  ]) {
    const line = plainRows(render(two, size)).find(row => row.includes('⏰1:30'))
    expect(line).toContain('Work')
  }
  const one = fixedState()
  one.profiles = [PRIVATE]
  for (const it of one.items) it.profile = 'default'
  expect(render(one, BIG)).toBe(render(fixedState(), BIG))
  expect(render(one, { columns: 80, rows: 30 })).toBe(render(fixedState(), { columns: 80, rows: 30 }))
})

test('a tag in its profile color, an unknown folder in gray, a wrong profile in red', () => {
  const state = fixedState()
  state.profiles = [PRIVATE, WORK]
  itemOf(state, 'k1').profileFolder = 'D:/elsewhere/.claude'
  itemOf(state, 'k2').profile = 'work'
  Object.assign(itemOf(state, 'k3'), { profile: 'default', profileWanted: 'work' })
  const screen = render(state, { columns: 80, rows: 30 })
  // k1 selected (inverse), k2 as it is, k3 asleep (dim).
  expect(screen).toContain('\x1b[90;7munknown profile\x1b[0m')
  expect(screen).toContain('\x1b[36mWork\x1b[0m')
  expect(screen).toContain('\x1b[31;2mwrong profile\x1b[0m')
  itemOf(state, 'k2').profile = 'default'
  expect(render(state, { columns: 80, rows: 30 })).toContain('\x1b[34mPrivate\x1b[0m')
})

test('render does not touch stdout', () => {
  const write = process.stdout.write
  let wrote = false
  process.stdout.write = (() => {
    wrote = true
    return true
  }) as typeof process.stdout.write
  try {
    render(fixedState(), BIG)
  } finally {
    process.stdout.write = write
  }
  expect(wrote).toBe(false)
})

test('a restart on its way shows ↻ by the card, in place of the clock (upstream’s alarm at #51)', () => {
  const state = fixedState()
  state.alarms = new Map([['k1', { id: 'a1b2c3', key: 'k1', kind: 'restart', idle: true, text: '', next: NOW - MIN }]])
  for (const size of [BIG, { columns: 80, rows: 30 }]) {
    const line = plainRows(render(state, size)).find(row => row.includes('api-server'))
    expect(line).toContain('↻ ')
    expect(line).not.toMatch(/[⏳⏰]/)
  }
})

test('a favorite: a star before its name, and whole while it sleeps in Idle (#64)', () => {
  const state = fixedState()
  itemOf(state, 'k3').favorite = true
  for (const size of [BIG, { columns: 80, rows: 30 }]) {
    const rows = plainRows(render(state, size))
    expect(rows.some(row => row.includes('★ notes'))).toBe(true)
  }
  // Asleep in Idle it keeps its second line (its result), where the others take one.
  const wide = plainRows(render(state, BIG))
  expect(wide.some(row => row.includes('finished earlier'))).toBe(true)
  expect(plainRows(render(fixedState(), BIG)).some(row => row.includes('finished earlier'))).toBe(false)
})
