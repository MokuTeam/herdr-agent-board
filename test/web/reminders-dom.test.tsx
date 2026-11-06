// The reminder card's buttons on a real DOM (jsdom, #335): Snooze hides the card at once and tells
// the board; a refusal brings the card back where it was, clickable, with the board's reason; a
// reminder that comes back after its snooze, under the same id, shows again; Join tells the board
// and leaves the link to the browser. Frames are the test's own; events are invented.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { CalendarPayload, RemindersPayload } from '../../src/core/payload.ts'
import { board, payload } from './support/board.tsx'

let createRoot: typeof import('react-dom/client').createRoot
let Reminders: typeof import('../../web/src/components/calendar/Reminders.tsx').Reminders
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const g = globalThis as Record<string, unknown>
const win = dom.window as unknown as Record<string, unknown>
const NAMES = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'fetch',
  'IS_REACT_ACT_ENVIRONMENT',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const set = (name: string, value: unknown) =>
  Object.defineProperty(g, name, { value, configurable: true, writable: true })

/** Frames asked for: `draw()` runs them all, as many times as asked. */
const frames = new Map<number, (t: number) => void>()
let ids = 0
let clock = 0
const draw = async (times = 120) => {
  for (let i = 0; i < times && frames.size; i++) {
    const now = [...frames.values()]
    frames.clear()
    clock += 16
    await act(async () => {
      for (const fn of now) fn(clock)
    })
  }
}
/** What the board answers POST /api/calendar-reminders, and what it was asked. */
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true } }
const asked: unknown[] = []
const toasts: [string, boolean | undefined][] = []

beforeAll(async () => {
  for (const k of NAMES) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'])
    set(k, win[k])
  set('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }))
  set('requestAnimationFrame', (fn: (t: number) => void) => {
    frames.set(++ids, fn)
    return ids
  })
  set('cancelAnimationFrame', (id: number) => frames.delete(id))
  set('fetch', async (_url: string, init: RequestInit) => {
    asked.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  set('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  ;({ Reminders } = await import('../../web/src/components/calendar/Reminders.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
})

afterAll(() => {
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
  frames.clear()
  asked.length = 0
  toasts.length = 0
  answer = { status: 200, body: { ok: true } }
})

const item = (): RemindersPayload['items'][number] => {
  const start = Date.now() + 10 * 60_000
  return {
    id: 'AbCdEfGhIjKlMn_-',
    source: 'work',
    event: 'e1',
    title: 'Design review',
    start: new Date(start).toISOString(),
    end: new Date(start + 30 * 60_000).toISOString(),
    join: 'https://meet.example.com/abc',
    label: 'Work',
    kind: 'push',
    color: '#336699',
    lane: null,
  }
}
const line = (items: RemindersPayload['items']): CalendarPayload => ({
  rev: '1',
  busy: false,
  failing: 0,
  next: null,
  ...(items.length && { reminders: { snoozeMin: 5, items } }),
})

async function render(items: RemindersPayload['items']) {
  const value = board({
    data: payload({ calendar: line(items) }),
    toast: (text: string, error?: boolean) => void toasts.push([text, error]),
  })
  const tree = (
    <I18nProvider lang="en">
      <BoardContext.Provider value={value}>
        <Reminders onOpen={() => {}} />
      </BoardContext.Provider>
    </I18nProvider>
  )
  if (!root) root = createRoot(document.getElementById('root') as HTMLElement)
  await act(async () => root?.render(tree))
}
const card = () => document.querySelector<HTMLElement>('.cal-reminder')
const button = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('.cal-reminder button, .cal-reminder a')].find(b => b.textContent === text)
const click = (el: HTMLElement | undefined) =>
  act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })

test('Snooze: the card goes at once and the board is told; the board taking it out leaves nothing', async () => {
  await render([item()])
  await draw()
  expect(card()?.style.opacity).toBe('1')
  await click(button('Snooze 5 min'))
  await draw()
  expect(asked).toEqual([{ id: 'AbCdEfGhIjKlMn_-', act: 'snooze' }])
  expect(card()).toBeNull()
  await render([])
  expect(document.querySelector('.cal-reminders')).toBeNull()
})

test('a refusal brings the card back where it was, clickable, with the board’s reason', async () => {
  answer = { status: 409, body: { ok: false, error: 'Calendar reminders are off' } }
  await render([item()])
  await draw()
  await click(button('Snooze 5 min'))
  await act(async () => {
    await new Promise(r => setTimeout(r, 20))
  })
  await draw()
  const el = card()
  expect(el).not.toBeNull()
  expect(el?.style.pointerEvents).toBe('')
  expect(el?.style.opacity).toBe('1')
  expect(toasts).toEqual([['Calendar reminders are off', true]])
})

test('back after its snooze under the same id, it shows again', async () => {
  await render([item()])
  await draw()
  await click(button('Snooze 5 min'))
  await draw()
  expect(card()).toBeNull()
  await render([])
  await render([item()])
  await draw()
  expect(card()?.style.opacity).toBe('1')
  expect(button('Snooze 5 min')).toBeDefined()
})

test('Join tells the board and keeps the link for the browser', async () => {
  await render([item()])
  await draw()
  const join = button('Join')
  expect(join?.getAttribute('href')).toBe('https://meet.example.com/abc')
  await click(join)
  expect(asked).toEqual([{ id: 'AbCdEfGhIjKlMn_-', act: 'join' }])
})
