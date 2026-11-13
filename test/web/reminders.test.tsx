// A calendar reminder on the page (#335, web/src/components/calendar/Reminders.tsx): nothing while
// the board has none on show (the calendar off, or on with none); one on show says whose, when and
// what, with Join one tap away, Snooze, At start while the start is more than a minute away, and
// dismiss; in English and Russian. The words of "when" and the stream's `cal-open`, too. Events are
// invented.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { translator } from '../../src/core/i18n/translator.ts'
import type { CalendarPayload, RemindersPayload } from '../../src/core/payload.ts'
import { Reminders } from '../../web/src/components/calendar/Reminders.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { offersAtStart, reminderWhen } from '../../web/src/models/calendar.ts'
import { type CalOpen, calOpenOf, listenForCalOpens } from '../../web/src/models/reveal.ts'
import { BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { board, payload } from './support/board.tsx'

const MIN = 60_000
const line = (reminders?: RemindersPayload): CalendarPayload => ({
  rev: '1',
  busy: false,
  failing: 0,
  next: null,
  ...(reminders && { reminders }),
})
const item = (over: Partial<RemindersPayload['items'][number]> = {}): RemindersPayload['items'][number] => {
  const start = Date.now() + 10 * MIN + 20_000
  return {
    id: 'AbCdEfGhIjKlMn_-',
    source: 'work',
    event: 'e1',
    title: 'Design review',
    start: new Date(start).toISOString(),
    end: new Date(start + 30 * MIN).toISOString(),
    join: 'https://meet.example.com/abc',
    label: 'Work',
    kind: 'push',
    color: '#336699',
    lane: null,
    ...over,
  }
}

const html = (calendar: CalendarPayload | undefined, lang = 'en') =>
  renderToStaticMarkup(
    <I18nProvider lang={lang}>
      <BoardContext.Provider value={board({ data: payload(calendar ? { calendar } : {}) })}>
        <Reminders onOpen={() => {}} />
      </BoardContext.Provider>
    </I18nProvider>,
  )

test('nothing while the board has no reminder on show: the calendar off, or on with none', () => {
  assert.equal(html(undefined), '')
  assert.equal(html(line()), '')
})

test('one on show: whose, when and what, Join the link itself, Snooze, At start, dismiss', () => {
  const out = html(line({ snoozeMin: 5, items: [item()] }))
  assert.ok(out.includes('class="cal-reminders" aria-live="polite"'))
  assert.ok(out.includes('aria-label="Reminder: Design review"'))
  assert.ok(out.includes('<span class="cal-rem-whose">Work</span>'))
  assert.ok(out.includes('in 10 min · '))
  assert.ok(out.includes('>Design review</button>'))
  assert.ok(out.includes('href="https://meet.example.com/abc" target="_blank" rel="noopener noreferrer"'))
  assert.ok(out.includes('>Snooze 5 min</button>'))
  assert.ok(out.includes('>At start</button>'))
  assert.ok(out.includes('aria-label="Dismiss"'))
  assert.ok(out.includes('--ev:#336699'))
})

test('no join link: Open is the first button; a minute or less to go: no At start; Russian', () => {
  const plain = html(line({ snoozeMin: 10, items: [(({ join: _j, ...r }) => r)(item())] }))
  assert.ok(!plain.includes('href='))
  assert.ok(plain.includes('class="button primary">Open</button>'))
  assert.ok(plain.includes('>Snooze 10 min</button>'))
  const soon = html(line({ snoozeMin: 5, items: [item({ start: new Date(Date.now() + 30_000).toISOString() })] }))
  assert.ok(!soon.includes('At start'))
  const ru = html(line({ snoozeMin: 5, items: [item()] }), 'ru')
  assert.ok(ru.includes('через 10 мин · '))
  assert.ok(ru.includes('Подключиться</a>'))
  assert.ok(ru.includes('>Отложить на 5 мин</button>'))
  assert.ok(ru.includes('>К началу</button>'))
  assert.ok(ru.includes('aria-label="Скрыть"'))
  // the board's own calendar is named as the panel names it
  assert.ok(
    html(line({ snoozeMin: 5, items: [item({ source: 'board', kind: 'board', label: '' })] })).includes('>Board<'),
  )
})

test('the words of when, and At start only while the start is more than a minute away', () => {
  const en = translator('en')
  const start = Date.parse('2026-11-06T14:30:00Z')
  assert.equal(reminderWhen(start, start - 90 * MIN, en), 'in 2 hours')
  assert.equal(reminderWhen(start, start - 10 * MIN, en), 'in 10 min')
  assert.equal(reminderWhen(start, start - 20_000, en), 'starting now')
  assert.equal(reminderWhen(start, start + 3 * MIN, en), 'started 3 min ago')
  assert.equal(reminderWhen(start, start + 3 * MIN, translator('ru')), 'началось 3 мин назад')
  assert.equal(offersAtStart(start, start - 61_000), true)
  assert.equal(offersAtStart(start, start - 60_000), false)
})

test('the stream’s cal-open: an event becomes the one to show, counted on; anything else changes nothing', () => {
  assert.deepEqual(calOpenOf('{"source":"work","id":"e1","start":"2026-11-06T14:30:00Z"}'), {
    source: 'work',
    id: 'e1',
    start: '2026-11-06T14:30:00Z',
  })
  for (const bad of ['', 'x', '{"source":1,"id":"e1","start":"s"}', '[]', 'null']) assert.equal(calOpenOf(bad), null)
  let listener: ((e: MessageEvent) => void) | null = null
  let state: CalOpen | null = null
  listenForCalOpens(
    {
      addEventListener(_type, l) {
        listener = l
      },
    },
    next => {
      state = next(state)
    },
  )
  const send = (data: string) => listener?.({ data } as MessageEvent)
  send('{"source":"work","id":"e1","start":"s"}')
  send('{"source":"work","id":"e1","start":"s"}')
  send('nope')
  assert.deepEqual(state, { source: 'work', id: 'e1', start: 's', n: 2 })
})
