// DOM tests for multi-timezone calendar UI (#646): Day/Week multi-column gutter (primary nearest
// the grid, label + UTC offset, half-hour offsets), swap action moving the grid and "now" line
// without touching events, per-day DST across transition day and week, event popover in every shown
// zone, phone folding, off-by-default parity, and searchable IANA picker in Settings.
import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { CalEvent } from '../../src/core/calendar.ts'
import { buildGutterZones } from '../../web/src/models/calendar-zones.ts'

let createRoot: typeof import('react-dom/client').createRoot
let TimeGrid: typeof import('../../web/src/components/calendar/CalendarViews.tsx').TimeGrid
let EventCard: typeof import('../../web/src/components/calendar/CalendarViews.tsx').EventCard
let TimeZonesFields: typeof import('../../web/src/components/calendar/CalendarSettingsPanel.tsx').TimeZonesFields
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const g = globalThis as Record<string, unknown>
const win = dom.window as unknown as Record<string, unknown> & {
  HTMLElement: typeof HTMLElement
  HTMLInputElement: typeof HTMLInputElement
}
const NAMES = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'PointerEvent',
  'ResizeObserver',
  'getComputedStyle',
  'innerWidth',
  'innerHeight',
  'IS_REACT_ACT_ENVIRONMENT',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const set = (name: string, value: unknown) =>
  Object.defineProperty(g, name, { value, configurable: true, writable: true })

const NOW = Date.parse('2026-11-04T14:30:00Z') // 18:30 Yerevan, 09:30 NY, 20:00 Kolkata

beforeAll(async () => {
  for (const k of NAMES) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'Element',
    'Node',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
  ])
    set(k, win[k])
  set('PointerEvent', win.MouseEvent)
  set('innerWidth', 1200)
  set('innerHeight', 800)
  set('IS_REACT_ACT_ENVIRONMENT', true)
  set('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  Object.defineProperty(win.navigator, 'language', { value: 'en-GB', configurable: true })
  setSystemTime(NOW)
  set(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  ;({ createRoot } = await import('react-dom/client'))
  ;({ TimeGrid, EventCard } = await import('../../web/src/components/calendar/CalendarViews.tsx'))
  ;({ TimeZonesFields } = await import('../../web/src/components/calendar/CalendarSettingsPanel.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
})

afterAll(() => {
  setSystemTime()
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
})

async function mount(node: React.ReactNode) {
  if (!root) root = createRoot(document.getElementById('root') as HTMLElement)
  await act(async () => root?.render(<I18nProvider lang="en">{node}</I18nProvider>))
}

const MARKS = { color: () => '#336699', label: () => 'Atlas' }
const EVENT: CalEvent = {
  source: 'board',
  id: 'ev1',
  title: 'Sync with anna and ben',
  start: '2026-11-04T15:00:00Z',
  end: '2026-11-04T16:00:00Z',
  allDay: false,
  status: 'confirmed',
}

test('off by default: no extra zones keeps single gutter and plain event popover', async () => {
  await mount(<TimeGrid days={['2026-11-04']} events={[EVENT]} marks={MARKS} now={NOW} lang="en" onPick={() => {}} />)
  const grid = document.querySelector('.cal-grid') as HTMLElement
  expect(grid.classList.contains('has-zones')).toBe(false)
  expect(document.querySelector('.cal-gutter-heads')).toBeNull()
  expect(document.querySelectorAll('.cal-hour-labels').length).toBe(1)

  const anchor = document.createElement('button')
  await mount(
    <EventCard e={EVENT} from={anchor} marks={MARKS} now={NOW} lang="en" sourceLine="Board" onClose={() => {}} />,
  )
  expect(document.querySelector('.cal-card-zones')).toBeNull()
  expect(document.querySelector('.cal-card-when')?.textContent).toContain('-')
})

test('multi-zone gutter: primary nearest the grid, labels and UTC offsets in header, half-hour offsets in rows', async () => {
  const days = ['2026-11-04']
  const zones = buildGutterZones(
    'Asia/Yerevan',
    [
      { zone: 'America/New_York', label: 'NY' },
      { zone: 'Asia/Kolkata', label: 'IST' },
    ],
    null,
    days,
  )
  await mount(
    <TimeGrid
      days={days}
      events={[EVENT]}
      marks={MARKS}
      now={NOW}
      lang="en"
      zones={zones}
      primaryZone="Asia/Yerevan"
      onSwapZone={() => {}}
      onPick={() => {}}
    />,
  )
  const grid = document.querySelector('.cal-grid') as HTMLElement
  expect(grid.classList.contains('has-zones')).toBe(true)

  const heads = [...document.querySelectorAll<HTMLElement>('.cal-zone-head')]
  expect(
    heads.map(h => [
      h.dataset.zone,
      h.querySelector('.cal-zone-label')?.textContent,
      h.querySelector('.cal-zone-offset')?.textContent,
    ]),
  ).toEqual([
    ['America/New_York', 'NY', 'UTC-5'],
    ['Asia/Kolkata', 'IST', 'UTC+5:30'],
    ['Asia/Yerevan', 'Yerevan', 'UTC+4'],
  ])
  // Primary is last (nearest the grid) and not a swap button; extras are swap buttons
  expect(heads[0]?.tagName).toBe('BUTTON')
  expect(heads[1]?.tagName).toBe('BUTTON')
  expect(heads[2]?.tagName).toBe('SPAN')
  expect(heads[2]?.classList.contains('primary')).toBe(true)

  // Check row 18 (18:00 Yerevan = 09:00 NY = 19:30 Kolkata)
  const cols = [...document.querySelectorAll<HTMLElement>('.cal-gutter-cols .cal-hour-labels')]
  expect(cols.map(c => c.dataset.zone)).toEqual(['America/New_York', 'Asia/Kolkata', 'Asia/Yerevan'])
  const atRow = (colIdx: number, h: number) => cols[colIdx]?.querySelectorAll('.cal-hour-row')[h]?.textContent ?? ''
  expect(atRow(0, 18)).toBe('09:00')
  expect(atRow(1, 18)).toBe('19:30')
  expect(atRow(2, 18)).toBe('18:00')
})

test('swap action makes another zone primary: grid, event position, and now line follow without touching events', async () => {
  const days = ['2026-11-04']
  const extras = [{ zone: 'America/New_York', label: 'NY' }]
  const originalStart = EVENT.start
  const originalEnd = EVENT.end
  let swappedTo = ''

  const beforeZones = buildGutterZones('Asia/Yerevan', extras, null, days)
  await mount(
    <TimeGrid
      days={days}
      events={[EVENT]}
      marks={MARKS}
      now={NOW}
      lang="en"
      zones={beforeZones}
      primaryZone="Asia/Yerevan"
      onSwapZone={z => {
        swappedTo = z
      }}
      onPick={() => {}}
    />,
  )
  // Event is 15:00Z = 19:00 Yerevan (1140 min); now is 14:30Z = 18:30 Yerevan (1110 min)
  const evBefore = document.querySelector<HTMLElement>('.cal-event')
  const nowBefore = document.querySelector<HTMLElement>('.cal-now')
  expect(evBefore?.style.getPropertyValue('--top')).toBe('1140')
  expect(nowBefore?.style.getPropertyValue('--top')).toBe('1110')

  // Click NY header to swap
  const nyBtn = document.querySelector<HTMLButtonElement>('button.cal-zone-swap[data-zone="America/New_York"]')
  expect(nyBtn).not.toBeNull()
  await act(async () => {
    nyBtn?.click()
  })
  expect(swappedTo).toBe('America/New_York')

  // Re-render with NY as primary
  const afterZones = buildGutterZones('Asia/Yerevan', extras, swappedTo, days)
  await mount(
    <TimeGrid
      days={days}
      events={[EVENT]}
      marks={MARKS}
      now={NOW}
      lang="en"
      zones={afterZones}
      primaryZone={swappedTo}
      onSwapZone={() => {}}
      onPick={() => {}}
    />,
  )
  const heads = [...document.querySelectorAll<HTMLElement>('.cal-zone-head')]
  expect(heads.map(h => [h.dataset.zone, h.classList.contains('primary')])).toEqual([
    ['Asia/Yerevan', false],
    ['America/New_York', true],
  ])
  // Event is now at 10:00 NY (600 min); now line at 09:30 NY (570 min)
  const evAfter = document.querySelector<HTMLElement>('.cal-event')
  const nowAfter = document.querySelector<HTMLElement>('.cal-now')
  expect(evAfter?.style.getPropertyValue('--top')).toBe('600')
  expect(nowAfter?.style.getPropertyValue('--top')).toBe('570')
  // Event itself was never mutated
  expect(EVENT.start).toBe(originalStart)
  expect(EVENT.end).toBe(originalEnd)
})

test('week crossing DST shows offset range, split gutter hours, and per-day transition note', async () => {
  const week = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']
  const zones = buildGutterZones('Asia/Yerevan', [{ zone: 'America/New_York', label: 'NY' }], null, week)
  await mount(
    <TimeGrid
      days={week}
      events={[]}
      marks={MARKS}
      now={NOW}
      lang="en"
      zones={zones}
      primaryZone="Asia/Yerevan"
      onSwapZone={() => {}}
      onPick={() => {}}
    />,
  )
  const nyHead = document.querySelector<HTMLElement>('.cal-zone-head[data-zone="America/New_York"]')
  expect(nyHead?.querySelector('.cal-zone-offset')?.textContent).toBe('UTC-4/-5')

  const nyCol = document.querySelector<HTMLElement>('.cal-hour-labels[data-zone="America/New_York"]')
  expect(nyCol?.querySelectorAll('.cal-hour-row')[18]?.textContent).toBe('10/09')

  const dstNotes = [...document.querySelectorAll<HTMLElement>('.cal-dst-note')]
  expect(dstNotes.length).toBe(1)
  expect(dstNotes[0]?.textContent).toBe('NY -5')
})

test('popover shows start and end in every shown zone, including on phones where extra gutter columns fold away', async () => {
  const days = ['2026-11-04']
  const zones = buildGutterZones(
    'Asia/Yerevan',
    [
      { zone: 'America/New_York', label: 'NY' },
      { zone: 'Asia/Kolkata', label: 'IST' },
    ],
    null,
    days,
  )

  // Phone layout: extra gutter columns fold away
  await mount(
    <TimeGrid
      days={days}
      events={[EVENT]}
      marks={MARKS}
      now={NOW}
      lang="en"
      zones={zones}
      primaryZone="Asia/Yerevan"
      phone={true}
      onSwapZone={() => {}}
      onPick={() => {}}
    />,
  )
  expect(document.querySelector('.cal-grid')?.classList.contains('zones-folded')).toBe(true)
  expect(document.querySelectorAll('.cal-zone-extra').length).toBe(0)
  expect(document.querySelectorAll('.cal-gutter-cols .cal-hour-labels').length).toBe(1)

  // Popover still shows every shown zone (primary first, with start and end)
  const anchor = document.createElement('button')
  const lateEvent: CalEvent = {
    ...EVENT,
    id: 'ev-late',
    start: '2026-11-04T20:30:00Z',
    end: '2026-11-04T21:30:00Z',
  }
  await mount(
    <EventCard
      e={lateEvent}
      from={anchor}
      marks={MARKS}
      now={NOW}
      lang="en"
      sourceLine="Board"
      zones={zones}
      primaryZone="Asia/Yerevan"
      onClose={() => {}}
    />,
  )
  const rows = [...document.querySelectorAll<HTMLElement>('.cal-card-zone-row')]
  expect(
    rows.map(r => [
      r.dataset.zone,
      r.querySelector('.cal-card-zone-label')?.textContent,
      r.querySelector('.cal-card-zone-off')?.textContent,
      r.querySelector('.cal-card-zone-time')?.textContent,
    ]),
  ).toEqual([
    ['Asia/Yerevan', 'Yerevan', 'UTC+4', '00:30 - 01:30'],
    ['America/New_York', 'NY', 'UTC-5', expect.stringContaining('15:30 - 16:30')],
    ['Asia/Kolkata', 'IST', 'UTC+5:30', '02:00 - 03:00'],
  ])
  // NY is on the previous calendar day (Nov 4 vs Nov 5 in Yerevan), so a date note is shown
  expect(rows[1]?.querySelector('.cal-card-zone-day')?.textContent).toContain('4')

  // All-day event shows no multi-zone clock table
  await mount(
    <EventCard
      e={{ ...EVENT, id: 'allday', allDay: true, start: '2026-11-04', end: '2026-11-05' }}
      from={anchor}
      marks={MARKS}
      now={NOW}
      lang="en"
      sourceLine="Board"
      zones={zones}
      primaryZone="Asia/Yerevan"
      onClose={() => {}}
    />,
  )
  expect(document.querySelector('.cal-card-zones')).toBeNull()
})

test('settings TimeZonesFields: searches IANA list, adds with short label, enforces max two, removes', async () => {
  const sent: { part: string; body: Record<string, unknown> }[] = []
  const send = async (part: string, body: Record<string, unknown>) => {
    sent.push({ part, body })
    return true
  }

  const setInput = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }

  await mount(<TimeZonesFields zones={[]} localZone="Asia/Yerevan" disabled={false} send={send} note={null} />)
  const addOpen = document.querySelector<HTMLButtonElement>('.cal-set-zone-add')
  expect(addOpen).not.toBeNull()
  await act(async () => addOpen?.click())

  // Search for New York
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')
  expect(search).not.toBeNull()
  await setInput(search as HTMLInputElement, 'new york')

  const nyOpt = document.querySelector<HTMLButtonElement>('.cal-set-zone-opt')
  expect(nyOpt?.textContent).toContain('America/New York')
  await act(async () => nyOpt?.click())

  // Typing a query that hides the picked zone clears selection so an unseen zone cannot be submitted
  await setInput(search as HTMLInputElement, 'tokyo')
  const submitHidden = document.querySelector<HTMLButtonElement>('.cal-set-zone-draft button[type="submit"]')
  expect(submitHidden?.disabled).toBe(true)

  // Pick New York again, enter short label "NY", and submit
  await setInput(search as HTMLInputElement, 'new york')
  await act(async () => document.querySelector<HTMLButtonElement>('.cal-set-zone-opt')?.click())

  // Type short label "NY" and submit
  const labelIn = document.querySelector<HTMLInputElement>('.cal-set-zone-draft input:not([type="search"])')
  expect(labelIn).not.toBeNull()
  await setInput(labelIn as HTMLInputElement, 'NY')

  const submit = document.querySelector<HTMLButtonElement>('.cal-set-zone-draft button[type="submit"]')
  await act(async () => submit?.click())
  expect(sent).toEqual([{ part: 'zones', body: { op: 'zones', zones: [{ zone: 'America/New_York', label: 'NY' }] } }])

  // At two zones, the add button disappears and removing sends the remaining zone
  sent.length = 0
  await mount(
    <TimeZonesFields
      zones={[
        { zone: 'America/New_York', label: 'NY' },
        { zone: 'Asia/Kolkata', label: 'IST' },
      ]}
      localZone="Asia/Yerevan"
      disabled={false}
      send={send}
      note={null}
    />,
  )
  expect(document.querySelector('.cal-set-zone-add')).toBeNull()

  // Clearing a row label and blurring restores the fallback label cleanly
  const rowIn = document.querySelector<HTMLInputElement>('.cal-set-zone-row[data-zone="America/New_York"] input')
  expect(rowIn).not.toBeNull()
  await act(async () => rowIn?.focus())
  await setInput(rowIn as HTMLInputElement, '   ')
  await act(async () => rowIn?.blur())
  expect(rowIn?.value).toBe('New York')

  sent.length = 0
  const removeNy = document.querySelector<HTMLButtonElement>(
    '.cal-set-zone-row[data-zone="America/New_York"] .cal-set-zone-rm',
  )
  await act(async () => removeNy?.click())
  expect(sent).toEqual([{ part: 'zones', body: { op: 'zones', zones: [{ zone: 'Asia/Kolkata', label: 'IST' }] } }])
})
