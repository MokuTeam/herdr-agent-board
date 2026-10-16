// The expected output in __snapshots__/render.test.ts.snap was generated once from the board's code
// before it was split into src/tui/ (the old functions run on this same state), so these tests
// hold the split to the old output byte for byte. The state does not depend on the machine:
// a fixed clock, English, and a UTC time zone (the header shows the local time).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { useLanguage } from '../../src/core/lang.ts'
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
