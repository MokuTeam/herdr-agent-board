import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { translator } from '../../src/core/i18n/translator.ts'
import {
  billableByDefault,
  billableOf,
  clientDay,
  clientOf,
  clockIn,
  DEFAULT_REF,
  dateIn,
  durationOf,
  entryView,
  hm,
  instantIn,
  isDate,
  outsideProject,
  parseWhen,
  plausible,
  problemsText,
  projectIn,
  projectKey,
  refIn,
  rounded,
  systemsFor,
  systemsOfProject,
  type TimeEntry,
  takersOf,
  timeConfig,
} from '../../src/core/time.ts'

const NY = 'America/New_York'

test('timeConfig: off unless `time` is there; the zone, the held tags, the clients and their rules read', () => {
  assert.equal(timeConfig(undefined), null)
  assert.equal(timeConfig(false), null)
  const any = timeConfig(true)
  assert.ok(any)
  assert.equal(any.clients, null)
  assert.deepEqual(any.excludeTags, ['deferred'])
  const c = timeConfig({
    zone: NY,
    clients: {
      a: {
        projects: ['Support', 'Support', ' Migration '],
        billing: [
          { match: '^Admin', group: 'day', round: 'exact' },
          { group: 'ref', step: 30, round: 'up' },
        ],
      },
      b: {},
    },
  })
  assert.ok(c)
  assert.deepEqual(c.problems, [])
  assert.equal(c.zone, NY)
  assert.deepEqual(c.clients?.a?.projects, ['Support', 'Migration'])
  assert.deepEqual(c.clients?.a?.billing, [
    { match: '^Admin', group: 'day', step: 0, round: 'exact' },
    { match: null, group: 'ref', step: 30, round: 'up' },
  ])
  assert.equal(c.clients?.b?.zone, null)
  assert.equal(c.clients?.b?.ref, DEFAULT_REF)
  assert.equal(clientOf(c, 'zz').ok, false)
  assert.equal(clientOf(any, 'zz').ok, true, 'without a clients list every lane takes time')
})

test('timeConfig guesses nothing: each value that does not check out is a problem, named by its place', () => {
  const c = timeConfig({
    zone: 'America/New York',
    excludetags: ['Deferred'],
    clients: {
      a: {
        ref: '(\\d{5}',
        billing: [
          { match: '^Admin(', group: 'day', round: 'exact' },
          { group: 'ref', step: 30, round: 'Up' },
          { group: 'case', step: 30, round: 'up' },
          { group: 'ref', round: 'up' },
          { group: 'ref', step: 30 },
          { step: 30, round: 'up' },
          'exact',
        ],
        zone: 'Not/AZone',
        project: ['Support'],
      },
      b: 'yes',
    },
  })
  assert.ok(c)
  assert.deepEqual(
    c.problems.map(p => [p.at, p.why]),
    [
      ['time.excludetags', 'unknown'],
      ['time.zone', 'zone'],
      ['time.clients.a.project', 'unknown'],
      ['time.clients.a.ref', 'regex'],
      ['time.clients.a.zone', 'zone'],
      ['time.clients.a.billing[0].match', 'regex'],
      ['time.clients.a.billing[1].round', 'round'],
      ['time.clients.a.billing[2].group', 'group'],
      ['time.clients.a.billing[3].step', 'step'],
      ['time.clients.a.billing[4].round', 'required'],
      ['time.clients.a.billing[5].group', 'required'],
      ['time.clients.a.billing[6]', 'type'],
      ['time.clients.b', 'type'],
    ],
  )
  // read as well as it can be for a view that says so; nothing in it is taken for something else
  assert.deepEqual(c.clients?.a?.billing, [])
  // the zone is required; held tags are kept as stored tags are, lowercase
  assert.deepEqual(
    timeConfig({ excludeTags: ['Deferred'] })?.problems.map(p => [p.at, p.why]),
    [['time.zone', 'required']],
  )
  assert.deepEqual(timeConfig({ zone: NY, excludeTags: ['Deferred', ' Hold '] })?.excludeTags, ['deferred', 'hold'])
  // true: the computer's own zone, by choice
  assert.deepEqual(timeConfig(true)?.problems, [])
  // in a line, for an error or the doctor
  const t = translator('en')
  assert.equal(
    problemsText(timeConfig({ zone: 'Mars/Base' })?.problems ?? [], t),
    'time.zone: "Mars/Base" is not a time zone (an IANA name, such as America/New_York)',
  )
})

test('instantIn east of UTC too: Berlin’s repeated hour is its first, Auckland’s gap lands past it', () => {
  assert.equal(new Date(instantIn('2026-10-25', [2, 30, 0], 'Europe/Berlin')).toISOString(), '2026-10-25T00:30:00.000Z')
  const gap = instantIn('2026-09-27', [2, 30, 0], 'Pacific/Auckland')
  assert.equal(dateIn(gap, 'Pacific/Auckland'), '2026-09-27')
  assert.deepEqual(clockIn(gap, 'Pacific/Auckland'), [3, 30, 0])
  // every 15 minutes across both changes of a year, in zones west and east: the wall clock an
  // instant shows gives back that instant, or the first one that shows it
  for (const [zone, days] of [
    ['America/New_York', ['2026-03-08', '2026-11-01']],
    ['Europe/Berlin', ['2026-03-29', '2026-10-25']],
    ['Pacific/Auckland', ['2026-04-05', '2026-09-27']],
    ['Australia/Lord_Howe', ['2026-04-05', '2026-10-04']],
    ['Europe/Moscow', ['2026-06-01']],
  ] as const)
    for (const day of days)
      for (
        let at = Date.parse(`${day}T00:00:00Z`) - 86_400_000;
        at < Date.parse(`${day}T00:00:00Z`) + 86_400_000;
        at += 900_000
      ) {
        const back = instantIn(dateIn(at, zone), clockIn(at, zone), zone)
        assert.ok(back <= at, `${zone} ${new Date(at).toISOString()}`)
        assert.deepEqual([dateIn(back, zone), clockIn(back, zone)], [dateIn(at, zone), clockIn(at, zone)])
      }
})

test('HH:MM past midnight is last evening’s; an entry’s time is within a day ahead and a year back', () => {
  const now = new Date(2026, 9, 29, 0, 30).getTime()
  assert.equal(parseWhen('23:15', now), new Date(2026, 9, 28, 23, 15).getTime())
  assert.equal(parseWhen('0:10', now), new Date(2026, 9, 29, 0, 10).getTime())
  // up to an hour ahead stays today (a stop a few minutes from now)
  assert.equal(parseWhen('1:20', now), new Date(2026, 9, 29, 1, 20).getTime())
  assert.ok(plausible(now + 86_000_000, now))
  assert.ok(!plausible(now + 2 * 86_400_000, now))
  assert.ok(plausible(now - 300 * 86_400_000, now))
  assert.ok(!plausible(Date.parse('2062-01-01T00:00:00Z'), now))
  assert.ok(!plausible(now - 400 * 86_400_000, now))
})

test('the work date is the start’s date in the zone: past midnight in Istanbul is still the day before in New York', () => {
  const at = Date.parse('2026-10-29T01:30:00+03:00')
  assert.equal(dateIn(at, 'Europe/Istanbul'), '2026-10-29')
  assert.equal(dateIn(at, NY), '2026-10-28')
  assert.deepEqual(clockIn(at, NY), [18, 30, 0])
})

test('instantIn: a wall clock on a date in a zone, across both DST changes', () => {
  // New York leaves DST on 2026-11-01 (02:00 EDT -> 01:00 EST) and enters it on 2026-03-08
  assert.equal(new Date(instantIn('2026-10-30', [9, 0, 0], NY)).toISOString(), '2026-10-30T13:00:00.000Z')
  assert.equal(new Date(instantIn('2026-11-02', [9, 0, 0], NY)).toISOString(), '2026-11-02T14:00:00.000Z')
  // 01:30 happens twice on 2026-11-01: the first one (EDT)
  assert.equal(new Date(instantIn('2026-11-01', [1, 30, 0], NY)).toISOString(), '2026-11-01T05:30:00.000Z')
  // 02:30 does not happen on 2026-03-08: moved forward past the gap
  const gap = instantIn('2026-03-08', [2, 30, 0], NY)
  assert.equal(dateIn(gap, NY), '2026-03-08')
  assert.deepEqual(clockIn(gap, NY), [3, 30, 0])
})

test('parseWhen takes ISO with an offset, HH:MM today and YYYY-MM-DD HH:MM on this computer’s clock', () => {
  assert.equal(parseWhen('2026-10-28T09:00:00+03:00'), Date.parse('2026-10-28T06:00:00Z'))
  assert.equal(parseWhen('2026-10-28T09:00Z'), Date.parse('2026-10-28T09:00:00Z'))
  const now = new Date(2026, 9, 28, 15, 0).getTime()
  assert.equal(parseWhen('9:05', now), new Date(2026, 9, 28, 9, 5).getTime())
  assert.equal(parseWhen('2026-10-27 18:30'), new Date(2026, 9, 27, 18, 30).getTime())
  for (const bad of ['2026-10-28T09:00:00', '25:00', '9', 'tomorrow', '2026-02-30 10:00'])
    assert.equal(parseWhen(bad), null, bad)
  assert.ok(isDate('2026-02-28'))
  assert.ok(!isDate('2026-02-30'))
})

test('durations and H:MM', () => {
  assert.equal(durationOf({ minutes: '90' }), 5400)
  assert.equal(durationOf({ hours: '1.5' }), 5400)
  assert.equal(durationOf({ hours: '0' }), null)
  assert.equal(durationOf({ hours: '25' }), null)
  assert.equal(durationOf({}), null)
  assert.equal(hm(5400), '1:30')
  assert.equal(hm(59), '0:01')
})

test('rounding: up, nearest with a tie going up, down, exact', () => {
  const m = (n: number) => n * 60
  assert.equal(rounded(m(72), 30, 'up'), m(90))
  assert.equal(rounded(m(60), 30, 'up'), m(60))
  assert.equal(rounded(m(75), 30, 'nearest'), m(90), 'x:15 goes up')
  assert.equal(rounded(m(74), 30, 'nearest'), m(60))
  assert.equal(rounded(m(105), 30, 'nearest'), m(120), 'x:45 goes up')
  assert.equal(rounded(m(89), 30, 'down'), m(60))
  assert.equal(rounded(m(17) + 13, 0, 'exact'), m(17) + 13)
})

test('refIn: a case number or a ticket key, the first capture', () => {
  assert.equal(refIn('Case 10001 X: did a thing', DEFAULT_REF), '10001')
  assert.equal(refIn('abc-123: did a thing', DEFAULT_REF), 'ABC-123')
  assert.equal(refIn('a meeting', DEFAULT_REF), null)
})

let n = 0
function entry(o: Partial<TimeEntry> & { start: string; minutes: number }): TimeEntry {
  const start = Date.parse(o.start)
  return {
    id: `e${++n}`,
    client: 'a',
    project: 'Support',
    description: 'Case 10001 X: work',
    tags: [],
    date: '2026-10-28',
    by: 'user',
    at: 0,
    changed: 0,
    changedBy: 'user',
    rev: 1,
    ...o,
    stop: new Date(start + o.minutes * 60_000).toISOString(),
  }
}

test('a client’s day as billed: per case and day up to 0.5 h, Admin exact for the day, held tags apart', () => {
  const c = timeConfig({
    zone: NY,
    clients: {
      a: {
        billing: [
          { match: '^Admin', group: 'day', round: 'exact' },
          { group: 'ref', step: 30, round: 'up' },
        ],
      },
    },
  })
  assert.ok(c)
  const es = [
    entry({ start: '2026-10-28T13:00:00Z', minutes: 42, description: 'Case 10001 X: reproduced' }),
    entry({ start: '2026-10-28T15:00:00Z', minutes: 30, description: 'Case 10001 X: fixed' }),
    entry({ start: '2026-10-28T14:00:00Z', minutes: 20, description: 'Case 10002 Y: looked' }),
    entry({ start: '2026-10-28T16:00:00Z', minutes: 7, description: 'Admin 10001 X: reminder' }),
    entry({ start: '2026-10-28T16:30:00Z', minutes: 6, description: 'Admin 10002 Y: status line' }),
    entry({ start: '2026-10-28T17:00:00Z', minutes: 30, description: 'Case 10003 Z: later', tags: ['deferred'] }),
  ]
  const day = clientDay(c, 'a', '2026-10-28', es)
  assert.deepEqual(
    day.lines.map(l => [l.ref ?? l.project, l.seconds / 60, l.billedSeconds / 60, l.entries.length]),
    [
      ['10001', 72, 90, 2],
      ['10002', 20, 30, 1],
      ['Support', 13, 13, 2],
    ],
  )
  assert.equal(day.held.length, 1)
  assert.equal(day.seconds / 60, 105)
  assert.equal(day.billedSeconds / 60, 133)
  assert.equal(day.zone, NY)
})

test('a case is one line whatever its project, rounded once; entries with no case, by project', () => {
  const c = timeConfig({ zone: NY, clients: { a: { billing: [{ group: 'ref', step: 30, round: 'up' }] } } })
  assert.ok(c)
  const es = [
    entry({ start: '2026-10-28T13:00:00Z', minutes: 20, description: 'Case 10001 X: looked', project: 'Support' }),
    entry({ start: '2026-10-28T14:00:00Z', minutes: 20, description: 'Case 10001 X: moved', project: 'Migration' }),
    entry({ start: '2026-10-28T15:00:00Z', minutes: 10, description: 'Standup', project: 'Support' }),
  ]
  const day = clientDay(c, 'a', '2026-10-28', es)
  assert.deepEqual(
    day.lines.map(l => [l.ref, l.project, l.seconds / 60, l.billedSeconds / 60]),
    [
      ['10001', '', 40, 60],
      [null, 'Support', 10, 30],
    ],
  )
})

test('no rules: each entry alone and exact; a `project` group adds a project’s entries up', () => {
  const plain = timeConfig({ clients: { a: {} } })
  assert.ok(plain)
  const es = [
    entry({ start: '2026-10-28T13:00:00Z', minutes: 17 }),
    entry({ start: '2026-10-28T14:00:00Z', minutes: 18 }),
  ]
  assert.deepEqual(
    clientDay(plain, 'a', '2026-10-28', es).lines.map(l => [l.seconds / 60, l.billedSeconds / 60]),
    [
      [17, 17],
      [18, 18],
    ],
  )
  const byProject = timeConfig({ clients: { a: { billing: [{ group: 'project', step: 30, round: 'nearest' }] } } })
  assert.ok(byProject)
  assert.deepEqual(
    clientDay(byProject, 'a', '2026-10-28', es).lines.map(l => [l.project, l.seconds / 60, l.billedSeconds / 60]),
    [['Support', 35, 30]],
  )
})

test('billable and systems in config: a client billed or not, its projects that are not, where its time is entered', () => {
  const c = timeConfig({
    zone: NY,
    clients: {
      a: {
        projects: ['Support', 'Internal'],
        nonBillable: ['Internal'],
        systems: ['erp', { id: 'tracker', title: 'Tracker' }],
      },
      own: { billable: false },
    },
  })
  assert.ok(c)
  assert.deepEqual(c.problems, [])
  assert.deepEqual(systemsFor(c, 'a'), [
    { id: 'erp', title: 'erp' },
    { id: 'tracker', title: 'Tracker' },
  ])
  assert.deepEqual(systemsFor(c, 'own'), [])
  assert.deepEqual(
    [billableByDefault(c, 'a', 'Support'), billableByDefault(c, 'a', 'Internal'), billableByDefault(c, 'own', 'x')],
    [true, false, false],
  )
  // set on an entry, either way, it wins
  assert.equal(billableOf(c, { client: 'a', project: 'Internal', billable: true }), true)
  assert.equal(billableOf(c, { client: 'a', project: 'Support', billable: false }), false)
  assert.equal(billableOf(c, { client: 'own', project: 'x' }), false)
  // every lane, `time: true`: billed, nowhere to enter
  const any = timeConfig(true)
  assert.ok(any)
  assert.deepEqual([billableByDefault(any, 'x', 'y'), systemsFor(any, 'x')], [true, []])
})

test('billable and systems guess nothing either: each slip is a problem named by its place', () => {
  const c = timeConfig({
    zone: NY,
    clients: {
      a: {
        projects: ['Support'],
        billable: 'yes',
        nonBillable: ['Suport'],
        systems: ['erp', 'erp', 'ERP', { id: 'tracker', name: 'x' }, { id: 'wiki', title: 3 }, 7],
      },
      b: { systems: 'erp', nonBillable: 'Internal' },
    },
  })
  assert.ok(c)
  assert.deepEqual(
    c.problems.map(x => [x.at, x.why, x.value]),
    [
      ['time.clients.a.billable', 'type', 'yes'],
      ['time.clients.a.nonBillable[0]', 'project', 'Suport'],
      ['time.clients.a.systems[1]', 'system', 'erp'],
      ['time.clients.a.systems[2]', 'system', 'ERP'],
      ['time.clients.a.systems[3].name', 'unknown', undefined],
      ['time.clients.a.systems[4].title', 'type', '3'],
      ['time.clients.a.systems[5]', 'type', '7'],
      ['time.clients.b.nonBillable', 'type', 'Internal'],
      ['time.clients.b.systems', 'type', 'erp'],
    ],
  )
  assert.match(
    problemsText(c.problems.slice(1, 3), translator('en')),
    /not one of this client’s projects.*not a system id/,
  )
})

test('a non-billable entry counts as worked, never as billed: in no line, so no rounding, no Raise or Trim', () => {
  const c = timeConfig({
    zone: NY,
    clients: { a: { nonBillable: ['Internal'], billing: [{ group: 'ref', step: 30, round: 'up' }] } },
  })
  assert.ok(c)
  const es = [
    entry({ start: '2026-10-28T13:00:00Z', minutes: 20, description: 'Case 10001 X: looked' }),
    // the same case, set non-billable: not in its line
    entry({ start: '2026-10-28T14:00:00Z', minutes: 25, description: 'Case 10001 X: our slip', billable: false }),
    entry({ start: '2026-10-28T15:00:00Z', minutes: 10, description: 'Standup', project: 'Internal' }),
    // non-billable and held: never billed beats billed later
    entry({
      start: '2026-10-28T16:00:00Z',
      minutes: 5,
      description: 'Case 10002',
      billable: false,
      tags: ['deferred'],
    }),
    entry({ start: '2026-10-28T17:00:00Z', minutes: 15, description: 'Case 10003', tags: ['deferred'] }),
  ]
  const day = clientDay(c, 'a', '2026-10-28', es)
  assert.deepEqual(
    day.lines.map(l => [l.ref, l.seconds / 60, l.billedSeconds / 60, l.entries.length]),
    [['10001', 20, 30, 1]],
  )
  assert.deepEqual([day.nonBillable.length, day.held.length], [3, 1])
  assert.deepEqual([day.seconds / 60, day.billedSeconds / 60], [60, 30])
})

test('time off keeps its settings; a client off and its retired projects are read, each slip a problem by its place', () => {
  // `on: false`: off, whatever else the section holds; absent or true: on, as every config so far
  assert.equal(timeConfig({ on: false, zone: NY, clients: { a: {} } }), null)
  assert.equal(timeConfig({ on: true, zone: NY })?.problems.length, 0)
  const c = timeConfig({
    zone: NY,
    clients: {
      a: { on: false, projects: ['Support'], retired: ['Old', 'Old'], nonBillable: ['Old'] },
      b: { projects: ['Support'] },
    },
  })
  assert.ok(c)
  assert.deepEqual(c.problems, [])
  assert.deepEqual(
    [c.clients?.a?.on, c.clients?.a?.retired, c.clients?.b?.on, c.clients?.b?.retired],
    [false, ['Old'], true, []],
  )
  assert.deepEqual(takersOf(c), ['b'])
  assert.equal(takersOf({ ...c, clients: null }), null)
  const bad = timeConfig({
    on: 'yes',
    zone: NY,
    clients: { a: { on: 1, projects: ['Support'], retired: ['support '] }, b: { retired: 'Old' } },
  })
  assert.deepEqual(
    bad?.problems.map(p => [p.at, p.why]),
    [
      ['time.on', 'type'],
      ['time.clients.a.on', 'type'],
      ['time.clients.a.retired[0]', 'retired'],
      ['time.clients.b.retired', 'type'],
    ],
  )
})

test('a project typed again is the one listed, case and spaces aside', () => {
  assert.equal(projectKey(' Cases  Work '), 'caseswork')
  assert.equal(projectIn(['Support', 'Cases work'], 'cases work '), 'Cases work')
  assert.equal(projectIn(['Support'], 'casesWork'), null)
  // the same letters however encoded, and characters that do not show: one name
  const accent = String.fromCharCode(0x301)
  const unseen = [0x200b, 0x200d, 0x2060, 0xfeff, 0xad].map(c => String.fromCharCode(c))
  assert.equal(projectKey(`Cafe${accent}`), projectKey('Café'))
  for (const u of unseen) assert.equal(projectKey(`Help${u}Desk`), 'helpdesk')
  // compatibility forms too: full-width letters, a ligature
  assert.equal(projectKey('ＡＢＣ'), 'abc')
  assert.equal(projectKey('ﬁle'), 'file')
})

test('a project billed elsewhere: its own systems (projectSystems), its name matched as names are; the rest the client’s', () => {
  const c = timeConfig({
    zone: NY,
    clients: {
      a: {
        projects: ['Support', 'Side Work'],
        retired: ['Old'],
        systems: ['erp', { id: 'tracker', title: 'Tracker' }],
        projectSystems: { 'side work': ['tracker'], Old: [] },
      },
    },
  })
  assert.ok(c)
  assert.deepEqual(c.problems, [])
  const ids = (project?: string) => systemsFor(c, 'a', project).map(s => s.id)
  assert.deepEqual(
    [ids(), ids('Support'), ids('Side Work'), ids('SIDE WORK '), ids('Old')],
    [['erp', 'tracker'], ['erp', 'tracker'], ['tracker'], ['tracker'], []],
  )
  // a mark in the client's other system is none of that project's; one in a system gone is its own
  const side = { client: 'a', project: 'Side Work' }
  assert.deepEqual(
    [outsideProject(c, side, 'erp'), outsideProject(c, side, 'tracker'), outsideProject(c, side, 'gone')],
    [true, false, false],
  )
  assert.equal(outsideProject(c, { client: 'a', project: 'Support' }, 'erp'), false)
  // the entry says where it is to be entered
  const e: TimeEntry = {
    id: 'e1',
    client: 'a',
    project: 'Side Work',
    description: 'x',
    tags: [],
    start: '2026-10-28T13:00:00Z',
    stop: '2026-10-28T14:00:00Z',
    date: '2026-10-28',
    by: 'user',
    at: 0,
    changed: 0,
    changedBy: 'user',
    rev: 1,
  }
  assert.deepEqual(entryView(c, e).systems, ['tracker'])
  assert.deepEqual(entryView(c, { ...e, project: 'Support' }).systems, ['erp', 'tracker'])
  // the page's settings, without projectSystems: the client's
  assert.deepEqual(systemsOfProject({ systems: [{ id: 'erp', title: 'ERP' }] }, 'Side Work'), [
    { id: 'erp', title: 'ERP' },
  ])
  // a client without a list takes any project's name as written
  const any = timeConfig({ zone: NY, clients: { b: { systems: ['erp', 'tracker'], projectSystems: { X: ['erp'] } } } })
  assert.deepEqual([any?.problems, any && systemsFor(any, 'b', 'x').map(s => s.id)], [[], ['erp']])
})

test('projectSystems guesses nothing: a project not the client’s, one named twice, a system not its own, each a problem', () => {
  const c = timeConfig({
    zone: NY,
    clients: {
      a: {
        projects: ['Support', 'Side Work'],
        systems: ['erp', 'tracker'],
        projectSystems: {
          Supprot: ['erp'],
          'Side Work': ['tracker', 'tracker', 'wiki'],
          'side work': ['erp'],
          Support: 'erp',
        },
      },
      b: { systems: ['erp'], projectSystems: ['erp'] },
    },
  })
  assert.ok(c)
  assert.deepEqual(
    c.problems.map(p => [p.at, p.why, p.value]),
    [
      ['time.clients.a.projectSystems.Supprot', 'project', 'Supprot'],
      ['time.clients.a.projectSystems.Side Work[1]', 'system', 'tracker'],
      ['time.clients.a.projectSystems.Side Work[2]', 'notSystem', 'wiki'],
      ['time.clients.a.projectSystems.side work', 'twice', 'side work'],
      ['time.clients.a.projectSystems.Support', 'type', 'erp'],
      ['time.clients.b.projectSystems', 'type', '["erp"]'],
    ],
  )
  assert.match(problemsText(c.problems, translator('en')), /"wiki" is not one of this client’s systems/)
})
