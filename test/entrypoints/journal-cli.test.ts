// `board journal` (#489): the list since the owner left, read from journal.db without the web
// board; off without config.json's `journal`, and it never makes the file.
import { beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { journalFile, journalStore, openJournalDb } from '../../src/adapters/journal-store.ts'
import { stateDir } from '../../src/adapters/paths.ts'
import { presenceFile } from '../../src/adapters/presence-store.ts'
import type { Move, StateRow } from '../../src/core/journal.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { journalCmd, sinceOf } from '../../src/entrypoints/journal-cli.ts'
import { isolatedHome } from '../support/env.ts'
import { root, sandbox } from '../support/sandbox.ts'

beforeAll(() => {
  useLanguage('en')
})

const NOW = new Date(2026, 10, 21, 8, 10).getTime()
const H = 3600_000
const move = (key: string, kind: Move['kind'], at: number, line = ''): Move => ({
  key,
  kind,
  at,
  line,
  name: key,
  lane: 'personal',
})
const st = (m: Move): [string, StateRow] => [m.key, { ...m, gone: null }]

function seed(moves: Move[], states: [string, StateRow][], marks: { left?: number; back?: number } = {}): void {
  const db = openJournalDb(true)
  if (!db) throw new Error('no journal.db')
  const s = journalStore(db)
  s.record(moves, new Map(states))
  s.setMarks(marks)
  db.close()
}
function run(args: string[], cfg: Record<string, unknown> = { journal: true }) {
  const out: string[] = []
  const err: string[] = []
  const code = journalCmd(args, { cfg, now: NOW, out: l => out.push(l), err: l => err.push(l) })
  return { code, out, err }
}

test('sinceOf: a time back, the last such time of day, a date and time', () => {
  expect(sinceOf('3h', NOW)).toBe(NOW - 3 * H)
  expect(sinceOf('90m', NOW)).toBe(NOW - 1.5 * H)
  expect(sinceOf('07:00', NOW)).toBe(new Date(2026, 10, 21, 7, 0).getTime())
  expect(sinceOf('23:56', NOW)).toBe(new Date(2026, 10, 20, 23, 56).getTime())
  expect(sinceOf('2026-11-20 18:00', NOW)).toBe(new Date(2026, 10, 20, 18, 0).getTime())
  expect(sinceOf('2026-12-01 18:00', NOW)).toBeNull()
  // a date and time later today, or tomorrow, is ahead: refused, not moved back a day
  expect(sinceOf('2026-11-21 09:00', NOW)).toBeNull()
  expect(sinceOf('2026-11-22 09:00', NOW)).toBeNull()
  expect(sinceOf('tomorrow 9:00', NOW)).toBeNull()
  // a bare time of day still means the last one
  expect(sinceOf('9:00', NOW)).toBe(new Date(2026, 10, 20, 9, 0).getTime())
  expect(sinceOf('at 9:00', NOW)).toBe(new Date(2026, 10, 20, 9, 0).getTime())
  // in any spelling of a time of day parseWhen takes
  expect(sinceOf('9pm', NOW)).toBe(new Date(2026, 10, 20, 21, 0).getTime())
  expect(sinceOf('9 pm', NOW)).toBe(new Date(2026, 10, 20, 21, 0).getTime())
  expect(sinceOf('3:30pm', NOW)).toBe(new Date(2026, 10, 20, 15, 30).getTime())
  expect(sinceOf('7am', NOW)).toBe(new Date(2026, 10, 21, 7, 0).getTime())
  expect(sinceOf('9am', NOW)).toBe(new Date(2026, 10, 20, 9, 0).getTime())
  // a day word makes it no bare time: ahead is refused
  expect(sinceOf('today 9pm', NOW)).toBeNull()
  expect(sinceOf('fri 9am', NOW)).toBeNull()
  expect(sinceOf('soon', NOW)).toBeNull()
  // ahead is no time back; a date alone is its midnight
  expect(sinceOf('in 2h', NOW)).toBeNull()
  expect(sinceOf('+2h', NOW)).toBeNull()
  expect(sinceOf('2026-11-20', NOW)).toBe(new Date(2026, 10, 20).getTime())
  expect(sinceOf('2026-11-22', NOW)).toBeNull()
})

test('off without the key, and no file is made', () => {
  isolatedHome()
  const r = run(['--since', '3h'], {})
  expect(r.code).toBe(1)
  expect(r.err).toEqual(['The journal is off (no "journal" in config.json)'])
  expect(run(['--json'], {}).out.map(l => JSON.parse(l).error)).toEqual(['off'])
  expect(existsSync(journalFile())).toBe(false)
})

test('on with no file yet: --since lists nothing, --away has no absence, still no file', () => {
  isolatedHome()
  expect(run(['--since', '3h']).out).toEqual([
    'Since 05:10:',
    'The journal has no record before 08:10: it was not recording then.',
    'Nothing on the board changed.',
  ])
  const away = run([])
  expect(away.code).toBe(1)
  expect(away.err[0]).toStartWith('No absence on record yet')
  expect(existsSync(journalFile())).toBe(false)
})

test('--since: the list in order, the old waits counted, the rest folded', () => {
  isolatedHome()
  const moves = [
    move('cleo', 'done', NOW - 5 * H, 'PR opened'),
    move('cleo', 'work', NOW - 4 * H),
    move('anna', 'owner', NOW - 2 * H, 'May I push to main?'),
    move('atlas', 'work', NOW - H),
    move('ben', 'error', NOW - H, 'API Error: 529 overloaded'),
  ]
  seed(moves, [
    st(moves[1] as Move),
    st(moves[2] as Move),
    st(moves[3] as Move),
    st(moves[4] as Move),
    ['dora', { ...move('dora', 'owner', NOW - 30 * H, 'which client?'), gone: null }],
  ])
  const r = run(['--since', '23:56'], { journal: true, categories: [{ id: 'personal', title: 'Personal' }] })
  expect(r.code).toBe(0)
  expect(r.out).toEqual([
    'Since 20.11 23:56:',
    'waits on you · anna (Personal) 06:10: May I push to main?',
    'and 1 more was waiting on you before',
    'stopped on an error · ben (Personal) 07:10: API Error: 529 overloaded',
    'finished · cleo (Personal) 03:10: PR opened',
    'and 1 more moved: 1 working, 0 idle',
  ])
  const json = JSON.parse(run(['--since', '23:56', '--json']).out.join('\n'))
  expect(json.ok).toBe(true)
  expect(json.rows.map((x: { key: string; kind: string }) => [x.key, x.kind])).toEqual([
    ['anna', 'owner'],
    ['ben', 'error'],
    ['cleo', 'done'],
  ])
  expect(json.rest).toEqual({ work: 1, idle: 0 })
  expect(json.before).toBe(1)
  expect(json.more).toBe(0)
})

test('--away: since presence went away, else since the page last went off show', () => {
  isolatedHome()
  const moves = [move('anna', 'done', NOW - 3 * H, 'old'), move('ben', 'done', NOW - H, 'new')]
  seed(moves, moves.map(st), { left: NOW - 2 * H, back: NOW - 10 * 60_000 })
  // without presence: the page's mark
  expect(run(['--away']).out).toEqual(['Since 06:10:', 'finished · ben (personal) 07:10: new'])
  // the default is --away
  expect(run([]).out).toEqual(['Since 06:10:', 'finished · ben (personal) 07:10: new'])
  // presence on and away now: since it went away
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(presenceFile(), JSON.stringify({ state: 'away', since: NOW - 4 * H, by: 'user' }))
  expect(run(['--away'], { journal: true, presence: true }).out[0]).toBe('Since 04:10:')
  expect(run(['--away'], { journal: true, presence: true }).out).toHaveLength(3)
})

test('wrong words: the usage', () => {
  isolatedHome()
  expect(run(['--since']).err).toEqual(['usage: board journal [--since <when> | --away] [--json]'])
  expect(run(['--since', '3h', '--away']).code).toBe(1)
  expect(run(['yesterday']).code).toBe(1)
  expect(run(['--since', 'soon']).err[0]).toStartWith('--since takes a time')
})

test('board journal through the board command', async () => {
  const box = await sandbox()
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  const cli = async (cfg: Record<string, unknown>) => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...cfg }))
    const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), 'journal', '--since', '1h'], {
      cwd: root,
      env: box.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code: await proc.exited, out: out + err }
  }
  const off = await cli({})
  expect(off.code).toBe(1)
  expect(off.out).toContain('The journal is off')
  const on = await cli({ journal: true })
  expect(on.code).toBe(0)
  expect(on.out).toContain('Nothing on the board changed.')
  expect(existsSync(join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/journal.db'))).toBe(false)
})
