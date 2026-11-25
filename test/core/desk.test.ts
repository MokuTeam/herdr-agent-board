// The owner's desk (#788, core/desk.ts): the readings of the machines the owner works at, combined
// into the one observation presence detection reads (the most recently active desk wins; every desk
// idle or locked is away; none that tells anything is no word), and what a master may post to a
// node's door as a notification.
import { expect, test } from 'bun:test'
import { activeDesk, combineDesks, type DeskReading, deskReadingOf, deskToastOf } from '../../src/core/desk.ts'
import { seenOf } from '../../src/core/presence.ts'

const AT = 1_700_000_000_000
const r = (device: string, idleSec: number | null, locked: boolean | null, at = AT): DeskReading => ({
  device,
  idleSec,
  locked,
  at,
})

test('the most recently active desk wins: the shortest idle time of the unlocked ones', () => {
  const readings = [r('server-1', 600, false), r('server-2', 5, false), r('', 120, null)]
  expect(activeDesk(readings)?.device).toBe('server-2')
  expect(combineDesks(readings)).toEqual({ idleSec: 5, locked: false })
  expect(seenOf(combineDesks(readings), 15)).toBe('back')
})

test('a desk heard later counts its idle time from when it said it', () => {
  // server-1 said 30 s idle a minute ago (last input 90 s ago); server-2 said 60 s idle now.
  const readings = [r('server-1', 30, false, AT - 60_000), r('server-2', 60, false, AT)]
  expect(activeDesk(readings)?.device).toBe('server-2')
})

test('a locked desk ranks below any unlocked one, however idle', () => {
  const readings = [r('server-1', 0, true), r('server-2', 3000, false)]
  expect(activeDesk(readings)?.device).toBe('server-2')
  // ... and that one is idle past the limit: away.
  expect(seenOf(combineDesks(readings), 15)).toBe('away')
})

test('a desk that says only "not locked" stands for the owner only where no desk tells an idle time', () => {
  // A Hyprland laptop left unlocked beside a Windows desk idle for 3 hours: away, not "back" for ever.
  const readings = [r('server-1', null, false), r('server-2', 3 * 3600, false)]
  expect(activeDesk(readings)?.device).toBe('server-2')
  expect(seenOf(combineDesks(readings), 15)).toBe('away')
  // ... and the owner busy at the Windows desk: it wins, whenever the other one answered.
  expect(activeDesk([r('server-1', null, false, AT + 5000), r('server-2', 2, false)])?.device).toBe('server-2')
  // With no idle time anywhere, it beats a locked one.
  expect(activeDesk([r('server-1', null, false), r('server-2', null, true)])?.device).toBe('server-1')
})

test('every desk idle past the limit or locked: away', () => {
  expect(seenOf(combineDesks([r('server-1', 2000, false), r('server-2', null, true)]), 15)).toBe('away')
  expect(seenOf(combineDesks([r('server-1', null, true), r('', 5, true)]), 15)).toBe('away')
})

test('no desk that tells anything: no word at all, presence stays as it is', () => {
  expect(combineDesks([])).toEqual({ idleSec: null, locked: null })
  expect(combineDesks([r('server-1', null, null)])).toEqual({ idleSec: null, locked: null })
  expect(seenOf(combineDesks([]), 15)).toBeNull()
})

test('a tie goes to this computer, then to the first device by id', () => {
  expect(activeDesk([r('server-2', 10, false), r('', 10, false)])?.device).toBe('')
  expect(activeDesk([r('server-2', 10, false), r('server-1', 10, false)])?.device).toBe('server-1')
})

test("a node's answer: only a desktop that tells something is a reading", () => {
  expect(deskReadingOf({ ok: true, desktop: true, idleSec: 12, locked: false }, 'server-1', AT)).toEqual(
    r('server-1', 12, false),
  )
  expect(deskReadingOf({ ok: true, desktop: true, idleSec: null, locked: true }, 'server-1', AT)).toEqual(
    r('server-1', null, true),
  )
  expect(deskReadingOf({ ok: true, desktop: false }, 'server-1', AT)).toBeNull()
  expect(deskReadingOf({ ok: true, desktop: true, idleSec: null, locked: null }, 'server-1', AT)).toBeNull()
  expect(deskReadingOf({ ok: true, desktop: true, idleSec: -1, locked: 'no' }, 'server-1', AT)).toBeNull()
  expect(deskReadingOf('nope', 'server-1', AT)).toBeNull()
})

const REMINDER = {
  id: 'AbCdEfGhIjKlMnOp',
  title: 'Design review ☃ 100%',
  body: 'in 5 min · 14:30 - 15:00',
  whose: 'Board',
  join: 'https://meet.example.com/xyz',
  expires: AT,
  labels: { join: 'Join', open: 'Open', snooze: 'Snooze 5 min', start: 'At start' },
}

test('a reminder, its clear and a Team message pass; each field is held to its kind', () => {
  expect(deskToastOf({ kind: 'reminder', toast: REMINDER })).toEqual({ kind: 'reminder', toast: REMINDER })
  const { join: _j, ...noJoin } = REMINDER
  expect(deskToastOf({ kind: 'reminder', toast: noJoin })).toEqual({ kind: 'reminder', toast: noJoin })
  expect(deskToastOf({ kind: 'reminder-clear', id: REMINDER.id })).toEqual({ kind: 'reminder-clear', id: REMINDER.id })
  const team = { id: 'm-1', thread: 'team/general', title: 'anna', body: 'hello', label: 'Team chat' }
  expect(deskToastOf({ kind: 'team', toast: team })).toEqual({ kind: 'team', toast: team })

  expect(deskToastOf({ kind: 'reminder', toast: { ...REMINDER, join: 'file:///etc/passwd' } })).toBeNull()
  expect(deskToastOf({ kind: 'reminder', toast: { ...REMINDER, id: '../x' } })).toBeNull()
  expect(deskToastOf({ kind: 'reminder', toast: { ...REMINDER, title: 'x'.repeat(5000) } })).toBeNull()
  expect(deskToastOf({ kind: 'reminder-clear', id: '-rf' })).toBeNull()
  expect(deskToastOf({ kind: 'team', toast: { ...team, thread: 'not a key' } })).toBeNull()
  expect(deskToastOf({ kind: 'exec', toast: REMINDER })).toBeNull()
  expect(deskToastOf(null)).toBeNull()
})
