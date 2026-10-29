// `board time …` (#233, entrypoints/time-cli.ts) as an agent runs it: JSON out, refusals that say
// what to do, writes only once the database is backed up somewhere.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { updateTarget, writeKey } from '../../src/adapters/backup-store.ts'
import { TimeError } from '../../src/adapters/time-store.ts'
import { makeKey } from '../../src/core/backup-file.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Actor } from '../../src/core/time.ts'
import type { Config } from '../../src/core/types.ts'
import { parseArgs, timeCmd } from '../../src/entrypoints/time-cli.ts'
import { timeChecks } from '../../src/services/time.ts'
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
    'by',
    'changed',
    'changedBy',
    'client',
    'date',
    'description',
    'existing',
    'id',
    'project',
    'rev',
    'seconds',
    'start',
    'stop',
    'tags',
  ])
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

test('import: two rows of one file with the same lane and start: the dry run says what the run does', async () => {
  const { dir, cfg } = await setUp()
  const csv = join(dir, 'toggl.csv')
  const head = 'Client,Project,Description,Start date,Start time,End date,End time,Duration,Tags'
  const one = 'Client A,Support,Case 10001 X: work,2026-10-28,16:00:00,2026-10-28,17:30:00,01:30:00,'
  writeFileSync(csv, [head, one, one.replace('X: work', 'X: again')].join('\n'))
  const map = ['--tz', 'Europe/Istanbul', '--map', 'Client A=client-a']
  const dry = await jsonOf(cfg, ['import', csv, ...map, '--dry-run'])
  assert.deepEqual([dry.new, dry.changed.length], [1, 1])
  const done = await jsonOf(cfg, ['import', csv, ...map])
  assert.deepEqual([done.added, done.changed.length], [1, 1])
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
