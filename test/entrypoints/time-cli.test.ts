// `board time …` (#233, entrypoints/time-cli.ts) as an agent runs it: JSON out, refusals that say
// what to do, writes only once the database is backed up somewhere.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { updateTarget, writeKey } from '../../src/adapters/backup-store.ts'
import { openDb } from '../../src/adapters/db.ts'
import { TimeError } from '../../src/adapters/time-store.ts'
import { makeKey } from '../../src/core/backup-file.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Actor } from '../../src/core/time.ts'
import type { Config } from '../../src/core/types.ts'
import { parseArgs, timeCmd } from '../../src/entrypoints/time-cli.ts'
import { timeChecks } from '../../src/services/time.ts'
import { editTimeSettings, type WithDb } from '../../src/services/time-settings.ts'
import { isolatedHome } from '../support/env.ts'

const me: Actor = { key: 's1', name: 'Session one' }
/** The tests' now: the entries' dates are near it, whatever day the suite runs. */
const NOW = Date.parse('2026-10-29T16:00:00Z')

async function setUp(backedUp: boolean | 'never' = true) {
  const dir = isolatedHome()
  const folder = join(dir, 'Sync')
  mkdirSync(folder)
  if (backedUp) {
    await writeKey(makeKey('correct horse battery', 1, { logN: 10, r: 8, p: 1 }))
    // a Test of the folder went the whole way round once ('never': set up, and never worked)
    if (backedUp === true) updateTarget('folder', st => ({ ...st, tested: Date.now(), where: folder }))
  }
  const cfg = {
    language: 'en',
    categories: [],
    time: {
      zone: 'America/New_York',
      clients: {
        'client-a': {
          projects: ['Support'],
          billing: [
            { match: '^Admin', group: 'day', round: 'exact' },
            { group: 'ref', step: 30, round: 'up' },
          ],
        },
        personal: { projects: ['Internal'] },
      },
    },
    ...(backedUp && { backup: { folder } }),
  } as unknown as Config
  return { dir, cfg }
}

async function run(cfg: Config, args: string[], actor: Actor = me, lane: string | null = 'client-a') {
  const lines: string[] = []
  await timeCmd(args, { cfg, actor, lane, now: NOW, out: line => lines.push(line) })
  return lines
}
const jsonOf = async (cfg: Config, args: string[], actor?: Actor) =>
  JSON.parse((await run(cfg, [...args, '--json'], actor)).join('\n'))

const keyOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (err) {
    assert.ok(err instanceof TimeError, String(err))
    return err.key
  }
  assert.fail('no error')
}

test('flags with values, repeated ones, bare ones and words', () => {
  const a = parseArgs(['--project', 'Support', '--tag', 'x', '--tag', 'y', '--force', 'Case', '10001'])
  assert.equal(a.one('--project'), 'Support')
  assert.deepEqual(a.all('--tag'), ['x', 'y'])
  assert.ok(a.has('--force'))
  assert.deepEqual(a.words, ['Case', '10001'])
  assert.throws(() => parseArgs(['--project']), TimeError)
})

test('time off: the command says how to turn it on', async () => {
  isolatedHome()
  assert.equal(await keyOf(run({ language: 'en' } as unknown as Config, ['list'])), 'time.err.off')
})

test('nothing is written before the database is backed up off the computer, once at least', async () => {
  const add = ['add', '--project', 'Support', '--minutes', '30', 'Case 10001 X: work']
  assert.equal(await keyOf(run((await setUp(false)).cfg, add)), 'time.err.noBackup')
  // a target and a key, but no backup or Test has ever gone through (a folder that does not exist, say)
  const { cfg } = await setUp('never')
  assert.equal(await keyOf(run(cfg, add)), 'time.err.notBackedUp')
  // one that did, once: a target down now does not stop a write
  const folder = (cfg.backup as { folder: string }).folder
  updateTarget('folder', st => ({
    ...st,
    lastOk: Date.now() - 30 * 86_400_000,
    error: 'offline',
    failures: 9,
    where: folder,
  }))
  assert.equal((await jsonOf(cfg, add)).existing, false)
  // the folder moved since: the new one has taken nothing
  const moved = { ...cfg, backup: { folder: `${folder}-new` } } as Config
  assert.equal(await keyOf(run(moved, add)), 'time.err.notBackedUp')
})

test('nothing is written while config.json’s time does not check out; a day says so; doctor names it', async () => {
  const { cfg } = await setUp()
  const bad = {
    ...cfg,
    time: { zone: 'America/New York', clients: { 'client-a': { projects: ['Support'] } } },
  } as Config
  const add = ['add', '--project', 'Support', '--minutes', '30', 'Case 10001 X: work']
  assert.equal(await keyOf(run(bad, add)), 'time.err.config')
  const day = await jsonOf(bad, ['day', '2026-10-28'])
  assert.deepEqual(day.problems, [
    'time.zone: "America/New York" is not a time zone (an IANA name, such as America/New_York)',
  ])
  assert.match((await run(bad, ['day', '2026-10-28']))[0] ?? '', /does not check out/)
  const [line] = timeChecks(bad, translator('en'))
  assert.equal(line?.level, 'error')
  assert.match(line?.detail ?? '', /time\.zone/)
  assert.equal(timeChecks(cfg, translator('en'))[0]?.level, 'ok')
  assert.deepEqual(timeChecks({ time: undefined } as unknown as Config, translator('en')), [])
})

test('the JSON an agent reads: an entry, a repeat, a list, a day, and an error, as the README says', async () => {
  const { cfg } = await setUp()
  const add = [
    'add',
    '--project',
    'Support',
    '--start',
    '2026-10-28T09:00:00-04:00',
    '--minutes',
    '30',
    'Case 10001 X: work',
  ]
  const made = await jsonOf(cfg, add)
  assert.deepEqual(Object.keys(made).sort(), [
    'at',
    'billable',
    'billableDefault',
    'by',
    'changed',
    'changedBy',
    'client',
    'date',
    'description',
    'existing',
    'id',
    'posts',
    'project',
    'rev',
    'seconds',
    'start',
    'stop',
    'tags',
  ])
  assert.deepEqual([made.billable, made.billableDefault, made.posts], [true, true, []])
  assert.match(made.id, /^[0-9a-f]{8}$/)
  assert.deepEqual((({ existing, reason }) => ({ existing, reason }))(await jsonOf(cfg, add)), {
    existing: true,
    reason: 'same',
  })
  const list = await jsonOf(cfg, ['list', '--date', '2026-10-28'])
  assert.deepEqual(
    list.map((e: { id: string; seconds: number }) => [e.id, e.seconds]),
    [[made.id, 1800]],
  )
  const day = await jsonOf(cfg, ['day', '2026-10-28'])
  assert.deepEqual(Object.keys(day), ['date', 'problems', 'days'])
  assert.deepEqual(Object.keys(day.days[0]).sort(), [
    'billedSeconds',
    'client',
    'date',
    'entries',
    'held',
    'lines',
    'nonBillable',
    'seconds',
    'zone',
  ])
  assert.deepEqual(day.days[0].lines[0].entries, [made.id])
  // an error under --json: JSON on stdout, the exit code 1
  const lines: string[] = []
  const code = await timeCmd(['edit', made.id, '--minutes', '10', '--json'], {
    cfg,
    actor: { key: 's2', name: 'Two' },
    lane: null,
    now: NOW,
    out: l => lines.push(l),
  })
  assert.equal(code, 1)
  const error = JSON.parse(lines.join('\n'))
  assert.deepEqual([error.ok, error.error], [false, 'notYours'])
  assert.match(error.message, /--force/)
})

test('`--` ends the flags; a time a day ahead or a year back is asked about', async () => {
  const { cfg } = await setUp()
  // after `--` every word is the description's, --json too
  const said = await run(cfg, [
    'add',
    '--project',
    'Support',
    '--minutes',
    '15',
    '--',
    'Case 10001 X:',
    '--force',
    'was',
    '--json',
  ])
  assert.match(said[0] ?? '', /^ok · /)
  const [made] = await jsonOf(cfg, ['list'])
  assert.equal(made.description, 'Case 10001 X: --force was --json')
  const far = [
    'add',
    '--project',
    'Support',
    '--start',
    '2062-01-01T09:00:00Z',
    '--minutes',
    '15',
    'Case 10001 X: work',
  ]
  assert.equal(await keyOf(run(cfg, far)), 'time.err.whenRange')
  assert.equal(await keyOf(run(cfg, ['move', made.id, '2026-11-05'])), 'time.err.whenRange')
})

test('add, as the session, its lane the client; a repeat finds the first; the day as billed in JSON', async () => {
  const { cfg } = await setUp()
  const args = [
    'add',
    '--project',
    'Support',
    '--start',
    '2026-10-28T09:00:00-04:00',
    '--minutes',
    '42',
    'Case 10001 X: work',
  ]
  const made = await jsonOf(cfg, args)
  assert.equal(made.existing, false)
  assert.equal(made.client, 'client-a')
  assert.equal(made.date, '2026-10-28')
  assert.equal(made.seconds, 42 * 60)
  assert.deepEqual(made.by, me)
  assert.equal((await jsonOf(cfg, args)).existing, true)
  await run(cfg, [
    'add',
    '--project',
    'Support',
    '--start',
    '2026-10-28T11:00:00-04:00',
    '--minutes',
    '7',
    'Admin 10001 X: reminder',
  ])
  const {
    days: [day],
    problems,
  } = await jsonOf(cfg, ['day', '2026-10-28'])
  assert.deepEqual(problems, [])
  assert.equal(day.client, 'client-a')
  assert.deepEqual(
    day.lines.map((l: { seconds: number; billedSeconds: number }) => [l.seconds / 60, l.billedSeconds / 60]),
    [
      [42, 60],
      [7, 7],
    ],
  )
  assert.equal(day.entries.length, 2)
  const human = await run(cfg, ['day', '2026-10-28'])
  assert.match(human[0] ?? '', /^client-a · 2026-10-28 \(America\/New_York\) · 0:49 → 1:07$/)
})

test('another session’s entry: refused without --force; moved and listed', async () => {
  const { cfg } = await setUp()
  const made = await jsonOf(cfg, [
    'add',
    '--project',
    'Support',
    '--start',
    '2026-10-28T09:00:00-04:00',
    '--hours',
    '1',
    'Case 10001 X: work',
  ])
  const other: Actor = { key: 's2', name: 'Two' }
  assert.equal(await keyOf(run(cfg, ['edit', made.id, '--minutes', '30'], other)), 'time.err.notYours')
  const trimmed = await jsonOf(cfg, ['edit', made.id, '--minutes', '30', '--force'], other)
  assert.equal(trimmed.seconds, 1800)
  const moved = await jsonOf(cfg, ['move', made.id, '2026-10-30', '--force'], other)
  assert.equal(moved.date, '2026-10-30')
  assert.equal(moved.start, '2026-10-30T13:00:00Z')
  const list = await jsonOf(cfg, ['list', '--from', '2026-10-28', '--to', '2026-10-31', '--client', 'client-a'])
  assert.deepEqual(
    list.map((e: { id: string }) => e.id),
    [made.id],
  )
})

test('a project not of the client is refused, unless on purpose, and then it is listed', async () => {
  const { cfg } = await setUp()
  const add = [
    'add',
    '--project',
    'Migration',
    '--start',
    '2026-10-28T09:00:00-04:00',
    '--minutes',
    '30',
    'Case 10001 X: work',
  ]
  assert.equal(await keyOf(run(cfg, add)), 'time.err.project')
})

test('import: a dry run prints the days and writes nothing; the run imports once; unmapped clients stop it', async () => {
  const { dir, cfg } = await setUp()
  const file = join(dir, 'toggl.csv')
  writeFileSync(
    file,
    [
      'User,Email,Client,Project,Task,Description,Billable,Start date,Start time,End date,End time,Duration,Tags',
      'Me,me@x,Client A,Support,,Case 10001 X: work,Yes,2026-10-28,16:00:00,2026-10-28,17:30:00,01:30:00,',
      'Me,me@x,,Internal,,Board,No,2026-10-28,18:00:00,2026-10-28,18:30:00,00:30:00,',
    ].join('\n'),
  )
  assert.equal(
    await keyOf(run(cfg, ['import', file, '--tz', 'Europe/Istanbul', '--map', 'Client A=client-a'])),
    'time.err.unmapped',
  )
  const map = ['--map', 'Client A=client-a', '--map', '=personal']
  const dry = await jsonOf(cfg, ['import', file, '--tz', 'Europe/Istanbul', ...map, '--dry-run'])
  assert.equal(dry.entries, 2)
  assert.deepEqual(await jsonOf(cfg, ['list', '--date', '2026-10-28']), [])
  const done = await jsonOf(cfg, ['import', file, '--tz', 'Europe/Istanbul', ...map])
  assert.equal(done.added, 2)
  const again = await jsonOf(cfg, ['import', file, '--tz', 'Europe/Istanbul', ...map])
  assert.deepEqual([again.added, again.already], [0, 2])
})

test('import: a dry run reads the database and says what is new, there and changed, by work date and by Toggl’s day; a refused run leaves config.json', async () => {
  const { dir, cfg } = await setUp()
  // config.json on disk as the cfg says, for the projects an import adds
  const file = join(dir, 'config', 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(cfg))
  const csv = join(dir, 'toggl.csv')
  const head = 'Client,Project,Description,Start date,Start time,End date,End time,Duration,Tags'
  // 06:00 in Istanbul is 23:00 the day before in New York: two days apart in the two totals
  const one = 'Client A,Support,Case 10001 X: work,2026-10-28,16:00:00,2026-10-28,17:30:00,01:30:00,'
  const two = 'Client A,Support,Case 10002 Y: early,2026-10-29,06:00:00,2026-10-29,06:30:00,00:30:00,'
  writeFileSync(csv, [head, one, two].join('\n'))
  const map = ['--tz', 'Europe/Istanbul', '--map', 'Client A=client-a']
  const dry = await jsonOf(cfg, ['import', csv, ...map, '--dry-run'])
  assert.deepEqual([dry.new, dry.already, dry.changed], [2, 0, []])
  assert.deepEqual(
    dry.days.map((d: { date: string }) => d.date),
    ['2026-10-28'],
  )
  assert.deepEqual(
    dry.togglDays.map((d: { date: string }) => d.date),
    ['2026-10-28', '2026-10-29'],
  )
  assert.equal((await jsonOf(cfg, ['import', csv, ...map])).added, 2)
  // edited in Toggl, exported again: the dry run and the run say changed, and add nothing
  writeFileSync(csv, [head, one.replace('X: work', 'X: worked'), two].join('\n'))
  const again = await jsonOf(cfg, ['import', csv, ...map, '--dry-run'])
  assert.deepEqual(
    [again.new, again.already, again.changed.length, again.changed[0].fields],
    [0, 1, 1, ['description']],
  )
  const run2 = await jsonOf(cfg, ['import', csv, ...map])
  assert.deepEqual([run2.added, run2.already, run2.changed.length], [0, 1, 1])
  assert.equal((await jsonOf(cfg, ['list', '--from', '2026-10-28', '--to', '2026-10-29'])).length, 2)
  // a project new to the lane, in a run the gate refuses: config.json as it was
  writeFileSync(csv, [head, one.replace('Support', 'Brand new')].join('\n'))
  const before = readFileSync(file, 'utf8')
  updateTarget('folder', st => ({ ...st, tested: null, lastOk: null }))
  assert.equal(await keyOf(run(cfg, ['import', csv, ...map])), 'time.err.notBackedUp')
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('--stop over an hour ahead with no --start is refused, not read as yesterday’s; with a start it may be', async () => {
  const { cfg } = await setUp()
  // NOW is 12:00 in New York; on this computer's clock HH:MM two hours ahead of it
  const ahead = new Date(NOW + 2 * 3_600_000)
  const hm = `${ahead.getHours()}:${String(ahead.getMinutes()).padStart(2, '0')}`
  assert.equal(
    await keyOf(run(cfg, ['add', '--project', 'Support', '--stop', hm, '--minutes', '60', 'Case 10001 X: work'])),
    'time.err.stopAhead',
  )
})

test('import: a file whose dates go the other way than --date-format says is refused', async () => {
  const { dir, cfg } = await setUp()
  const csv = join(dir, 'toggl.csv')
  writeFileSync(
    csv,
    'Client,Project,Description,Start date,Start time,End date,End time,Duration,Tags\nClient A,Support,Work,28/10/2026,09:00:00,28/10/2026,10:00:00,01:00:00,\n',
  )
  assert.equal(
    await keyOf(
      run(cfg, ['import', csv, '--tz', 'Europe/Istanbul', '--map', 'Client A=client-a', '--date-format', 'mdy']),
    ),
    'time.err.dateConflict',
  )
})

test('import: rows of one lane and start are each an entry, the dry run as the run; one edited later is named by its day, start and words', async () => {
  const { dir, cfg } = await setUp()
  const csv = join(dir, 'toggl.csv')
  const head = 'Client,Project,Description,Start date,Start time,End date,End time,Duration,Tags'
  const one = 'Client A,Support,Case 10001 X: work,2026-10-28,16:00:00,2026-10-28,17:30:00,01:30:00,'
  writeFileSync(csv, [head, one, one.replace('X: work', 'X: again')].join('\n'))
  const map = ['--tz', 'Europe/Istanbul', '--map', 'Client A=client-a']
  const dry = await jsonOf(cfg, ['import', csv, ...map, '--dry-run'])
  assert.deepEqual([dry.new, dry.already, dry.changed.length], [2, 0, 0])
  const done = await jsonOf(cfg, ['import', csv, ...map])
  assert.deepEqual([done.added, done.changed.length], [2, 0])
  const again = await jsonOf(cfg, ['import', csv, ...map])
  assert.deepEqual([again.added, again.already], [0, 2])
  // one of them edited in Toggl: said with its day and start in --tz and its words, not added
  writeFileSync(
    csv,
    [head, one.replace('X: work', 'X: work worded better'), one.replace('X: work', 'X: again')].join('\n'),
  )
  const said = await run(cfg, ['import', csv, ...map, '--dry-run'])
  assert.match(
    said.join('\n'),
    /differs from Toggl’s row, not imported again: 2026-10-28 16:00 "Case 10001 X: work worded better" · [0-9a-f]{8} \(description\)/,
  )
})

test('export: the entries of a range as CSV, quoted where a field needs it', async () => {
  const { cfg } = await setUp()
  await run(cfg, [
    'add',
    '--project',
    'Support',
    '--start',
    '2026-10-28T09:00:00-04:00',
    '--minutes',
    '90',
    'Case 10001 X: fixed it, "finally"',
  ])
  const csv = (await run(cfg, ['export', '--date', '2026-10-28'])).join('\n').split('\n')
  expect(csv[0]).toBe('id,date,client,project,description,tags,start,stop,hours,by')
  expect(csv[1]).toMatch(
    /^[0-9a-f]{8},2026-10-28,client-a,Support,"Case 10001 X: fixed it, ""finally""",,2026-10-28T13:00:00Z,2026-10-28T14:30:00Z,1\.5,Session one$/,
  )
})

test('export keeps a spreadsheet from running what an agent wrote; --bom for Excel; tags joined by a comma', async () => {
  const { cfg } = await setUp()
  for (const [i, description] of ['=HYPERLINK("http://x","click")', '+1+1', '-2+3', '@cmd'].entries())
    await run(cfg, [
      'add',
      '--project',
      'Support',
      '--start',
      `2026-10-28T0${i + 1}:00:00-04:00`,
      '--minutes',
      '15',
      '--tag',
      'deferred',
      '--tag',
      'a,b',
      '--',
      description,
    ])
  const csv = (await run(cfg, ['export', '--csv', '--date', '2026-10-28'])).join('\n').split('\n')
  const descriptions = csv.slice(1).map(l => l.split(',')[4])
  assert.deepEqual(descriptions, ['"\'=HYPERLINK(""http://x""', "'+1+1", "'-2+3", "'@cmd"])
  // tags hold no comma: joined by one, the column reads back
  assert.match(csv[1] ?? '', /,"deferred, a b",/)
  const bom = (await run(cfg, ['export', '--bom', '--date', '2026-10-28'])).join('\n')
  assert.ok(bom.startsWith('﻿id,date,'))
})

/** client-a entered into an ERP and a tracker, its Internal project not billed; personal never billed. */
const posting = (cfg: Config): Config =>
  ({
    ...cfg,
    time: {
      zone: 'America/New_York',
      clients: {
        'client-a': {
          projects: ['Support', 'Internal'],
          nonBillable: ['Internal'],
          systems: ['erp', { id: 'tracker', title: 'Tracker' }],
          billing: [{ group: 'ref', step: 30, round: 'up' }],
        },
        personal: { projects: ['Internal'], billable: false },
      },
    },
  }) as Config

const at = (hm: string) => `2026-10-28T${hm}:00-04:00`
const addAt = (start: string, project: string, description: string, ...more: string[]) => [
  'add',
  '--project',
  project,
  '--start',
  at(start),
  '--minutes',
  '30',
  ...more,
  description,
]

test('billable: as the config says, set on an entry either way and back; worked, never billed, when not', async () => {
  const cfg = posting((await setUp()).cfg)
  const work = await jsonOf(cfg, addAt('09:00', 'Support', 'Case 10001 X: work'))
  const internal = await jsonOf(cfg, addAt('10:00', 'Internal', 'Standup'))
  const slip = await jsonOf(cfg, addAt('11:00', 'Support', 'Case 10002 Y: our slip', '--non-billable'))
  assert.deepEqual(
    [work, internal, slip].map(e => [e.billable, e.billableDefault]),
    [
      [true, true],
      [false, true],
      [false, false],
    ],
  )
  const billed = await jsonOf(cfg, ['edit', internal.id, '--billable'])
  assert.deepEqual([billed.billable, billed.billableDefault, billed.rev], [true, false, 2])
  const back = await jsonOf(cfg, ['edit', internal.id, '--default-billable'])
  assert.deepEqual([back.billable, back.billableDefault, back.rev], [false, true, 3])
  assert.equal((await jsonOf(cfg, ['edit', work.id, '--billable', '--non-billable'])).error, 'billableFlags')
  const [day] = (await jsonOf(cfg, ['day', '2026-10-28'])).days
  assert.deepEqual(day.nonBillable, [internal.id, slip.id])
  // worked: all three; billed: the one case, up to the half hour
  assert.deepEqual([day.seconds / 60, day.billedSeconds / 60], [90, 30])
  assert.match((await run(cfg, ['show', slip.id]))[0] ?? '', /non-billable/)
  // a lane never billed
  const own = await jsonOf(cfg, [...addAt('12:00', 'Internal', 'Reading'), '--client', 'personal'])
  assert.deepEqual([own.billable, own.billableDefault], [false, true])
})

test('post and unpost: a mark per system, no change of the entry; what is to enter, and what changed after', async () => {
  const cfg = posting((await setUp()).cfg)
  const one = await jsonOf(cfg, addAt('09:00', 'Support', 'Case 10001 X: work'))
  const two = await jsonOf(cfg, addAt('10:00', 'Support', 'Case 10002 Y: work'))
  await jsonOf(cfg, addAt('11:00', 'Internal', 'Standup'))
  await jsonOf(cfg, addAt('12:00', 'Support', 'Case 10003 Z: later', '--tag', 'deferred'))
  const ids = (list: { id: string }[]) => list.map(e => e.id)
  const range = ['--from', '2026-10-28', '--to', '2026-10-28']
  // to enter: billable, not held, missing a mark (non-billable and held out)
  assert.deepEqual(ids(await jsonOf(cfg, ['list', '--not-posted', ...range])), [one.id, two.id])
  const posted = await jsonOf(cfg, ['post', one.id, '--system', 'erp', '--record', 'TR-1'])
  assert.deepEqual(Object.keys(posted), ['system', 'count', 'seconds', 'entries'])
  const [p] = posted.entries[0].posts
  assert.deepEqual(
    [p.system, p.record, p.rev, p.changedAfter, p.by, posted.entries[0].rev],
    ['erp', 'TR-1', 1, false, me, 1],
  )
  assert.deepEqual(Object.keys(p), ['system', 'at', 'by', 'record', 'rev', 'changedAfter'])
  assert.deepEqual(ids(await jsonOf(cfg, ['list', '--not-posted', '--system', 'erp', ...range])), [two.id])
  assert.deepEqual(ids(await jsonOf(cfg, ['list', '--not-posted', ...range])), [one.id, two.id], 'tracker still')
  // changed after: listed, said on the edit, cleared by marking again (the record kept)
  const said = await run(cfg, ['edit', one.id, '--description', 'Case 10001 X: more'])
  assert.match(said.at(-1) ?? '', /Entered in erp already: change it there too/)
  const changed = await jsonOf(cfg, ['list', '--changed-after-post', ...range])
  assert.deepEqual(
    changed.map((e: { id: string; posts: { changedAfter: boolean }[] }) => [e.id, e.posts[0]?.changedAfter]),
    [[one.id, true]],
  )
  assert.equal((await jsonOf(cfg, ['post', `${one.id}@1`, '--system', 'erp'])).error, 'changedSince')
  const again = await jsonOf(cfg, ['post', `${one.id}@2`, '--system', 'erp'])
  assert.deepEqual([again.entries[0].posts[0].rev, again.entries[0].posts[0].record], [2, 'TR-1'])
  assert.deepEqual(await jsonOf(cfg, ['list', '--changed-after-post', ...range]), [])
  // another session's entry: marked without --force (a mark changes no entry)
  const theirs = await jsonOf(cfg, ['post', two.id, '--system', 'erp'], { key: 's2', name: 'Two' })
  assert.deepEqual(theirs.entries[0].posts[0].by, { key: 's2', name: 'Two' })
  // refusals: a system the client has not, none named, an id that is not one
  assert.equal((await jsonOf(cfg, ['post', one.id, '--system', 'nope'])).error, 'system')
  assert.equal((await jsonOf(cfg, ['post', one.id])).error, 'noSystem')
  assert.equal((await jsonOf(cfg, ['post', 'x', '--system', 'erp'])).error, 'usage')
  const un = await jsonOf(cfg, ['unpost', one.id, two.id, '--system', 'erp'])
  assert.deepEqual([un.count, un.entries.map((e: { posts: unknown[] }) => e.posts)], [2, [[], []]])
})

test('the switch-over: everything entered before the board, posted at once; a dry run first', async () => {
  const cfg = posting((await setUp()).cfg)
  const one = await jsonOf(cfg, addAt('09:00', 'Support', 'Case 10001 X: work'))
  const two = await jsonOf(cfg, addAt('10:00', 'Support', 'Case 10002 Y: work'))
  await jsonOf(cfg, addAt('11:00', 'Internal', 'Standup'))
  await jsonOf(cfg, ['post', one.id, '--system', 'tracker', '--record', 'W-1'])
  const bulk = ['post', '--client', 'client-a', '--to', '2026-10-28', '--system', 'tracker']
  const dry = await jsonOf(cfg, [...bulk, '--dry-run'])
  assert.deepEqual(
    [dry.dryRun, dry.count, dry.seconds, dry.entries.map((e: { id: string }) => e.id)],
    [true, 1, 1800, [two.id]],
  )
  assert.match((await run(cfg, [...bulk, '--dry-run']))[0] ?? '', /1 entry, 0:30, would be marked entered in tracker/)
  assert.deepEqual(await jsonOf(cfg, ['list', '--changed-after-post', '--date', '2026-10-28']), [])
  const done = await jsonOf(cfg, bulk)
  assert.deepEqual([done.count, done.entries[0].id, done.entries[0].posts[0].system], [1, two.id, 'tracker'])
  assert.deepEqual(await jsonOf(cfg, ['list', '--not-posted', '--system', 'tracker', '--date', '2026-10-28']), [])
  // the earlier mark kept its record
  const shown = await jsonOf(cfg, ['show', one.id])
  assert.equal(shown.posts[0].record, 'W-1')
  assert.equal((await jsonOf(cfg, [...bulk.slice(0, 5), '--system', 'nope'])).error, 'system')
})

test('an entry entered, then removed, moved or brought back: said on the change, and listed as changed after (removed ones too)', async () => {
  const cfg = posting((await setUp()).cfg)
  const one = await jsonOf(cfg, addAt('09:00', 'Support', 'Case 10001 X: work'))
  await jsonOf(cfg, ['post', one.id, '--system', 'erp'])
  await jsonOf(cfg, ['post', one.id, '--system', 'tracker'])
  const range = ['--from', '2026-10-27', '--to', '2026-10-28']
  const moved = await run(cfg, ['move', one.id, '2026-10-27'])
  assert.match(moved.at(-1) ?? '', /Entered in erp, tracker already: change it there too/)
  const removed = await run(cfg, ['rm', one.id])
  assert.match(removed.at(-1) ?? '', /Entered in erp, tracker: take it out there too/)
  const listed = await jsonOf(cfg, ['list', '--changed-after-post', ...range])
  assert.deepEqual(
    listed.map((e: { id: string; deleted?: number }) => [e.id, typeof e.deleted]),
    [[one.id, 'number']],
  )
  assert.match((await run(cfg, ['list', '--changed-after-post', ...range]))[0] ?? '', /removed/)
  // the system named: only its stale marks
  await jsonOf(cfg, ['restore', one.id])
  const restored = await run(cfg, ['show', one.id])
  assert.match(restored[0] ?? '', /changed after: erp, tracker/)
  await jsonOf(cfg, ['post', one.id, '--system', 'tracker'])
  assert.match((await run(cfg, ['show', one.id]))[0] ?? '', /posted erp, tracker \(changed after: erp\)/)
  assert.deepEqual(await jsonOf(cfg, ['list', '--changed-after-post', '--system', 'tracker', ...range]), [])
  assert.equal((await jsonOf(cfg, ['list', '--changed-after-post', '--system', 'erp', ...range])).length, 1)
})

test('a post or unpost by id writes, so it takes no --dry-run and no range; the count is of the marks it changed', async () => {
  const cfg = posting((await setUp()).cfg)
  const one = await jsonOf(cfg, addAt('09:00', 'Support', 'Case 10001 X: work'))
  assert.equal((await jsonOf(cfg, ['post', one.id, '--system', 'erp', '--dry-run'])).error, 'dryRunById')
  assert.equal((await jsonOf(cfg, ['unpost', one.id, '--system', 'erp', '--dry-run'])).error, 'dryRunById')
  assert.equal(
    (await jsonOf(cfg, ['post', one.id, '--system', 'erp', '--client', 'client-a', '--to', '2026-10-28'])).error,
    'idsAndRange',
  )
  assert.deepEqual((await jsonOf(cfg, ['show', one.id])).posts, [], 'nothing written')
  // none to take off, or one already as it would be: no change, counted as none
  assert.equal((await jsonOf(cfg, ['unpost', one.id, '--system', 'erp'])).count, 0)
  assert.equal((await jsonOf(cfg, ['post', one.id, '--system', 'erp'])).count, 1)
  assert.equal((await jsonOf(cfg, ['post', one.id, '--system', 'erp'])).count, 0)
  assert.match((await run(cfg, ['post', one.id, '--system', 'erp'])).at(-1) ?? '', /ok · 0 entries marked/)
})

test('import: Toggl’s Billable left aside unless asked: an all-No export keeps the config’s, a re-import with --update changes nothing', async () => {
  const { dir, cfg: base } = await setUp()
  const cfg = posting(base)
  const csv = join(dir, 'toggl.csv')
  const head = 'Client,Project,Description,Billable,Start date,Start time,End date,End time,Duration,Tags'
  writeFileSync(
    csv,
    [
      head,
      'Client A,Support,Case 10001 X: work,No,2026-10-28,16:00:00,2026-10-28,17:30:00,01:30:00,',
      'Client A,Support,Case 10002 Y: work,No,2026-10-28,18:00:00,2026-10-28,18:30:00,00:30:00,',
    ].join('\n'),
  )
  const map = ['--tz', 'Europe/Istanbul', '--map', 'Client A=client-a']
  assert.equal((await jsonOf(cfg, ['import', csv, ...map])).added, 2)
  const day = async () =>
    (await jsonOf(cfg, ['list', '--date', '2026-10-28'])) as {
      billable: boolean
      billableDefault: boolean
      rev: number
    }[]
  assert.deepEqual(
    (await day()).map(e => [e.billable, e.billableDefault, e.rev]),
    [
      [true, true, 1],
      [true, true, 1],
    ],
  )
  const again = await jsonOf(cfg, ['import', csv, ...map, '--update'])
  assert.deepEqual([again.added, again.already, again.changed.length, again.updated.length], [0, 2, 0, 0])
  assert.deepEqual(
    (await day()).map(e => e.rev),
    [1, 1],
  )
  // asked: the dry run says how many turn non-billable, the run sets them
  const dry = await jsonOf(cfg, ['import', csv, ...map, '--billable-from-toggl', '--update', '--dry-run'])
  assert.deepEqual([dry.nonBillable, dry.changed.length], [2, 2])
  assert.match(
    (await run(cfg, ['import', csv, ...map, '--billable-from-toggl', '--update', '--dry-run'])).join('\n'),
    /2 rows would be non-billable, as Toggl’s Billable says/,
  )
  // without --update a row that differs is left as it is: none would be
  assert.equal((await jsonOf(cfg, ['import', csv, ...map, '--billable-from-toggl', '--dry-run'])).nonBillable, 0)
  await jsonOf(cfg, ['import', csv, ...map, '--billable-from-toggl', '--update'])
  assert.deepEqual(
    (await day()).map(e => [e.billable, e.billableDefault]),
    [
      [false, false],
      [false, false],
    ],
  )
})

test('an edit that changes nothing asks for no change in the systems; the removed ones listed are counted apart', async () => {
  const cfg = posting((await setUp()).cfg)
  const one = await jsonOf(cfg, addAt('09:00', 'Support', 'Case 10001 X: work'))
  await jsonOf(cfg, ['post', one.id, '--system', 'erp'])
  const same = await run(cfg, ['edit', one.id, '--description', 'Case 10001 X: work'])
  assert.equal(same.length, 1, 'no "change it there too" for a change of nothing')
  const real = await run(cfg, ['edit', one.id, '--description', 'Case 10001 X: more'])
  assert.match(real.at(-1) ?? '', /change it there too/)
  await run(cfg, ['rm', one.id])
  assert.match(
    (await run(cfg, ['list', '--changed-after-post', '--date', '2026-10-28'])).at(-1) ?? '',
    /0 entries, 0:00 · removed 1/,
  )
})

test('--new-project: a name the client has, case and spaces aside, is the one; a new one joins its list in config.json once', async () => {
  const { dir, cfg } = await setUp()
  const file = join(dir, 'config', 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(cfg))
  const projects = () =>
    (JSON.parse(readFileSync(file, 'utf8')) as { time: { clients: Record<string, { projects: string[] }> } }).time
      .clients['client-a']?.projects
  const at = ['--start', '2026-10-29T09:00:00-04:00', '--minutes', '30']
  const same = await jsonOf(cfg, ['add', '--project', 'support ', '--new-project', ...at, 'Case 10001 X: work'])
  assert.equal(same.project, 'Support')
  assert.deepEqual(projects(), ['Support'], 'no near duplicate')
  const fresh = await jsonOf(cfg, [
    'add',
    '--project',
    'Audit',
    '--new-project',
    '--start',
    '2026-10-29T10:00:00-04:00',
    '--minutes',
    '30',
    'Case 10002 Y: work',
  ])
  assert.equal(fresh.project, 'Audit')
  // the config the command read (cfg) did not have it: the file as it is now did, read under its lock
  const moved = await jsonOf(cfg, ['edit', fresh.id, '--project', 'audit', '--new-project'])
  assert.equal(moved.project, 'Audit')
  assert.deepEqual(projects(), ['Support', 'Audit'])
})

test('a client off and a retired project refuse an entry, --new-project too, saying where to turn them back', async () => {
  const { cfg } = await setUp()
  const time = cfg.time as { clients: Record<string, Record<string, unknown>> }
  time.clients['client-a'] = { ...time.clients['client-a'], retired: ['Old'] }
  time.clients.personal = { ...time.clients.personal, on: false }
  const at = ['--start', '2026-10-29T09:00:00-04:00', '--minutes', '30']
  assert.equal(
    await keyOf(run(cfg, ['add', '--project', 'old', '--new-project', ...at, 'Case 10001 X: work'])),
    'time.err.retired',
  )
  assert.equal(
    await keyOf(run(cfg, ['add', '--client', 'personal', '--project', 'Internal', ...at, 'Reading'])),
    'time.err.clientOff',
  )
  const off = await jsonOf(cfg, ['add', '--client', 'personal', '--project', 'Internal', ...at, 'Reading'])
  assert.deepEqual([off.ok, off.error], [false, 'clientOff'])
})

test('--new-project while config.json’s lock is held (a writer stopped a moment ago): refused in words, no entry written', async () => {
  const { dir, cfg } = await setUp()
  const file = join(dir, 'config', 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(cfg))
  mkdirSync(`${file}.lock`)
  const at = ['--start', '2026-10-29T09:00:00-04:00', '--minutes', '30']
  const r = await jsonOf(cfg, ['add', '--project', 'Audit', '--new-project', ...at, 'Case 10001 X: work'])
  assert.deepEqual([r.ok, r.error], [false, 'configBusy'])
  assert.deepEqual(await jsonOf(cfg, ['list', '--date', '2026-10-29']), [])
})

test('import: only the rows it wrote bring their projects to the list, so a project renamed on the board stays renamed; a list it cannot change is said', async () => {
  const { dir, cfg } = await setUp()
  const file = join(dir, 'config', 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(cfg))
  const projects = () =>
    (JSON.parse(readFileSync(file, 'utf8')) as { time: { clients: Record<string, { projects: string[] }> } }).time
      .clients['client-a']?.projects
  const csv = join(dir, 'toggl.csv')
  const head = 'Client,Project,Description,Start date,Start time,End date,End time,Duration,Tags'
  const row = (project: string, hour: string) =>
    `Client A,${project},Case 10001 X: work,2026-10-28,${hour}:00:00,2026-10-28,${hour}:30:00,00:30:00,`
  writeFileSync(csv, [head, row('Help', '10')].join('\n'))
  const map = ['--tz', 'Europe/Istanbul', '--map', 'Client A=client-a']
  await jsonOf(cfg, ['import', csv, ...map])
  assert.deepEqual(projects(), ['Support', 'Help'])
  // renamed on the board: the list and the entry
  const withDb: WithDb = (_create, fn) => {
    const db = openDb()
    try {
      return fn(db)
    } finally {
      db?.close()
    }
  }
  assert.equal(editTimeSettings({ op: 'rename', client: 'client-a', from: 'Help', to: 'Desk' }, withDb).ok, true)
  // the same file again: its row differs now (the project), it is no new row, nothing comes back
  const again = await jsonOf(cfg, ['import', csv, ...map])
  assert.deepEqual([again.added, again.changed.length], [0, 1])
  assert.deepEqual(projects(), ['Support', 'Desk'])
  // a new row while config.json's lock is held: the entry is in, the list not, and it says so
  writeFileSync(csv, [head, row('Calls', '12')].join('\n'))
  mkdirSync(`${file}.lock`)
  const busy = await jsonOf(cfg, ['import', csv, ...map])
  assert.equal(busy.added, 1)
  assert.match(busy.projectsNotAdded, /config\.json is being changed by another process/)
  assert.deepEqual(projects(), ['Support', 'Desk'])
}, 15_000)
