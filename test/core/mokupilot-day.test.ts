// MokuPilot's day folder as the board reads and writes it (#331): the running day's state.json, and
// a message in its inbox in `meet day --report`'s format (MokuPilot day_inbox.py).
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayGate, dayPredecessors, reportToDay, runningDay } from '../../src/adapters/mokupilot-day.ts'
import { dayName, endedAgentDay, parseDayState, reportName, rotatedFrom } from '../../src/core/mokupilot-day.ts'

const SID = '3dbb2396-0539-4168-a668-213f1041ed3f'

test('parseDayState: a running Claude day, its session and pane; anything else is none', () => {
  const day = { provider: 'claude', fork_session: SID, ended_at: null }
  expect(parseDayState(day)).toEqual({ session: SID, pane: '' })
  expect(parseDayState({ ...day, herdr_pane: ' wP:p9N ' })).toEqual({ session: SID, pane: 'wP:p9N' })
  expect(parseDayState({ ...day, ended_at: undefined })).toEqual({ session: SID, pane: '' })
  // A pane id that is no herdr id is left out, the day still shows.
  expect(parseDayState({ ...day, herdr_pane: 'a b' })).toEqual({ session: SID, pane: '' })
  expect(parseDayState({ ...day, herdr_pane: 5 })).toEqual({ session: SID, pane: '' })
  for (const not of [
    null,
    [],
    'x',
    { ...day, ended_at: 1793870263.9 },
    { ...day, provider: 'pi' },
    { ...day, provider: undefined },
    { ...day, fork_session: '' },
    { ...day, fork_session: null },
    { ...day, fork_session: '../x' },
  ])
    expect(parseDayState(not)).toBeNull()
})

test('dayName is the local date; reportName sorts in the order written', () => {
  expect(dayName(new Date(2026, 10, 5, 0, 30))).toBe('2026-11-05')
  expect(dayName(new Date(2026, 0, 9, 23, 59))).toBe('2026-01-09')
  expect(reportName(1793870264661000, 'ab12cd34')).toBe('1793870264661000-ab12cd34.json')
  expect(reportName(42, '00000000')).toBe('0000000000000042-00000000.json')
})

test('reportToDay: one whole file per message, in order, in the format MokuPilot reads', () => {
  const folder = mkdtempSync(join(tmpdir(), 'день 100% '))
  const at = 1793870264661
  reportToDay(folder, 'agent board', '[board reminder] first', at)
  reportToDay(folder, 'agent board', 'second\nline', at) // the same millisecond: still after the first
  const names = readdirSync(join(folder, 'inbox'))
  expect(names.every(n => /^\d{16}-[0-9a-f]{8}\.json$/.test(n))).toBe(true)
  const read = names.sort().map(n => JSON.parse(readFileSync(join(folder, 'inbox', n), 'utf8')))
  expect(read).toEqual([
    { from: 'agent board', text: '[board reminder] first', at: at / 1000 },
    { from: 'agent board', text: 'second\nline', at: at / 1000 },
  ])
})

test('runningDay reads today’s folder only; the gate reads nothing where MokuPilot is off or never ran', () => {
  const root = mkdtempSync(join(tmpdir(), 'days '))
  const today = new Date()
  expect(runningDay({ root, now: today })).toBeNull()
  const folder = join(root, dayName(today))
  reportToDay(folder, 'x', 'y') // makes the folder
  writeFileSync(join(folder, 'state.json'), JSON.stringify({ provider: 'claude', fork_session: SID, ended_at: null }))
  expect(runningDay({ root, now: today })).toEqual({ session: SID, pane: '', folder })
  expect(runningDay({ root, now: new Date(today.getTime() + 86_400_000) })).toBeNull()

  let reads = 0
  const read = () => {
    reads++
    return { session: SID, pane: '' }
  }
  expect(dayGate({ here: () => true, read })({ mokupilot: false })).toBeNull()
  expect(dayGate({ here: () => false, read })({})).toBeNull()
  expect(reads).toBe(0)
  expect(dayGate({ here: () => true, read })({})).toEqual({ session: SID, pane: '' })
})

test('rotatedFrom and endedAgentDay: the conversations a day had, ids only, each once', () => {
  const day = { provider: 'claude', fork_session: SID, ended_at: null }
  expect(rotatedFrom({ ...day, rotated_from: ['a1', '../x', 5, 'a2', 'a1', SID] })).toEqual(['a1', 'a2'])
  expect(rotatedFrom(day)).toEqual([])
  expect(rotatedFrom({ ...day, ended_at: 1, rotated_from: ['a1'] })).toEqual([])
  expect(rotatedFrom({ ...day, provider: 'pi', rotated_from: ['a1'] })).toEqual([])
  // A terminal day's session is the owner's own: nothing before it is the day's.
  expect(rotatedFrom({ ...day, mode: 'terminal', rotated_from: ['a1'] })).toEqual([])
  expect(rotatedFrom({ ...day, mode: 'agent', rotated_from: ['a1'] })).toEqual(['a1'])
  const ended = { provider: 'claude', mode: 'agent', fork_session: SID, ended_at: 1795104031.0, rotated_from: ['a1'] }
  expect(endedAgentDay(ended)).toEqual(['a1', SID])
  // Still running, the owner's own terminal session, or not Claude's: nothing to follow on from.
  for (const not of [{ ...ended, ended_at: null }, { ...ended, mode: 'terminal' }, { ...ended, provider: 'pi' }, null])
    expect(endedAgentDay(not)).toEqual([])
})

test("dayPredecessors: the latest earlier agent day's conversations, then today's rotated ones", () => {
  const root = mkdtempSync(join(tmpdir(), 'дни 100% '))
  const now = new Date(2026, 10, 20, 9, 0)
  const put = (name: string, state: unknown) => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'state.json'), JSON.stringify(state))
  }
  const ended = { provider: 'claude', mode: 'agent', ended_at: 1795104031.0 }
  put('2026-11-17', { ...ended, fork_session: 'old' })
  put('2026-11-19', { ...ended, fork_session: 'y2', rotated_from: ['y1'] })
  put('2026-11-21', { ...ended, fork_session: 'tomorrow' })
  mkdirSync(join(root, 'notes'))
  expect(dayPredecessors('t3', { root, now })).toBeNull() // no day today
  put('2026-11-20', { provider: 'claude', fork_session: 't3', ended_at: null, rotated_from: ['t1', 't2'] })
  expect(dayPredecessors('t3', { root, now })).toEqual(['y1', 'y2', 't1', 't2'])
  // Not today's running conversation (yet): look again later.
  expect(dayPredecessors('t2', { root, now })).toBeNull()
  // The day before was the owner's terminal day: today's own only.
  put('2026-11-19', { ...ended, mode: 'terminal', fork_session: 'own' })
  expect(dayPredecessors('t3', { root, now })).toEqual(['t1', 't2'])
  expect(dayPredecessors('t3', { root: join(root, 'missing'), now })).toBeNull()
})
