// The day and week grid's hours on a real DOM (jsdom, #339): twelve of them fill the grid's room
// under its head, so a tall panel still has the day to scroll through and opens at what matters (an
// hour before now on today, else the first event), as Apple Calendar's "Show 12 hours at a time"; a
// short one keeps hours of 44 px; a resize keeps the hour at the top where it was. jsdom lays nothing
// out: the grid's height and the rows' heights are the test's own, the rows' read from the hour the
// grid was given; the room around the lines is calendar.css's own rule. The clock is the test's own
// (16:26 on a Friday); events are invented.
import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { CalEvent } from '../../src/core/calendar.ts'
import { firstHour, HOUR_MIN, HOURS_AT_A_TIME, hourSize, localDate } from '../../web/src/models/calendar.ts'

let createRoot: typeof import('react-dom/client').createRoot
let TimeGrid: typeof import('../../web/src/components/calendar/CalendarViews.tsx').TimeGrid
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const g = globalThis as Record<string, unknown>
const win = dom.window as unknown as Record<string, unknown> & { HTMLElement: typeof HTMLElement }
const NAMES = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'ResizeObserver',
  'getComputedStyle',
  'IS_REACT_ACT_ENVIRONMENT',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const set = (name: string, value: unknown) =>
  Object.defineProperty(g, name, { value, configurable: true, writable: true })

/** The grid's height on screen, and its head's (the days and the all-day strip). */
let gridHeight = 0
const TOP = 80
/** The room above the first line and below the last, for their labels (calendar.css: 8px each). */
const AROUND = 16
const NOW = new Date(2026, 10, 6, 16, 26)
/** The ResizeObserver callbacks the grid set up, run by the test as a resize would. */
const observers: (() => void)[] = []

beforeAll(async () => {
  for (const k of NAMES) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'])
    set(k, win[k])
  set('IS_REACT_ACT_ENVIRONMENT', true)
  set('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  setSystemTime(NOW)
  // the stylesheet's own rule for the room around the lines
  const rule = /\n\.cal-hours \{[^}]*padding[^}]*\}/.exec(
    readFileSync(join(import.meta.dir, '..', '..', 'web', 'styles', 'calendar.css'), 'utf8'),
  )?.[0]
  expect(rule).toContain('padding: 8px 0;')
  const style = document.createElement('style')
  style.textContent = rule ?? ''
  document.head.append(style)
  set(
    'ResizeObserver',
    class {
      constructor(readonly fn: () => void) {
        observers.push(fn)
      }
      observe() {}
      disconnect() {}
    },
  )
  const proto = win.HTMLElement.prototype
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('cal-grid') ? gridHeight : 0
    },
  })
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('cal-top')) return TOP
      if (this.classList.contains('cal-hour-row')) {
        const own = this.closest<HTMLElement>('.cal-grid')?.style.getPropertyValue('--cal-hour')
        return own ? Number.parseInt(own, 10) : HOUR_MIN
      }
      return 0
    },
  })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ TimeGrid } = await import('../../web/src/components/calendar/CalendarViews.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
})

afterAll(() => {
  setSystemTime()
  const proto = win.HTMLElement.prototype as unknown as Record<string, unknown>
  Reflect.deleteProperty(proto, 'clientHeight')
  Reflect.deleteProperty(proto, 'offsetHeight')
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else Reflect.deleteProperty(g, k)
  }
  dom.window.close()
})

let root: Root | null = null
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  observers.length = 0
})

const DAY = 86_400_000
const weekOf = (at: number): string[] => Array.from({ length: 7 }, (_, i) => localDate(at + (i - 3) * DAY))
const event = (start: Date, minutes: number): CalEvent => ({
  source: 'board',
  id: `e${start.getTime()}`,
  title: 'Design review',
  start: start.toISOString(),
  end: new Date(start.getTime() + minutes * 60_000).toISOString(),
  allDay: false,
  status: 'confirmed',
})

async function render(days: string[], events: CalEvent[] = []): Promise<HTMLElement> {
  const tree = (
    <I18nProvider lang="en">
      <TimeGrid
        days={days}
        events={events}
        marks={{ color: () => '#336699', label: () => 'Work' }}
        now={Date.now()}
        lang="en"
        onPick={() => {}}
      />
    </I18nProvider>
  )
  if (!root) root = createRoot(document.getElementById('root') as HTMLElement)
  await act(async () => root?.render(tree))
  return document.querySelector('.cal-grid') as HTMLElement
}

const hourOf = (grid: HTMLElement): number => Number.parseInt(grid.style.getPropertyValue('--cal-hour'), 10)

test('an hour is the room under the grid’s head over twelve, in whole pixels, never under 44 px', () => {
  expect(HOURS_AT_A_TIME).toBe(12)
  expect(hourSize(1144)).toBe(95)
  expect(hourSize(1150)).toBe(95)
  expect(hourSize(12 * 44)).toBe(44)
  expect(hourSize(300)).toBe(44)
  expect(hourSize(0)).toBe(44)
})

test('a tall week opens on today an hour before now, with hours that fill the grid twelve at a time', async () => {
  gridHeight = TOP + AROUND + 1144
  const days = weekOf(Date.now())
  const grid = await render(days)
  expect(hourOf(grid)).toBe(95)
  // the hours fitted before the grid scrolled: the scroll counts in the fitted hour, not in 44 px
  expect(firstHour(days, [], Date.now())).toBe(15)
  expect(grid.scrollTop).toBe(15 * 95)
})

test('a week without today opens an hour before its first event', async () => {
  gridHeight = TOP + AROUND + 720
  const monday = new Date(Date.now() - 30 * DAY)
  monday.setHours(14, 30, 0, 0)
  const days = weekOf(monday.getTime())
  const grid = await render(days, [event(monday, 45)])
  expect(hourOf(grid)).toBe(60)
  expect(grid.scrollTop).toBe(13 * 60)
})

test('a short grid keeps hours of 44 px and scrolls through them', async () => {
  gridHeight = TOP + AROUND + 300
  const days = weekOf(Date.now())
  const grid = await render(days)
  expect(hourOf(grid)).toBe(44)
  expect(grid.scrollTop).toBe(15 * 44)
})

test('a resize refits the hours and keeps the hour at the top where it was', async () => {
  gridHeight = TOP + AROUND + 720
  const monday = new Date(Date.now() - 30 * DAY)
  monday.setHours(9, 0, 0, 0)
  const grid = await render(weekOf(monday.getTime()), [event(monday, 60)])
  expect([hourOf(grid), grid.scrollTop]).toEqual([60, 8 * 60])
  gridHeight = TOP + AROUND + 1200
  await act(async () => {
    for (const fn of observers) fn()
  })
  expect([hourOf(grid), grid.scrollTop]).toEqual([100, 8 * 100])
  // the same size again: nothing moves
  grid.scrollTop = 777
  await act(async () => {
    for (const fn of observers) fn()
  })
  expect([hourOf(grid), grid.scrollTop]).toEqual([100, 777])
})
