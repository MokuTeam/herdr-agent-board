// `board time …` (#233, entrypoints/time-cli.ts) as an agent runs it: JSON out, refusals that say
// what to do, writes only once the database is backed up somewhere.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeKey } from '../../src/adapters/backup-store.ts'
import { TimeError } from '../../src/adapters/time-store.ts'
import { makeKey } from '../../src/core/backup-file.ts'
import type { Actor } from '../../src/core/time.ts'
import type { Config } from '../../src/core/types.ts'
import { parseArgs, timeCmd } from '../../src/entrypoints/time-cli.ts'
import { isolatedHome } from '../support/env.ts'

const me: Actor = { key: 's1', name: 'Session one' }

async function setUp(backedUp = true) {
  const dir = isolatedHome()
  const folder = join(dir, 'Sync')
  mkdirSync(folder)
  if (backedUp) await writeKey(makeKey('correct horse battery', 1, { logN: 10, r: 8, p: 1 }))
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
  await timeCmd(args, { cfg, actor, lane, out: line => lines.push(line) })
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

test('nothing is written before the database is backed up off the computer', async () => {
  const { cfg } = await setUp(false)
  assert.equal(
    await keyOf(run(cfg, ['add', '--project', 'Support', '--minutes', '30', 'Case 10001 X: work'])),
    'time.err.noBackup',
  )
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
  const [day] = await jsonOf(cfg, ['day', '2026-10-28'])
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
