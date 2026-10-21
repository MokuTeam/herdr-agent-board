// Wake's files in the board's state folder (src/adapters/wake-files.ts): the session file written
// atomically and set aside when it does not read as sessions, a log rotated past 2 MB.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  peekWakeSessions,
  readWakeSessions,
  readWakeStatus,
  saveWakeSessions,
  takeWakeStartLock,
  wakeLog,
  wakeLogFile,
  wakeLogTail,
  wakeSessionsFile,
  wakeStatusFile,
  writeWakeStatus,
} from '../../src/adapters/wake-files.ts'
import type { WakeSessions } from '../../src/core/wake/sessions.ts'

const SID = '0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'board-wake-files-'))
  made.push(dir)
  return dir
}
const brokenCopies = (dir: string): string[] =>
  readdirSync(dir).filter(f => /^wake-sessions\.json\.broken-\d+$/.test(f))

const SESSIONS: WakeSessions = {
  'w1:p1': {
    session: SID,
    name: 'Счета 100%',
    cwd: 'C:\\Work\\Проект x 50%',
    seen_at: 1_760_000_000_000,
    slept_at: 1_760_000_100_000,
    profileDir: 'C:\\Users\\Иван Петров\\.claude-work 100%',
    profile: 'work',
    future: { kept: true },
  },
}

test('the files are in the board’s state folder, found when asked', () => {
  const was = process.env.LOCALAPPDATA
  const dir = folder()
  try {
    process.env.LOCALAPPDATA = dir
    expect(wakeSessionsFile()).toBe(join(dir, 'herdr', 'plugins', 'agent-board', 'wake-sessions.json'))
    expect(wakeLogFile()).toBe(join(dir, 'herdr', 'plugins', 'agent-board', 'wake.log'))
  } finally {
    if (was === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = was
  }
})

test('the session file is written atomically and read back with unknown fields', () => {
  const dir = folder()
  const file = join(dir, 'state', 'wake-sessions.json')
  saveWakeSessions(SESSIONS, file)
  expect(readWakeSessions(file)).toEqual(SESSIONS)
  expect(peekWakeSessions(file)).toEqual(SESSIONS)
  // Saved again over the first: still whole, and nothing of the write left beside it.
  const again: WakeSessions = { ...SESSIONS, 'w2:p3': { session: SID, name: '', seen_at: 5 } }
  saveWakeSessions(again, file)
  expect(readWakeSessions(file)).toEqual(again)
  expect(readdirSync(join(dir, 'state'))).toEqual(['wake-sessions.json'])
  expect(readdirSync(join(dir, 'state')).filter(f => f.includes('.tmp'))).toEqual([])
})

test('no session file is no sessions, with nothing said and nothing written', () => {
  const dir = folder()
  const file = join(dir, 'wake-sessions.json')
  const said: string[] = []
  expect(readWakeSessions(file, text => said.push(text))).toEqual({})
  expect(peekWakeSessions(file)).toEqual({})
  expect(said).toEqual([])
  expect(readdirSync(dir)).toEqual([])
})

test('a file written by Windows PowerShell (a BOM first) reads as sessions', () => {
  const dir = folder()
  const file = join(dir, 'wake-sessions.json')
  writeFileSync(file, `\uFEFF${JSON.stringify(SESSIONS)}`)
  expect(readWakeSessions(file)).toEqual(SESSIONS)
  expect(peekWakeSessions(file)).toEqual(SESSIONS)
  expect(brokenCopies(dir)).toEqual([])
})

test('a broken session file is set aside, never overwritten, and said', () => {
  const dir = folder()
  const file = join(dir, 'wake-sessions.json')
  const said: string[] = []
  writeFileSync(file, '{"w1:p1":')
  expect(readWakeSessions(file, text => said.push(text))).toEqual({})
  expect(existsSync(file)).toBe(false)
  const [first] = brokenCopies(dir)
  expect(first).toBeDefined()
  expect(readFileSync(join(dir, first ?? ''), 'utf8')).toBe('{"w1:p1":')
  expect(said).toHaveLength(1)
  expect(said[0]).toContain(join(dir, first ?? ''))

  // The next save leaves the copy as it is.
  saveWakeSessions(SESSIONS, file)
  expect(readFileSync(join(dir, first ?? ''), 'utf8')).toBe('{"w1:p1":')
  expect(readWakeSessions(file)).toEqual(SESSIONS)

  // Broken again at once (within the same millisecond, perhaps): a copy of its own, the first kept.
  for (const text of ['[]', 'null']) {
    writeFileSync(file, text)
    expect(readWakeSessions(file, line => said.push(line))).toEqual({})
  }
  const copies = brokenCopies(dir)
  expect(copies).toHaveLength(3)
  expect(copies.map(f => readFileSync(join(dir, f), 'utf8')).sort()).toEqual(['[]', 'null', '{"w1:p1":'].sort())
  expect(said).toHaveLength(3)

  // Copies already named for the coming moments are not overwritten either.
  const later = folder()
  const laterFile = join(later, 'wake-sessions.json')
  const from = Date.now()
  for (let ms = from; ms < from + 300; ms++) writeFileSync(`${laterFile}.broken-${ms}`, 'older')
  writeFileSync(laterFile, '{')
  expect(readWakeSessions(laterFile)).toEqual({})
  const texts = brokenCopies(later).map(f => readFileSync(join(later, f), 'utf8'))
  expect(texts).toHaveLength(301)
  expect(texts.filter(t => t === 'older')).toHaveLength(300)
  expect(texts).toContain('{')
})

// Entries 2.1's narrowing drops: a seen_at written as text, a profile id without its folder.
const BAD_ENTRIES = {
  'w1:p2': { session: SID, name: 'x', seen_at: '2026-10-21T10:00:00Z', slept_at: 1 },
  'w2:p1': { session: SID, name: 'y', seen_at: 5, slept_at: 6, profile: 'work' },
}

test('entries that do not read as sessions are dropped, the file kept as it was beside it, and said', () => {
  const dir = folder()
  const file = join(dir, 'wake-sessions.json')
  const text = JSON.stringify({ ...SESSIONS, ...BAD_ENTRIES }, null, 1)
  writeFileSync(file, text)
  const said: string[] = []
  expect(readWakeSessions(file, line => said.push(line))).toEqual(SESSIONS)
  // The file stays where it is (wake goes on with the entries kept); a copy holds it as it was.
  expect(readFileSync(file, 'utf8')).toBe(text)
  const [copy] = brokenCopies(dir)
  expect(brokenCopies(dir)).toHaveLength(1)
  expect(readFileSync(join(dir, copy ?? ''), 'utf8')).toBe(text)
  expect(said).toHaveLength(1)
  expect(said[0]).toContain('w1:p2')
  expect(said[0]).toContain('w2:p1')
  expect(said[0]).not.toContain('w1:p1')
  expect(said[0]).toContain(join(dir, copy ?? ''))

  // The next save writes what was kept and leaves the copy; read again, nothing more is dropped.
  saveWakeSessions(SESSIONS, file)
  expect(readFileSync(join(dir, copy ?? ''), 'utf8')).toBe(text)
  expect(readWakeSessions(file, line => said.push(line))).toEqual(SESSIONS)
  expect(brokenCopies(dir)).toHaveLength(1)
  expect(said).toHaveLength(1)
})

test('a file whose entries all fail is none to wake, with a copy and a line; an empty one is none, quietly', () => {
  const dir = folder()
  const file = join(dir, 'wake-sessions.json')
  const text = JSON.stringify(BAD_ENTRIES)
  writeFileSync(file, text)
  const said: string[] = []
  expect(readWakeSessions(file, line => said.push(line))).toEqual({})
  const copies = brokenCopies(dir)
  expect(copies).toHaveLength(1)
  expect(readFileSync(join(dir, copies[0] ?? ''), 'utf8')).toBe(text)
  expect(said).toHaveLength(1)
  expect(said[0]).toContain('w1:p2')
  expect(said[0]).toContain('w2:p1')

  // The save that follows ({} over the file) leaves the copy whole.
  saveWakeSessions({}, file)
  expect(readFileSync(join(dir, copies[0] ?? ''), 'utf8')).toBe(text)

  // {} drops nothing: no copy, nothing said.
  const empty = folder()
  const emptyFile = join(empty, 'wake-sessions.json')
  writeFileSync(emptyFile, '{}')
  const quiet: string[] = []
  expect(readWakeSessions(emptyFile, line => quiet.push(line))).toEqual({})
  expect(readdirSync(empty)).toEqual(['wake-sessions.json'])
  expect(quiet).toEqual([])
})

test('the board peeks at the session file: a broken one is none to it, and is left where it is', () => {
  const dir = folder()
  const file = join(dir, 'wake-sessions.json')
  for (const text of ['{"w1:p1":', '[]', '"sessions"', '']) {
    writeFileSync(file, text)
    expect(peekWakeSessions(file)).toEqual({})
    expect(readdirSync(dir)).toEqual(['wake-sessions.json'])
    expect(readFileSync(file, 'utf8')).toBe(text)
  }
  // Entries it cannot read are left out for the board, with no copy made.
  const mixed = JSON.stringify({ ...SESSIONS, ...BAD_ENTRIES })
  writeFileSync(file, mixed)
  expect(peekWakeSessions(file)).toEqual(SESSIONS)
  expect(readdirSync(dir)).toEqual(['wake-sessions.json'])
  expect(readFileSync(file, 'utf8')).toBe(mixed)
  // A folder in the file's place is none too.
  rmSync(file)
  const nested = join(dir, 'nested')
  writeFileSync(nested, '')
  expect(peekWakeSessions(join(nested, 'wake-sessions.json'))).toEqual({})
})

test('a session file that cannot be read at all is not taken for none (it would be overwritten)', () => {
  const dir = folder()
  // A folder where the file should be: reading it fails, and nothing is renamed or said.
  const file = join(dir, 'wake-sessions.json')
  mkdirSync(file)
  const said: string[] = []
  expect(() => readWakeSessions(file, text => said.push(text))).toThrow()
  expect(said).toEqual([])
  expect(readdirSync(dir)).toEqual(['wake-sessions.json'])
})

test('the log rotates past 2 MB', () => {
  const dir = folder()
  const log = join(dir, 'wake.log')
  writeFileSync(log, 'x'.repeat(2_000_000))
  wakeLog('not yet', log)
  expect(existsSync(`${log}.1`)).toBe(false)

  writeFileSync(log, 'x'.repeat(2_000_001))
  wakeLog('woke Счета 100% in w1:p1', log)
  expect(readFileSync(`${log}.1`, 'utf8')).toBe('x'.repeat(2_000_001))
  expect(readFileSync(log, 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z woke Счета 100% in w1:p1\n$/)

  // Past 2 MB again: the older wake.log.1 gives way.
  writeFileSync(log, 'y'.repeat(2_000_001))
  wakeLog('again', log)
  expect(readFileSync(`${log}.1`, 'utf8')).toBe('y'.repeat(2_000_001))
})

test('a log line is one line, in a folder made for it', () => {
  const dir = folder()
  const log = join(dir, 'state', 'wake.log')
  wakeLog('first\nsecond\r\nthird', log)
  const lines = readFileSync(log, 'utf8').split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatch(/Z first second third$/)
  expect(lines[1]).toBe('')
})

test('the log never throws', () => {
  const dir = folder()
  const file = join(dir, 'a-file')
  writeFileSync(file, '')
  expect(() => wakeLog('text', join(file, 'wake.log'))).not.toThrow()
  expect(wakeLogTail(10, join(file, 'wake.log'))).toBe('')
})

test('the log’s tail: its last lines, none from a log there is not', () => {
  const dir = folder()
  const log = join(dir, 'wake.log')
  expect(wakeLogTail(5, log)).toBe('')
  for (let i = 1; i <= 4; i++) wakeLog(`line ${i}`, log)
  const tail = wakeLogTail(2, log).split('\n')
  expect(tail).toHaveLength(2)
  expect(tail[0]).toMatch(/Z line 3$/)
  expect(tail[1]).toMatch(/Z line 4$/)
  expect(wakeLogTail(10, log).split('\n')).toHaveLength(4)
  expect(wakeLogTail(0, log)).toBe('')

  // A long log: only its end is read, and the lines are whole.
  writeFileSync(log, `${'z'.repeat(3_000_000)}\n${'Счёт 100% '.repeat(20)}\nlast\n`)
  expect(wakeLogTail(2, log)).toBe(`${'Счёт 100% '.repeat(20)}\nlast`)
  // A line longer than one read back: whole all the same.
  writeFileSync(log, `first\n${'x'.repeat(70_000)}\nend\n`)
  expect(wakeLogTail(2, log)).toBe(`${'x'.repeat(70_000)}\nend`)
  expect(wakeLogTail(3, log)).toBe(`first\n${'x'.repeat(70_000)}\nend`)
})

test('the status file: none or one that does not read is null; written atomically with the fields this code does not know kept', () => {
  const dir = folder()
  const file = join(dir, 'state', 'wake-status.json')
  expect(readWakeStatus(file)).toBeNull()
  mkdirSync(join(dir, 'state'))
  writeFileSync(file, '{ "state": "runn')
  expect(readWakeStatus(file)).toBeNull()
  writeFileSync(file, '\uFEFF{ "state": "crashed", "at": 5, "error": "boom", "newer": { "x": 1 } }')
  expect(readWakeStatus(file)).toEqual({ state: 'crashed', at: 5, error: 'boom' })

  writeWakeStatus({ state: 'running', at: 6, pane: 'w9:p1', pid: 77, port: 40000 }, file)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    newer: { x: 1 },
    state: 'running',
    at: 6,
    pane: 'w9:p1',
    pid: 77,
    port: 40000,
  })
  expect(readWakeStatus(file)).toEqual({ state: 'running', at: 6, pane: 'w9:p1', pid: 77, port: 40000 })
  // A known field the new status leaves out is gone.
  writeWakeStatus({ state: 'stopped', at: 7 }, file)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ newer: { x: 1 }, state: 'stopped', at: 7 })
  expect(readdirSync(join(dir, 'state'))).toEqual(['wake-status.json'])
  expect(wakeStatusFile()).toMatch(/[\\/]wake-status\.json$/)
})

test('wake’s start lock: one holder at a time; taken over when its process is gone or past the deadline; given back once, only while it is its own', () => {
  const dir = join(folder(), 'state')
  const file = join(dir, 'wake-start.lock')
  const NOW = 1_800_000_000_000
  const alive = (pid: number): boolean => pid !== 404
  const take = (pid: number, now = NOW) => takeWakeStartLock({ pid, now, maxAgeMs: 20_000, alive }, file)

  const first = take(11)
  expect(first).toBeFunction()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: 11, at: NOW })
  // Another start while it is held: refused, the lock as it was.
  expect(take(12, NOW + 19_000)).toBeNull()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: 11, at: NOW })
  first?.()
  expect(existsSync(file)).toBe(false)
  first?.()

  // Its process gone: taken over.
  writeFileSync(file, JSON.stringify({ pid: 404, at: NOW }))
  const afterDead = take(13)
  expect(afterDead).toBeFunction()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: 13, at: NOW })
  // Older than the deadline (its process alive, or a pid given out again): taken over.
  const afterOld = take(14, NOW + 20_000)
  expect(afterOld).toBeFunction()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: 14, at: NOW + 20_000 })
  // The one taken over gives back nothing of the new holder's.
  afterDead?.()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: 14, at: NOW + 20_000 })
  afterOld?.()
  expect(readdirSync(dir)).toEqual([])

  // A lock that does not read as one (being written): held while its file is fresh.
  writeFileSync(file, '')
  expect(take(15, Date.now())).toBeNull()
  expect(take(15, Date.now() + 21_000)).toBeFunction()
  expect(readdirSync(dir)).toEqual(['wake-start.lock'])
})
