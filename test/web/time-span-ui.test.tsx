// The Time panel's week and month as the owner uses them (#241, components/time/TimePanel.tsx and
// TimeSpanView.tsx), on a real DOM (jsdom) against the real route of a sandboxed board: Day, Week
// and Month as one switch; a week's seven days with their figures and marks, each a way into its
// day; a month as the Calendar's grid with a legend; one client picked; the arrows and a swipe by
// the view's unit; in English and Russian (the week starting on Monday there); at a phone's width.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { openDb } from '../../src/adapters/db.ts'
import { addEntry } from '../../src/adapters/time-store.ts'
import { freshTarget } from '../../src/core/backup.ts'
import { makeKey } from '../../src/core/backup-file.ts'
import { instantIn, timeConfig } from '../../src/core/time.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox } from '../support/sandbox.ts'
import type { board as Board, payload as Payload } from './support/board.tsx'

let createRoot: typeof import('react-dom/client').createRoot
let TimePanel: typeof import('../../web/src/components/time/TimePanel.tsx').TimePanel
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let PanelProvider: typeof import('../../web/src/state/PanelProvider.tsx').PanelProvider
let board: typeof Board
let payload: typeof Payload

const TIME = {
  zone: 'America/New_York',
  clients: {
    'client-a': { projects: ['Support'], billing: [{ group: 'ref', step: 30, round: 'up' }] },
    // entered into an ERP: what is not there yet is marked
    'client-s': { projects: ['Support'], systems: ['erp'] },
    // time only in December: on the edge of November's grid, in none of November's figures
    'client-e': { projects: ['Support'] },
  },
}
const conf = timeConfig(TIME)
/** The board's today: a Friday. Its week is 1 to 7 November from a Sunday, 2 to 8 from a Monday. */
const TODAY = '2026-11-06'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const g = globalThis as Record<string, unknown>
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'MutationObserver',
  'getComputedStyle',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const realFetch = globalThis.fetch

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto.setPointerCapture = () => {}
  for (const k of [
    ...DOM_GLOBALS,
    'IS_REACT_ACT_ENVIRONMENT',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'ResizeObserver',
    'matchMedia',
    'devicePixelRatio',
  ])
    saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  Object.defineProperty(g, 'matchMedia', { value: win.matchMedia, configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.requestAnimationFrame = (f: (now: number) => void) => setTimeout(() => f(performance.now()), 16)
  g.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  g.devicePixelRatio = 1
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ TimePanel } = await import('../../web/src/components/time/TimePanel.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ PanelProvider } = await import('../../web/src/state/PanelProvider.tsx'))
  ;({ board, payload } = await import('./support/board.tsx'))
})

afterAll(async () => {
  await new Promise(r => setTimeout(r, 1500))
  globalThis.fetch = realFetch
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const settle = async (ms = 300) => {
  await act(async () => {
    await sleep(ms)
  })
}
const q = (sel: string) => dom.window.document.querySelector(sel) as HTMLElement
const qa = (sel: string) => [...dom.window.document.querySelectorAll(sel)] as HTMLElement[]
/** Text as read here: the no-break spaces inside a duration ("2 h 30 min") as plain ones. */
const norm = (s: string | null | undefined) => (s ?? '').replace(/\u00a0/g, ' ')
const text = (sel: string) => norm(q(sel)?.textContent)
const label = (el: Element | undefined) => norm(el?.getAttribute('aria-label'))
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => {
    el?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}
const tab = (name: string) => qa('.time-views button').find(b => b.textContent === name)
/** A week's row or a month's cell by its date's day of the month. */
const weekRow = (n: number) =>
  qa('.time-week-day').find(b => b.querySelector('.time-wd-num')?.textContent === String(n))
const monthCell = (n: number) =>
  qa('.time-month-day:not(.other)').find(b => b.querySelector('.cal-month-dn')?.textContent === String(n))

/** A board with a week of entries: Monday client A, Tuesday nothing, Wednesday both clients, Thursday held only. */
async function setup() {
  const box = await sandbox()
  const folder = join(box.dir, 'Sync')
  mkdirSync(folder)
  const state = join(box.dir, 'state', 'herdr', 'plugins', 'agent-board')
  mkdirSync(join(state, 'backup'), { recursive: true })
  writeFileSync(
    join(state, 'backup', 'backup-key.json'),
    JSON.stringify(makeKey('correct horse battery', 1, { logN: 10, r: 8, p: 1 })),
  )
  writeFileSync(
    join(state, 'backup', 'status.json'),
    JSON.stringify({ targets: { folder: { ...freshTarget(), tested: Date.now(), where: folder } } }),
  )
  const db = openDb({ path: join(state, 'board.db'), create: true })
  if (!db || !conf) throw new Error('no database')
  const add = (client: string, description: string, date: string, h: number, minutes: number, tags: string[] = []) =>
    addEntry(
      db,
      conf,
      {
        client,
        project: 'Support',
        description,
        tags,
        start: instantIn(date, [h, 0, 0], conf.zone),
        stop: instantIn(date, [h, 0, 0], conf.zone) + minutes * 60_000,
        startGiven: true,
      },
      { key: 's1', name: 'One' },
    )
  add('client-a', 'Case 10001 X: Monday', '2026-11-02', 10, 40)
  add('client-a', 'Case 10002 X: Wednesday', '2026-11-04', 10, 20)
  add('client-s', 'Case 20001: Wednesday', '2026-11-04', 14, 90)
  add('client-a', 'Case 10003 X: later', '2026-11-05', 10, 30, ['deferred'])
  add('client-e', 'Case 30001: December', '2026-12-03', 10, 60)
  db.close()
  const { url } = await serveBoard(box, { language: 'en', time: TIME, backup: { folder } })
  globalThis.fetch = ((u: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof u === 'string' && u.startsWith('/') ? url + u : u, init)) as typeof fetch
}

function view(lang: 'en' | 'ru', client: string | null, width: number) {
  const data = payload({
    lang,
    time: { seq: 1, date: TODAY, today: {} },
    categories: [
      {
        id: 'client-a',
        title: 'Client A',
        color: '#007AFF',
        colorName: 'blue',
        paths: [],
        configured: true,
        fallback: false,
      },
      {
        id: 'client-s',
        title: 'Client S',
        color: '#FF9500',
        colorName: 'orange',
        paths: [],
        configured: true,
        fallback: false,
      },
      {
        id: 'client-e',
        title: 'Client E',
        color: '#34C759',
        colorName: 'green',
        paths: [],
        configured: true,
        fallback: false,
      },
    ],
  } as Parameters<typeof payload>[0])
  const b = board({ data, toast: () => {} })
  return (
    <I18nProvider lang={lang}>
      <BoardContext.Provider value={b}>
        <PanelProvider viewport={() => ({ w: width, h: 900 })}>
          <TimePanel open={true} onClose={() => {}} client={client} onClient={() => {}} />
        </PanelProvider>
      </BoardContext.Provider>
    </I18nProvider>
  )
}

const mounted = new Set<Root>()
afterEach(() => {
  for (const root of mounted) act(() => root.unmount())
  mounted.clear()
  for (const el of [...dom.window.document.body.children]) if (el.id !== 'root') el.remove()
})

/** A board of its own (the sandbox's server lives for the test), and the panel on it. */
async function mount(lang: 'en' | 'ru' = 'en', client: string | null = null, width = 1600): Promise<Root> {
  await setup()
  const el = dom.window.document.createElement('div')
  dom.window.document.body.append(el)
  const root = createRoot(el)
  mounted.add(root)
  await act(async () => root.render(view(lang, client, width)))
  await settle(400)
  return root
}

test('Day, Week and Month as one switch; it opens on the day, and a week shows its seven days with figures and marks', async () => {
  await mount('en')
  expect(qa('.time-views button').map(b => b.textContent)).toEqual(['Day', 'Week', 'Month'])
  expect(tab('Day')?.getAttribute('aria-selected')).toBe('true')
  expect(text('.time-date')).toContain('November 6')
  await click(tab('Week'))
  expect(tab('Week')?.getAttribute('aria-selected')).toBe('true')
  // a week from Sunday as this browser's locale has it: 1 to 7 November
  expect(qa('.time-week-day .time-wd-num').map(n => n.textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7'])
  expect(text('.time-date')).toContain('November')
  // the figure to bill: Monday 40 min up to 1 h, Wednesday 30 min and 1 h 30 min; the held entry in none
  expect(text('.time-total')).toBe('3h')
  expect(text('.time-summary .time-about')).toContain('worked 2h 30m')
  expect(text('.time-summary .time-about')).toContain('not entered 1h 30m')
  expect(qa('.time-span-client').map(c => norm(c.textContent))).toEqual([
    'Client A1h 30mworked 1h',
    'Client S1h 30mnot entered 1h 30m',
  ])
  expect(label(weekRow(2))).toBe('Monday, November 2, Billable 1h, worked 40m')
  expect(weekRow(2)?.querySelector('.time-week-figure strong')?.textContent).toBe('1h')
  // Tuesday went by with nothing: no time; the weekend, today and Saturday ahead never
  expect(weekRow(3)?.classList.contains('no-time')).toBe(true)
  expect(weekRow(3)?.textContent).toContain('No time')
  for (const n of [1, 6, 7]) expect(weekRow(n)?.classList.contains('no-time')).toBe(false)
  // Thursday has a held entry: time, not billed yet, so no mark, and no figure of nothing ("0m")
  expect(weekRow(5)?.classList.contains('no-time')).toBe(false)
  expect(weekRow(5)?.querySelector('.time-week-figure strong')).toBeNull()
  // Wednesday: both clients, client S not entered yet
  expect(weekRow(4)?.querySelectorAll('.time-week-clients .time-dot')).toHaveLength(2)
  expect(norm(weekRow(4)?.querySelector('.time-flag-open')?.textContent)).toBe('not entered 1h 30m')
  expect(weekRow(6)?.classList.contains('today')).toBe(true)
  expect(weekRow(6)?.getAttribute('aria-current')).toBe('date')
  expect(qa('[aria-current="date"]')).toHaveLength(1)
  expect(weekRow(7)?.classList.contains('ahead')).toBe(true)
})

test('a tap on a week’s day opens it in the Day view; the arrows go by the view’s unit and Today comes back', async () => {
  await mount('en')
  await click(tab('Week'))
  await click(weekRow(4))
  expect(tab('Day')?.getAttribute('aria-selected')).toBe('true')
  expect(text('.time-date')).toBe('Wednesday, November 4')
  expect(qa('.time-entry')).toHaveLength(2)
  await click(tab('Week'))
  expect(q('.time-prev')?.getAttribute('aria-label')).toBe('Previous week')
  expect(q('.time-today')?.hasAttribute('disabled')).toBe(true)
  await click(q('.time-prev'))
  expect(qa('.time-week-day .time-wd-num').map(n => n.textContent)).toEqual(['25', '26', '27', '28', '29', '30', '31'])
  expect(text('.time-empty')).toBe('No entries this week')
  expect(q('.time-today')?.hasAttribute('disabled')).toBe(false)
  await click(q('.time-today'))
  expect(weekRow(6)?.classList.contains('today')).toBe(true)
})

test('a month as the Calendar’s grid: each day a way into it, its figure, its marks, a legend', async () => {
  await mount('en')
  await click(tab('Month'))
  expect(text('.time-date')).toBe('November 2026')
  expect(q('.time-month.cal-month')).toBeTruthy()
  const cells = qa('.time-month-day')
  expect(cells.length % 7).toBe(0)
  expect(qa('.time-month-day:not(.other)')).toHaveLength(30)
  expect(monthCell(2)?.querySelector('.time-month-fig')?.textContent?.trim()).toBe('1h')
  expect(monthCell(3)?.classList.contains('no-time')).toBe(true)
  expect(monthCell(4)?.classList.contains('open')).toBe(true)
  expect(label(monthCell(4))).toBe(
    'Wednesday, November 4, Billable 2h, worked 1h 50m, Client A 30m, Client S 1h 30m, not entered 1h 30m',
  )
  expect(monthCell(6)?.classList.contains('today')).toBe(true)
  // the month's own days in its figure, the grid's days of October not
  expect(text('.time-total')).toBe('3h')
  expect(qa('.time-legend span').map(s => s.textContent)).toEqual(['Not entered', 'A weekday with no time'])
  // December's days on the grid's edge are drawn, quieter, and their client is in neither the
  // month's figures nor its chips
  const december = qa('.time-month-day.other').find(b => b.querySelector('.cal-month-dn')?.textContent === '3')
  expect(norm(december?.querySelector('.time-month-fig')?.textContent).trim()).toBe('1h')
  expect(qa('.time-span-client').map(c => c.querySelector('.time-dot')?.textContent)).toEqual(['Client A', 'Client S'])
  expect(qa('.time-chips button').map(b => b.textContent)).toEqual(['All', 'Client A', 'Client S'])
  expect(monthCell(6)?.getAttribute('aria-current')).toBe('date')
  // the whole month's weekdays before the board's first entry are days with no time
  expect(monthCell(30)?.classList.contains('no-time')).toBe(false)
  await click(monthCell(2))
  expect(text('.time-date')).toBe('Monday, November 2')
})

test('one client picked: its figures only, named over them, in the week and in the month', async () => {
  await mount('en', 'client-s')
  await click(tab('Week'))
  expect(text('.time-caption')).toBe('Client S · Billable')
  expect(text('.time-total')).toBe('1h 30m')
  expect(qa('.time-span-client')).toHaveLength(0)
  expect(weekRow(2)?.querySelector('.time-week-figure strong')).toBeNull()
  // Monday had client A's time: not a day with no time under client S's chip
  expect(weekRow(2)?.classList.contains('no-time')).toBe(false)
  expect(qa('.time-chips button[aria-pressed="true"]').map(b => b.textContent)).toEqual(['Client S'])
  await click(tab('Month'))
  expect(norm(monthCell(4)?.querySelector('.time-month-fig')?.textContent).trim()).toBe('1h 30m')
})

test('in Russian: the words, a week from Monday, the durations in the panel’s one form', async () => {
  await mount('ru')
  expect(qa('.time-views button').map(b => b.textContent)).toEqual(['День', 'Неделя', 'Месяц'])
  await click(tab('Неделя'))
  expect(qa('.time-week-day .time-wd-num').map(n => n.textContent)).toEqual(['2', '3', '4', '5', '6', '7', '8'])
  expect(q('.time-prev')?.getAttribute('aria-label')).toBe('Предыдущая неделя')
  expect(weekRow(3)?.textContent).toContain('Нет времени')
  expect(text('.time-total')).toBe('3 ч')
  await click(tab('Месяц'))
  expect(text('.time-date').toLowerCase()).toContain('ноябрь')
  expect(qa('.time-legend span').map(s => s.textContent)).toEqual(['Не внесено', 'Будний день без времени'])
  expect([...(monthCell(4)?.querySelectorAll('.time-month-fig span') ?? [])].map(s => s.textContent?.trim())).toEqual([
    '2\u00a0ч',
  ])
})

test('at a phone’s width: the same views; a sideways swipe goes by a week', async () => {
  await mount('en', null, 390)
  await click(tab('Week'))
  expect(qa('.time-week-day')).toHaveLength(7)
  const list = q('.time-days')
  const pointer = (type: string, x: number) => {
    const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 300 })
    Object.defineProperties(e, { pointerType: { value: 'touch' }, pointerId: { value: 1 } })
    return e
  }
  await act(async () => {
    list.dispatchEvent(pointer('pointerdown', 300))
    list.dispatchEvent(pointer('pointermove', 200))
    list.dispatchEvent(pointer('pointermove', 60))
    list.dispatchEvent(pointer('pointerup', 40))
  })
  await settle()
  expect(qa('.time-week-day .time-wd-num').map(n => n.textContent)).toEqual(['8', '9', '10', '11', '12', '13', '14'])
  await click(tab('Month'))
  expect(qa('.time-month-day').length % 7).toBe(0)
})
