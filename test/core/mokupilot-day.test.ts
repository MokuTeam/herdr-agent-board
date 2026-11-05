// MokuPilot's day folder as the board reads and writes it (#331): the running day's state.json, and
// a message in its inbox in `meet day --report`'s format (MokuPilot day_inbox.py).
import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayGate, reportToDay, runningDay } from '../../src/adapters/mokupilot-day.ts'
import { dayName, parseDayState, reportName } from '../../src/core/mokupilot-day.ts'

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
