import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  byStart,
  type CalEvent,
  calendarConfig,
  eventOf,
  fetchedSources,
  inWindow,
  joinLinkIn,
  problemsText,
  serverAddress,
  syncWindow,
  writesToProvider,
} from '../../src/core/calendar.ts'
import { googleEvents, googleListArgs, googleWriteArgs, writtenId } from '../../src/core/calendar-google.ts'
import { icsEvents, ruleOf } from '../../src/core/calendar-ics.ts'
import { bars, columns, monthWeeks, weekOf } from '../../src/core/calendar-layout.ts'
import { translator } from '../../src/core/i18n/translator.ts'

const NY = 'America/New_York'
const t = translator('en')

// ------------------------------------------------------------------ config

test('calendarConfig: off unless `calendar` is there and not `on: false`; the board source always first', () => {
  assert.equal(calendarConfig(undefined), null)
  assert.equal(calendarConfig(false), null)
  assert.equal(calendarConfig({ on: false, sources: [{ id: 'x', kind: 'ics' }] }), null)
  const on = calendarConfig(true)
  assert.ok(on)
  assert.deepEqual(
    on.sources.map(s => [s.id, s.kind]),
    [['board', 'board']],
  )
  assert.equal(on.everyMin, 5)
  assert.deepEqual(on.problems, [])
})

test('calendarConfig: sources read strictly; one with a problem is kept with it and not fetched', () => {
  const c = calendarConfig({
    on: true,
    everyMin: 10,
    sources: [
      {
        id: 'work',
        kind: 'mcp',
        label: 'Work',
        color: '#3366FF',
        lane: 'acme',
        url: 'http://127.0.0.1:9/a/mcp',
        preset: 'google-workspace',
        account: 'me@example.com',
      },
      { id: 'home', kind: 'ics', label: 'Home', everyMin: 30 },
      { id: 'far', kind: 'mcp', url: 'http://example.com/mcp', list: { tool: 'events' } },
      { id: 'Bad Id', kind: 'ics' },
      { id: 'home', kind: 'push' },
      { id: 'board', kind: 'board', label: 'Agents', color: '#112233' },
      { id: 'odd', kind: 'ics', extra: 1 },
    ],
  })
  assert.ok(c)
  const work = c.sources.find(s => s.id === 'work')
  assert.ok(work)
  assert.equal(work.color, '#3366ff')
  assert.deepEqual(work.calendars, ['primary'])
  assert.equal(work.everyMin, 10)
  assert.equal(writesToProvider(work), false)
  assert.equal(c.sources.find(s => s.id === 'home')?.everyMin, 30)
  // http is for this computer only
  assert.equal(serverAddress('http://example.com/mcp'), null)
  assert.equal(serverAddress('https://example.com/mcp'), 'https://example.com/mcp')
  const far = c.sources.find(s => s.id === 'far')
  assert.deepEqual(
    far?.problems.map(p => p.why),
    ['url'],
  )
  assert.ok(c.sources.some(s => s.id === 'Bad Id' && s.problems.some(p => p.why === 'id')))
  assert.ok(c.sources.some(s => s.kind === 'push' && s.problems.some(p => p.why === 'duplicate')))
  assert.ok(c.sources.some(s => s.id === 'odd' && s.problems.some(p => p.why === 'unknown')))
  // the board's own restyled, still first
  assert.equal(c.sources[0]?.id, 'board')
  assert.equal(c.sources[0]?.label, 'Agents')
  assert.equal(c.sources[0]?.color, '#112233')
  assert.deepEqual(
    fetchedSources(c).map(s => s.id),
    ['work', 'home'],
  )
  assert.match(problemsText(far?.problems ?? [], t), /calendar\.sources\.2\.url/)
})

test('calendarConfig: the preset needs the account; a generic mcp source needs its list tool; write needs a tool', () => {
  const c = calendarConfig({
    sources: [
      { id: 'g', kind: 'mcp', url: 'http://127.0.0.1:1/mcp', preset: 'google-workspace' },
      { id: 'x', kind: 'mcp', url: 'http://127.0.0.1:1/mcp' },
      { id: 'y', kind: 'mcp', url: 'http://127.0.0.1:1/mcp', list: { tool: 'list' }, write: true },
      { id: 'z', kind: 'mcp', url: 'http://127.0.0.1:1/mcp', list: { tool: 'list', args: { a: 1 } }, write: 'put' },
    ],
  })
  assert.ok(c)
  const by = (id: string) => c.sources.find(s => s.id === id)
  assert.deepEqual(
    by('g')?.problems.map(p => p.at),
    ['calendar.sources.0.account'],
  )
  assert.deepEqual(
    by('x')?.problems.map(p => p.at),
    ['calendar.sources.1.list'],
  )
  assert.deepEqual(
    by('y')?.problems.map(p => p.at),
    ['calendar.sources.2.write'],
  )
  const z = by('z')
  assert.equal(z?.writeTool, 'put')
  assert.ok(z && writesToProvider(z))
})

// ------------------------------------------------------------------ the model

test('eventOf: checks each field; an all-day event has dates; a bad time is no event', () => {
  assert.equal(eventOf({ id: 'a', start: 'tomorrow', end: 'later' }, 's'), null)
  assert.equal(eventOf({ title: 'no id', start: '2026-11-02T10:00:00Z', end: '2026-11-02T11:00:00Z' }, 's'), null)
  const e = eventOf(
    {
      id: 'a',
      title: ' Standup\n',
      start: '2026-11-02T10:00:00.000+0300',
      end: '2026-11-02T10:30:00+03:00',
      join: 'javascript:alert(1)',
      link: 'https://example.com/e/1',
      attendees: 3,
      status: 'odd',
      response: 'declined',
      kind: 'focusTime',
    },
    's',
  )
  assert.deepEqual(e, {
    source: 's',
    id: 'a',
    title: 'Standup',
    start: '2026-11-02T10:00:00+03:00',
    end: '2026-11-02T10:30:00+03:00',
    allDay: false,
    link: 'https://example.com/e/1',
    attendees: 3,
    status: 'confirmed',
    response: 'declined',
    kind: 'focusTime',
  })
  const d = eventOf({ id: 'b', title: 'Trip', start: '2026-11-02', end: '2026-11-02' }, 's')
  assert.equal(d?.allDay, true)
  assert.equal(d?.end, '2026-11-03')
})

test('joinLinkIn: Meet, Zoom, Teams in a conference field, a place or HTML; the first text that has one wins', () => {
  assert.equal(joinLinkIn(null, 'Room 4'), null)
  assert.equal(
    joinLinkIn('', 'https://acme.zoom.us/j/123456789?pwd=abc.1', 'see https://meet.google.com/abc-defg-hij'),
    'https://acme.zoom.us/j/123456789?pwd=abc.1',
  )
  assert.equal(
    joinLinkIn(
      '<p>Join: <a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0?context=%7b%7d&amp;x=1">here</a></p>',
    ),
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0?context=%7b%7d&x=1',
  )
  assert.equal(
    joinLinkIn('Meeting Link: https://meet.google.com/abc-defg-hij.'),
    'https://meet.google.com/abc-defg-hij',
  )
  assert.equal(
    joinLinkIn('https://teams.microsoft.com/meet/2481767554306?p=x'),
    'https://teams.microsoft.com/meet/2481767554306?p=x',
  )
})

test('syncWindow and inWindow: midnights in the zone; an all-day event by its dates', () => {
  const now = Date.parse('2026-11-04T15:00:00Z')
  const w = syncWindow({ pastDays: 1, futureDays: 2 }, now, NY)
  assert.equal(new Date(w.from).toISOString(), '2026-11-03T05:00:00.000Z')
  assert.equal(new Date(w.to).toISOString(), '2026-11-07T05:00:00.000Z')
  const allDay: CalEvent = {
    source: 's',
    id: 'x',
    title: '',
    start: '2026-11-07',
    end: '2026-11-08',
    allDay: true,
    status: 'confirmed',
  }
  assert.equal(inWindow(allDay, w.from, w.to, NY), false)
  assert.equal(inWindow({ ...allDay, start: '2026-11-06', end: '2026-11-07' }, w.from, w.to, NY), true)
  const sorted = [
    { ...allDay, id: 'timed', allDay: false, start: '2026-11-06T05:00:00Z', end: '2026-11-06T06:00:00Z' },
    { ...allDay, id: 'day', start: '2026-11-06', end: '2026-11-07' },
  ].sort(byStart(NY))
  assert.deepEqual(
    sorted.map(e => e.id),
    ['day', 'timed'],
  )
})

// ------------------------------------------------------------------ ICS

const ics = (...events: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events, 'END:VCALENDAR'].join('\r\n')

const win = (from: string, to: string) => ({ source: 'home', from: Date.parse(from), to: Date.parse(to), zone: 'UTC' })

test('icsEvents: a weekly series stays at 09:00 New York time across the end of daylight saving time', () => {
  const text = ics(
    'BEGIN:VEVENT',
    'UID:weekly-1',
    'DTSTART;TZID=America/New_York:20261019T090000',
    'DTEND;TZID=America/New_York:20261019T093000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4',
    'SUMMARY:Planning\\, weekly',
    'LOCATION:https://meet.google.com/abc-defg-hij',
    'END:VEVENT',
  )
  const evs = icsEvents(text, win('2026-10-01T00:00:00Z', '2026-12-31T00:00:00Z'))
  assert.deepEqual(
    evs.map(e => [e.start, e.end]),
    [
      ['2026-10-19T13:00:00Z', '2026-10-19T13:30:00Z'],
      ['2026-10-26T13:00:00Z', '2026-10-26T13:30:00Z'],
      ['2026-11-02T14:00:00Z', '2026-11-02T14:30:00Z'],
      ['2026-11-09T14:00:00Z', '2026-11-09T14:30:00Z'],
    ],
  )
  assert.equal(evs[0]?.title, 'Planning, weekly')
  assert.equal(evs[0]?.join, 'https://meet.google.com/abc-defg-hij')
  assert.equal(evs[0]?.zone, NY)
  assert.equal(evs[0]?.series, 'weekly-1')
  assert.equal(new Set(evs.map(e => e.id)).size, 4)
})

test('icsEvents: EXDATE drops an instance, RECURRENCE-ID moves one and cancels another; the window cuts', () => {
  const text = ics(
    'BEGIN:VEVENT',
    'UID:daily',
    'DTSTART:20261102T100000Z',
    'DURATION:PT1H',
    'RRULE:FREQ=DAILY;UNTIL=20261106T100000Z',
    'EXDATE:20261103T100000Z',
    'SUMMARY:Daily',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:daily',
    'RECURRENCE-ID:20261104T100000Z',
    'DTSTART:20261104T150000Z',
    'DTEND:20261104T153000Z',
    'SUMMARY:Daily (moved)',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:daily',
    'RECURRENCE-ID:20261105T100000Z',
    'DTSTART:20261105T100000Z',
    'DTEND:20261105T110000Z',
    'STATUS:CANCELLED',
    'SUMMARY:Daily',
    'END:VEVENT',
  )
  const evs = icsEvents(text, win('2026-11-02T00:00:00Z', '2026-11-10T00:00:00Z'))
  assert.deepEqual(
    evs.map(e => [e.start, e.title, e.status]),
    [
      ['2026-11-02T10:00:00Z', 'Daily', 'confirmed'],
      ['2026-11-04T15:00:00Z', 'Daily (moved)', 'confirmed'],
      ['2026-11-05T10:00:00Z', 'Daily', 'cancelled'],
      ['2026-11-06T10:00:00Z', 'Daily', 'confirmed'],
    ],
  )
  // the moved one keeps the id of the instance it replaces
  assert.equal(evs[1]?.id, 'daily_20261104T100000Z')
  const cut = icsEvents(text, win('2026-11-05T12:00:00Z', '2026-11-07T00:00:00Z'))
  assert.deepEqual(
    cut.map(e => e.start),
    ['2026-11-06T10:00:00Z'],
  )
})

test('icsEvents: all-day events, monthly by ordinal weekday, yearly; a long series is walked to the window', () => {
  const text = ics(
    'BEGIN:VEVENT',
    'UID:trip',
    'DTSTART;VALUE=DATE:20261105',
    'DTEND;VALUE=DATE:20261108',
    'SUMMARY:Trip',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:last-friday',
    'DTSTART:20200131T160000Z',
    'DTEND:20200131T170000Z',
    'RRULE:FREQ=MONTHLY;BYDAY=-1FR',
    'SUMMARY:Review',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:birthday',
    'DTSTART;VALUE=DATE:19900312',
    'RRULE:FREQ=YEARLY',
    'SUMMARY:Birthday',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:second-tue',
    'DTSTART:20260101T080000Z',
    'DTEND:20260101T083000Z',
    'RRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2',
    'SUMMARY:Second Tuesday',
    'END:VEVENT',
  )
  const evs = icsEvents(text, win('2026-11-01T00:00:00Z', '2027-03-31T00:00:00Z'))
  const of = (title: string) => evs.filter(e => e.title === title).map(e => e.start)
  assert.deepEqual(of('Trip'), ['2026-11-05'])
  assert.equal(evs.find(e => e.title === 'Trip')?.end, '2026-11-08')
  assert.equal(evs.find(e => e.title === 'Trip')?.allDay, true)
  assert.deepEqual(of('Review'), [
    '2026-11-27T16:00:00Z',
    '2026-12-25T16:00:00Z',
    '2027-01-29T16:00:00Z',
    '2027-02-26T16:00:00Z',
    '2027-03-26T16:00:00Z',
  ])
  assert.deepEqual(of('Birthday'), ['2027-03-12'])
  assert.deepEqual(of('Second Tuesday'), [
    '2026-11-10T08:00:00Z',
    '2026-12-08T08:00:00Z',
    '2027-01-12T08:00:00Z',
    '2027-02-09T08:00:00Z',
    '2027-03-09T08:00:00Z',
  ])
})

test('icsEvents: a zone only the file defines (VTIMEZONE), a Windows name, folded lines, the owner’s answer', () => {
  const text = ics(
    'BEGIN:VTIMEZONE',
    'TZID:Custom Eastern',
    'BEGIN:STANDARD',
    'DTSTART:19701101T020000',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:19700308T020000',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:a',
    'DTSTART;TZID=Custom Eastern:20261030T090000',
    'DTEND;TZID=Custom Eastern:20261030T100000',
    'SUMMARY:Before the change',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:b',
    'DTSTART;TZID=Custom Eastern:20261103T090000',
    'DTEND;TZID=Custom Eastern:20261103T100000',
    'SUMMARY:After the ch',
    ' ange',
    'ATTENDEE;CN="Me, Myself";PARTSTAT=DECLINED:mailto:Me@Example.com',
    'ATTENDEE;PARTSTAT=ACCEPTED:mailto:them@example.com',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:c',
    'DTSTART;TZID=Russian Standard Time:20261103T090000',
    'DTEND;TZID=Russian Standard Time:20261103T100000',
    'SUMMARY:Moscow',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:d',
    'DTSTART:20261103T120000',
    'DTEND:20261103T130000',
    'SUMMARY:Floating',
    'END:VEVENT',
  )
  const evs = icsEvents(text, {
    ...win('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z'),
    zone: 'Asia/Tokyo',
    account: 'me@example.com',
  })
  const by = (title: string) => evs.find(e => e.title === title)
  assert.equal(by('Before the change')?.start, '2026-10-30T13:00:00Z')
  assert.equal(by('After the change')?.start, '2026-11-03T14:00:00Z')
  assert.equal(by('After the change')?.response, 'declined')
  assert.equal(by('After the change')?.attendees, 2)
  assert.equal(by('Moscow')?.start, '2026-11-03T06:00:00Z')
  // floating: the zone given, as the file names none
  assert.equal(by('Floating')?.start, '2026-11-03T03:00:00Z')
})

test('ruleOf: what the reader expands, and what it leaves to the first instance', () => {
  assert.equal(ruleOf('FREQ=HOURLY;INTERVAL=2'), null)
  const r = ruleOf('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=SU;UNTIL=20261231T000000Z')
  assert.equal(r?.interval, 2)
  assert.deepEqual(r?.byDay, [
    [0, 1],
    [0, 3],
  ])
  assert.equal(r?.wkst, 0)
})

// ------------------------------------------------------------------ the Google Workspace preset

const GOOGLE = [
  "Successfully retrieved 3 events from calendar 'primary' for me@example.com:",
  '- "Weekly sync" (Starts: 2026-11-02T08:00:00-05:00 [America/New_York; weekday: Monday; ISO weekday: 1], Ends: 2026-11-02T09:00:00-05:00 [America/New_York; weekday: Monday; ISO weekday: 1])',
  '  Description: <p>Join Zoom Meeting<br/>https://example.zoom.us/j/111222333?pwd=abc</p>',
  '  Location: https://example.zoom.us/j/111222333?pwd=abc',
  '  Color ID: None',
  '  Recurring Event ID: series1_R20261005T130000',
  '  Creator: <host@example.com>',
  '  Organizer: <host@example.com>',
  '  Attendees: host@example.com, me@example.com',
  '  Attendee Details: host@example.com: accepted (organizer)',
  '    me@example.com: declined (note: "Out that day")',
  '  ID: series1_20261102T130000Z | Link: https://www.google.com/calendar/event?eid=AAA',
  '- "Office day" (Starts: 2026-11-03 [weekday: Tuesday; ISO weekday: 2], Ends: 2026-11-04 [weekday: Wednesday; ISO weekday: 3; exclusive all-day end])',
  '  Description: ',
  'Line one of a note',
  '- not a head line',
  '  Location: No Location',
  '  Color ID: None',
  '  Event Type: workingLocation',
  '  Creator: <me@example.com>',
  '  Organizer: <me@example.com>',
  '  Attendees: None',
  '  Attendee Details: None',
  '  ID: wl1 | Link: https://www.google.com/calendar/event?eid=BBB',
  '- "Review "Q4" plan" (Starts: 2026-11-03T10:00:00+04:00 [Asia/Yerevan; weekday: Tuesday; ISO weekday: 2], Ends: 2026-11-03T10:30:00+04:00 [Asia/Yerevan; weekday: Tuesday; ISO weekday: 2])',
  '  Description: Teams below',
  '  Location: Microsoft Teams Meeting',
  '  Color ID: None',
  '  Creator: <a@example.com>',
  '  Organizer: A Person <a@example.com>',
  '  Meeting Link: https://meet.google.com/abc-defg-hij',
  '  Attendees: a@example.com, me@example.com, b@example.com',
  '  Attendee Details: a@example.com: accepted (organizer)',
  '    me@example.com: needsAction (optional)',
  '    b@example.com: tentative',
  '  ID: e3 | Link: https://www.google.com/calendar/event?eid=CCC',
  '',
  'Next page token: TOKEN==',
  'Pagination time_min: 2026-11-01T00:00:00Z',
].join('\n')

test('googleEvents: the detailed text read block by block; the owner’s answer, the join link, all-day, the next page', () => {
  const r = googleEvents(GOOGLE, { id: 'work', account: 'Me@example.com' })
  assert.deepEqual(r.next, { pageToken: 'TOKEN==', timeMin: '2026-11-01T00:00:00Z' })
  assert.equal(r.events.length, 3)
  const [a, b, c] = r.events
  assert.deepEqual(a, {
    source: 'work',
    id: 'series1_20261102T130000Z',
    title: 'Weekly sync',
    start: '2026-11-02T08:00:00-05:00',
    end: '2026-11-02T09:00:00-05:00',
    allDay: false,
    zone: NY,
    location: 'https://example.zoom.us/j/111222333?pwd=abc',
    join: 'https://example.zoom.us/j/111222333?pwd=abc',
    link: 'https://www.google.com/calendar/event?eid=AAA',
    attendees: 2,
    status: 'confirmed',
    response: 'declined',
    series: 'series1_R20261005T130000',
  })
  assert.equal(b?.allDay, true)
  assert.equal(b?.start, '2026-11-03')
  assert.equal(b?.end, '2026-11-04')
  assert.equal(b?.kind, 'workingLocation')
  assert.equal(b?.location, undefined)
  assert.equal(b?.attendees, undefined)
  assert.equal(c?.title, 'Review "Q4" plan')
  assert.equal(c?.join, 'https://meet.google.com/abc-defg-hij')
  assert.equal(c?.response, 'needsAction')
  assert.equal(c?.attendees, 3)
})

test('googleEvents: the short form (ID on the head line), no events, and the arguments it is asked with', () => {
  const short = googleEvents(
    'Successfully retrieved 1 events from calendar \'primary\' for me@example.com:\n- "One" (Starts: 2026-11-02T08:00:00Z [UTC; weekday: Monday; ISO weekday: 1], Ends: 2026-11-02T09:00:00Z [UTC; weekday: Monday; ISO weekday: 1]) ID: x1 | Link: https://www.google.com/calendar/event?eid=X',
    { id: 'w', account: null },
  )
  assert.deepEqual(
    short.events.map(e => [e.id, e.start, e.link]),
    [['x1', '2026-11-02T08:00:00Z', 'https://www.google.com/calendar/event?eid=X']],
  )
  assert.deepEqual(googleEvents('No events found in calendar primary.', { id: 'w', account: null }), {
    events: [],
    next: null,
  })
  const args = googleListArgs(
    { account: 'me@example.com' },
    'primary',
    Date.parse('2026-11-01T00:00:00Z'),
    Date.parse('2026-12-01T00:00:00Z'),
    {
      pageToken: 'T',
      timeMin: '2026-10-31T00:00:00Z',
    },
  )
  assert.deepEqual(args, {
    user_google_email: 'me@example.com',
    calendar_id: 'primary',
    time_min: '2026-10-31T00:00:00Z',
    time_max: '2026-12-01T00:00:00Z',
    max_results: 250,
    detailed: true,
    single_events: true,
    page_token: 'T',
  })
  assert.deepEqual(googleWriteArgs({ account: 'me@example.com', calendars: ['primary'] }, { op: 'delete', id: 'x1' }), {
    user_google_email: 'me@example.com',
    action: 'delete',
    calendar_id: 'primary',
    event_id: 'x1',
  })
  assert.equal(writtenId('Successfully created event "X" (ID: abc_123) for me@example.com'), 'abc_123')
})

// ------------------------------------------------------------------ the grid

const at = (hm: string) => Date.parse(`2026-11-02T${hm}:00Z`)

test('columns: overlapping items share the width; a chain shares one count; an item widens over free columns', () => {
  const items = [
    { id: 'a', start: at('09:00'), end: at('10:00') },
    { id: 'b', start: at('09:30'), end: at('10:30') },
    { id: 'c', start: at('10:00'), end: at('11:00') },
    { id: 'd', start: at('12:00'), end: at('12:05') },
    { id: 'e', start: at('12:10'), end: at('13:00') },
  ]
  const placed = columns(items, x => x)
  const of = (id: string) => placed.find(p => p.item.id === id)
  assert.deepEqual(
    ['a', 'b', 'c'].map(id => [of(id)?.col, of(id)?.cols, of(id)?.span]),
    [
      [0, 2, 1],
      [1, 2, 1],
      [0, 2, 1],
    ],
  )
  // d takes 15 minutes of room, so e (at 12:10) sits beside it
  assert.deepEqual([of('d')?.col, of('d')?.cols, of('e')?.col], [0, 2, 1])
  const wide = columns(
    [
      { id: 'long', start: at('09:00'), end: at('12:00') },
      { id: 'x', start: at('09:00'), end: at('10:00') },
      { id: 'y', start: at('09:00'), end: at('09:30') },
      { id: 'z', start: at('10:00'), end: at('11:00') },
    ],
    x => x,
  )
  const z = wide.find(p => p.item.id === 'z')
  assert.deepEqual([z?.col, z?.cols, z?.span], [1, 3, 2])
})

test('weeks and months: the week by its first day; a month’s grid from its first week to its last', () => {
  assert.equal(weekOf('2026-11-04', 1), '2026-11-02')
  assert.equal(weekOf('2026-11-04', 0), '2026-11-01')
  const m = monthWeeks('2026-11-15', 1)
  assert.equal(m.length, 6)
  assert.equal(m[0]?.[0], '2026-10-26')
  assert.equal(m.at(-1)?.[6], '2026-12-06')
})

test('bars: rows for items over days, cut at the strip with a mark that they go on', () => {
  const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']
  const placed = bars(
    [
      { id: 'trip', first: '2026-10-30', last: '2026-11-03' },
      { id: 'conf', first: '2026-11-03', last: '2026-11-05' },
      { id: 'one', first: '2026-11-04', last: '2026-11-04' },
      { id: 'out', first: '2026-11-20', last: '2026-11-21' },
    ],
    days,
    x => x,
  )
  const of = (id: string) => placed.find(p => p.item.id === id)
  assert.equal(of('out'), undefined)
  assert.deepEqual([of('trip')?.from, of('trip')?.to, of('trip')?.before, of('trip')?.row], [0, 1, true, 0])
  assert.deepEqual([of('conf')?.from, of('conf')?.to, of('conf')?.row], [1, 3, 1])
  assert.deepEqual([of('one')?.row], [0])
})
