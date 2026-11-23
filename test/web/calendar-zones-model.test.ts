// Multi-timezone model rules (#646, web/src/models/calendar-zones.ts): UTC offsets including
// half-hour and 45-minute zones, per-day daylight saving transitions (fall-back, spring-forward,
// 30-minute DST, Monday-first and Sunday-first weeks, primary-zone DST), gutter ordering and
// primary swap, popover lines across date boundaries, and searchable IANA picking.
import { describe, expect, test } from 'bun:test'
import { clockText, firstHour, localDate, midnight, minuteIn } from '../../web/src/models/calendar.ts'
import {
  activeExtraZones,
  allIanaZones,
  buildGutterZones,
  dayDstShifts,
  formatOffsetRange,
  formatUtcOffset,
  gutterRowsFor,
  offsetMinutesAt,
  popoverZoneLines,
  resolvePrimaryZone,
  searchZones,
} from '../../web/src/models/calendar-zones.ts'

describe('UTC offsets and formatting', () => {
  test('computes whole-hour, half-hour, and 45-minute offsets accurately', () => {
    const winter = Date.parse('2026-11-10T12:00:00Z')
    const summer = Date.parse('2026-07-10T12:00:00Z')
    expect(offsetMinutesAt(winter, 'UTC')).toBe(0)
    expect(offsetMinutesAt(winter, 'Asia/Yerevan')).toBe(240)
    expect(offsetMinutesAt(winter, 'America/New_York')).toBe(-300)
    expect(offsetMinutesAt(summer, 'America/New_York')).toBe(-240)
    expect(offsetMinutesAt(winter, 'America/Los_Angeles')).toBe(-480)
    expect(offsetMinutesAt(summer, 'America/Los_Angeles')).toBe(-420)
    expect(offsetMinutesAt(winter, 'Asia/Kolkata')).toBe(330)
    expect(offsetMinutesAt(winter, 'Asia/Kathmandu')).toBe(345)
    expect(offsetMinutesAt(winter, 'America/St_Johns')).toBe(-210)
    expect(offsetMinutesAt(summer, 'America/St_Johns')).toBe(-150)

    expect(formatUtcOffset(0)).toBe('UTC')
    expect(formatUtcOffset(240)).toBe('UTC+4')
    expect(formatUtcOffset(-300)).toBe('UTC-5')
    expect(formatUtcOffset(330)).toBe('UTC+5:30')
    expect(formatUtcOffset(-210)).toBe('UTC-3:30')
    expect(formatUtcOffset(345)).toBe('UTC+5:45')
    expect(formatOffsetRange(-240, -300)).toBe('UTC-4/-5')
    expect(formatOffsetRange(60, 0)).toBe('UTC+1/+0')
    expect(formatOffsetRange(630, 660)).toBe('UTC+10:30/+11')
    expect(formatOffsetRange(330, 330)).toBe('UTC+5:30')
  })
})

describe('gutter zone ordering and primary swap', () => {
  test('off by default: no extra zones yields a single primary home column', () => {
    const cols = buildGutterZones('Asia/Yerevan', [], null, ['2026-11-04'])
    expect(cols).toHaveLength(1)
    expect(cols[0]?.zone).toBe('Asia/Yerevan')
    expect(cols[0]?.primary).toBe(true)
    expect(cols[0]?.home).toBe(true)
    expect(cols[0]?.offsetText).toBe('UTC+4')
  })

  test('places primary nearest the grid (last) and deduplicates home or repeated extras', () => {
    const extras = [
      { zone: 'America/New_York', label: 'NY' },
      { zone: 'Asia/Yerevan', label: 'Home' },
      { zone: 'America/New_York', label: 'Dup' },
      { zone: 'America/Los_Angeles', label: 'PT' },
      { zone: 'Asia/Tokyo', label: 'TYO' },
    ]
    expect(activeExtraZones('Asia/Yerevan', extras)).toEqual([
      { zone: 'America/New_York', label: 'NY' },
      { zone: 'America/Los_Angeles', label: 'PT' },
    ])

    const normal = buildGutterZones('Asia/Yerevan', extras, null, ['2026-11-04'])
    expect(normal.map(z => [z.label, z.zone, z.primary, z.offsetText])).toEqual([
      ['NY', 'America/New_York', false, 'UTC-5'],
      ['PT', 'America/Los_Angeles', false, 'UTC-8'],
      ['Yerevan', 'Asia/Yerevan', true, 'UTC+4'],
    ])

    // Swap NY to primary: NY moves nearest the grid, Yerevan becomes a secondary column
    const swapped = buildGutterZones('Asia/Yerevan', extras, 'America/New_York', ['2026-11-04'])
    expect(swapped.map(z => [z.label, z.zone, z.primary, z.home])).toEqual([
      ['Yerevan', 'Asia/Yerevan', false, true],
      ['PT', 'America/Los_Angeles', false, false],
      ['NY', 'America/New_York', true, false],
    ])

    // If a previously swapped zone is removed from settings, primary falls back to home
    expect(resolvePrimaryZone('Asia/Yerevan', [{ zone: 'America/Los_Angeles', label: 'PT' }], 'America/New_York')).toBe(
      'Asia/Yerevan',
    )
  })
})

describe('gutter rows: half-hour offsets and per-day DST', () => {
  test('half-hour and 45-minute secondary columns show exact minutes in 24h and 12h', () => {
    const day = ['2026-11-04']
    const ist24 = gutterRowsFor(day, 'Asia/Yerevan', 'Asia/Kolkata', 'en', 'h23')
    expect(ist24[0]?.text).toBe('')
    expect(ist24[9]?.text).toBe('10:30')
    expect(ist24[18]?.text).toBe('19:30')

    const ist12 = gutterRowsFor(day, 'Asia/Yerevan', 'Asia/Kolkata', 'en', 'h12')
    expect(ist12[9]?.text).toBe('10:30 AM')
    expect(ist12[18]?.text).toBe('7:30 PM')

    const npt24 = gutterRowsFor(day, 'UTC', 'Asia/Kathmandu', 'en', 'h23')
    expect(npt24[10]?.text).toBe('15:45')
  })

  test('day view on US fall-back day (2026-11-01) repeats 01:00 in NY at the exact transition hour', () => {
    // 2026-11-01 in Asia/Yerevan (UTC+4):
    // 08:00 EVN = 04:00Z = 00:00 EDT (NY, UTC-4)
    // 09:00 EVN = 05:00Z = 01:00 EDT (NY, UTC-4)
    // 10:00 EVN = 06:00Z = 01:00 EST (NY, UTC-5) -> fall-back repeated hour!
    // 11:00 EVN = 07:00Z = 02:00 EST (NY, UTC-5)
    const rows = gutterRowsFor(['2026-11-01'], 'Asia/Yerevan', 'America/New_York', 'en', 'h23')
    expect(rows[8]?.text).toBe('00:00')
    expect(rows[8]?.midnight).toBe(true)
    expect(rows[9]?.text).toBe('01:00')
    expect(rows[10]?.text).toBe('01:00')
    expect(rows[11]?.text).toBe('02:00')
    expect(rows[18]?.text).toBe('09:00')

    const zones = buildGutterZones('Asia/Yerevan', [{ zone: 'America/New_York', label: 'NY' }], null, ['2026-11-01'])
    expect(zones[0]?.offsetText).toBe('UTC-4/-5')
    expect(zones[0]?.relativeShift).toBe(true)
  })

  test('day view on US spring-forward day (2026-03-08) skips 02:00 in NY at the exact transition hour', () => {
    // 2026-03-08 in Asia/Yerevan (UTC+4):
    // 10:00 EVN = 06:00Z = 01:00 EST (NY, UTC-5)
    // 11:00 EVN = 07:00Z = 03:00 EDT (NY, UTC-4) -> spring-forward skips 02:00!
    const rows = gutterRowsFor(['2026-03-08'], 'Asia/Yerevan', 'America/New_York', 'en', 'h23')
    expect(rows[10]?.text).toBe('01:00')
    expect(rows[11]?.text).toBe('03:00')
    expect(rows[18]?.text).toBe('10:00')
  })

  test('week view crossing US fall-back (Mon Oct 26 to Sun Nov 1) shows both sides per row and marks Sun Nov 1', () => {
    const week = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']
    const zones = buildGutterZones('Asia/Yerevan', [{ zone: 'America/New_York', label: 'NY' }], null, week)
    expect(zones[0]?.offsetText).toBe('UTC-4/-5')
    expect(zones[1]?.offsetText).toBe('UTC+4')

    const nyRows = gutterRowsFor(week, 'Asia/Yerevan', 'America/New_York', 'en', 'h23')
    // At 08:00 EVN (04:00Z), Sun Nov 1 has not transitioned yet -> all 7 days are 00:00 NY
    expect(nyRows[8]?.text).toBe('00:00')
    expect(nyRows[8]?.title).toBe('')
    // At 18:00 EVN (14:00Z), Mon-Sat are 10:00 EDT, Sun is 09:00 EST
    expect(nyRows[18]?.text).toBe('10/09')
    expect(nyRows[18]?.title).toContain('10:00')
    expect(nyRows[18]?.title).toContain('09:00')

    // 12-hour format on the same split row
    const nyRows12 = gutterRowsFor(week, 'Asia/Yerevan', 'America/New_York', 'en', 'h12')
    expect(nyRows12[18]?.text).toBe('10/9 AM')

    // Per-day DST shift marker lands on Sunday Nov 1 only
    const shifts = dayDstShifts(week, 'Asia/Yerevan', zones)
    expect([...shifts.keys()]).toEqual(['2026-11-01'])
    expect(shifts.get('2026-11-01')).toEqual([
      { date: '2026-11-01', zone: 'America/New_York', label: 'NY', offsetText: 'UTC-5' },
    ])
  })

  test('week view crossing primary-zone DST shifts secondary column hours even when secondary has no DST', () => {
    // Primary = America/New_York (falls back Sun Nov 1), Secondary = Asia/Yerevan (constant UTC+4)
    const week = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']
    const zones = buildGutterZones(
      'Asia/Yerevan',
      [{ zone: 'America/New_York', label: 'NY' }],
      'America/New_York',
      week,
    )
    const evn = zones.find(z => z.zone === 'Asia/Yerevan')
    const ny = zones.find(z => z.zone === 'America/New_York')
    expect(ny?.primary).toBe(true)
    expect(ny?.offsetText).toBe('UTC-4/-5')
    expect(evn?.offsetText).toBe('UTC+4')
    expect(evn?.relativeShift).toBe(true)

    const evnRows = gutterRowsFor(week, 'America/New_York', 'Asia/Yerevan', 'en', 'h23')
    // 09:00 NY: Mon-Sat EDT -> 17:00 EVN; Sun EST -> 18:00 EVN
    expect(evnRows[9]?.text).toBe('17/18')
  })

  test('30-minute DST shift (Australia/Lord_Howe) shows exact half-hour split', () => {
    // Lord Howe Island springs forward +30 min (UTC+10:30 -> UTC+11:00) on first Sunday of October (2026-10-04)
    const week = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']
    const zones = buildGutterZones('UTC', [{ zone: 'Australia/Lord_Howe', label: 'LH' }], null, week)
    expect(zones[0]?.offsetText).toBe('UTC+10:30/+11')
    const rows = gutterRowsFor(week, 'UTC', 'Australia/Lord_Howe', 'en', 'h23')
    expect(rows[10]?.text).toBe('20:30/21:00')
  })

  test('midnight-primary DST transitions and 3-group DST weeks are detected without blind spots', () => {
    // LA primary + Chicago secondary: Chicago springs forward at 08:00Z = 00:00 LA on 2026-03-08
    const marchWeek = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']
    const laChi = buildGutterZones('America/Los_Angeles', [{ zone: 'America/Chicago', label: 'CT' }], null, marchWeek)
    const laChiShifts = dayDstShifts(marchWeek, 'America/Los_Angeles', laChi)
    expect(laChiShifts.get('2026-03-08')?.map(s => [s.label, s.offsetText])).toEqual([
      ['CT', 'UTC-5'],
      ['Los Angeles', 'UTC-7'],
    ])

    // London primary + Jerusalem secondary: Israel shifts Fri Mar 27, London shifts Sun Mar 29 (3 groups)
    const dualWeek = ['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29']
    const jlmRows = gutterRowsFor(dualWeek, 'Europe/London', 'Asia/Jerusalem', 'en', 'h23')
    // 10:00 London: Mon-Thu 12:00, Fri-Sat 13:00, Sun 12:00 -> must show 12/13, never 12/12
    expect(jlmRows[10]?.text).toBe('12/13')
    expect(jlmRows[10]?.title).toContain('12:00')
    expect(jlmRows[10]?.title).toContain('13:00')

    // Half-hour zone with same-minute DST shift formats compactly ("18/19:30")
    const fallWeek = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']
    const istRows = gutterRowsFor(fallWeek, 'America/New_York', 'Asia/Kolkata', 'en', 'h23')
    expect(istRows[9]?.text).toBe('18/19:30')
  })
})

describe('popover zone lines and primary-zone calendar helpers', () => {
  test('popover shows start and end in every shown zone, primary first, with date notes across midnight', () => {
    // 2026-11-04 20:30Z - 21:30Z:
    // Yerevan (UTC+4): Thu 5 Nov, 00:30 - 01:30
    // NY (UTC-5): Wed 4 Nov, 15:30 - 16:30
    // Kolkata (UTC+5:30): Thu 5 Nov, 02:00 - 03:00
    const start = Date.parse('2026-11-04T20:30:00Z')
    const end = Date.parse('2026-11-04T21:30:00Z')
    const zones = buildGutterZones(
      'Asia/Yerevan',
      [
        { zone: 'America/New_York', label: 'NY' },
        { zone: 'Asia/Kolkata', label: 'IST' },
      ],
      null,
      ['2026-11-05'],
    )
    const lines = popoverZoneLines(start, end, zones, 'en', 'h23')
    expect(lines.map(l => [l.label, l.primary, l.offsetText, l.timeText, Boolean(l.dateNote)])).toEqual([
      ['Yerevan', true, 'UTC+4', '00:30 - 01:30', false],
      ['NY', false, 'UTC-5', '15:30 - 16:30', true],
      ['IST', false, 'UTC+5:30', '02:00 - 03:00', false],
    ])
    expect(lines[1]?.dateNote).toContain('4')
  })

  test('popover uses exact event-date DST offset (before vs after fall-back)', () => {
    const zones = buildGutterZones('Asia/Yerevan', [{ zone: 'America/New_York', label: 'NY' }], null, ['2026-10-30'])
    const before = popoverZoneLines(
      Date.parse('2026-10-30T14:00:00Z'),
      Date.parse('2026-10-30T15:00:00Z'),
      zones,
      'en',
      'h23',
    )
    const after = popoverZoneLines(
      Date.parse('2026-11-03T14:00:00Z'),
      Date.parse('2026-11-03T15:00:00Z'),
      zones,
      'en',
      'h23',
    )
    expect(before[1]?.offsetText).toBe('UTC-4')
    expect(before[1]?.timeText).toBe('10:00 - 11:00')
    expect(after[1]?.offsetText).toBe('UTC-5')
    expect(after[1]?.timeText).toBe('09:00 - 10:00')
  })

  test('calendar helpers follow swapped primary zone for date, midnight, minute, clock, and firstHour', () => {
    const at = Date.parse('2026-11-04T21:30:00Z')
    expect(localDate(at, 'Asia/Yerevan')).toBe('2026-11-05')
    expect(localDate(at, 'America/New_York')).toBe('2026-11-04')
    expect(minuteIn(at, 'Asia/Yerevan')).toBe(90)
    expect(minuteIn(at, 'America/New_York')).toBe(16 * 60 + 30)
    expect(clockText(at, 'en', 'h23', 'America/New_York')).toBe('16:30')
    expect(clockText(at, 'en', 'h23', 'Asia/Kolkata')).toBe('03:00')
    expect(midnight('2026-11-04', 'America/New_York')).toBe(Date.parse('2026-11-04T05:00:00Z'))
    expect(firstHour(['2026-11-04'], [], at, 'America/New_York')).toBe(15)
  })
})

describe('searchable IANA zone picker', () => {
  test('matches city, region, abbreviation, and UTC offset while excluding already-chosen zones', () => {
    const now = Date.parse('2026-11-10T12:00:00Z')
    const all = allIanaZones()
    expect(all).toContain('America/New_York')
    expect(all).toContain('Asia/Kolkata')
    expect(all).toContain('UTC')

    const ny = searchZones('new york', all, now)
    expect(ny[0]?.zone).toBe('America/New_York')
    expect(ny[0]?.offsetText).toBe('UTC-5')

    const half = searchZones('+5:30', all, now)
    expect(half.some(o => o.zone === 'Asia/Kolkata')).toBe(true)

    const excluded = searchZones('new york', all, now, new Set(['America/New_York']))
    expect(excluded.some(o => o.zone === 'America/New_York')).toBe(false)
  })
})
