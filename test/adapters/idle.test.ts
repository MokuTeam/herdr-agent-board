// How presence detection reads the computer (#172): each system's answer parsed, and which tools
// observe() asks where, against a fake exec (nothing of the computer running the tests is read).
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  combine,
  type Exec,
  observe,
  parseIoreg,
  parseLoginctl,
  parseMutter,
  parseScreensaver,
  parseWindows,
  parseXprintidle,
} from '../../src/adapters/idle.ts'
import type { RunResult } from '../../src/adapters/process.ts'

const done = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: '' }) as RunResult

/** An exec answering by the program's name; one not listed is not there (code 127). */
function fakeExec(answers: Record<string, RunResult>): Exec & { calls: string[] } {
  const calls: string[] = []
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args].join(' '))
    return answers[file] ?? done('', 127)
  }
  return Object.assign(exec, { calls })
}

test('parsers', () => {
  assert.deepEqual(parseWindows('125000 0\r\n'), { idleSec: 125, locked: false })
  assert.deepEqual(parseWindows('3 1'), { idleSec: 0.003, locked: true })
  assert.deepEqual(parseWindows('Add-Type: error'), { idleSec: null, locked: null })
  assert.equal(parseIoreg('  |   "HIDIdleTime" = 61000000000\n'), 61)
  assert.equal(parseIoreg('nothing'), null)
  assert.equal(parseXprintidle('4500\n'), 4.5)
  assert.equal(parseXprintidle('Error: no display'), null)
  assert.equal(parseMutter('(uint64 90000,)\n'), 90)
  assert.equal(parseMutter('Error'), null)
  assert.equal(parseScreensaver('(true,)'), true)
  assert.equal(parseScreensaver('(false,)'), false)
  assert.equal(parseScreensaver(''), null)
})

test('loginctl: an idle time only from IdleHint=yes, the lock either way', () => {
  const now = 1_000_000_000_000
  const since = (now - 600_000) * 1000
  assert.deepEqual(parseLoginctl(`IdleHint=yes\nIdleSinceHint=${since}\nLockedHint=no\n`, now), {
    idleSec: 600,
    locked: false,
  })
  assert.deepEqual(parseLoginctl(`IdleHint=no\nIdleSinceHint=0\nLockedHint=yes\n`, now), {
    idleSec: null,
    locked: true,
  })
  assert.deepEqual(parseLoginctl('', now), { idleSec: null, locked: null })
})

test('combine: the first idle time; locked when any says so', () => {
  assert.deepEqual(
    combine([
      { idleSec: null, locked: false },
      { idleSec: 5, locked: null },
      { idleSec: 9, locked: true },
    ]),
    { idleSec: 5, locked: true },
  )
  assert.deepEqual(combine([]), { idleSec: null, locked: null })
})

test('Windows asks PowerShell; macOS ioreg; a failure is no answer', async () => {
  const win = fakeExec({ 'powershell.exe': done('60000 1') })
  assert.deepEqual(await observe('win32', {}, win), { idleSec: 60, locked: true })
  assert.match(win.calls[0] ?? '', /^powershell\.exe -NoProfile -NonInteractive -Command .*GetLastInputInfo/s)
  const mac = fakeExec({ ioreg: done('"HIDIdleTime" = 2000000000') })
  assert.deepEqual(await observe('darwin', {}, mac), { idleSec: 2, locked: null })
  assert.deepEqual(await observe('win32', {}, fakeExec({})), { idleSec: null, locked: null })
  const throws: Exec = async () => {
    throw new Error('spawn failed')
  }
  assert.deepEqual(await observe('darwin', {}, throws), { idleSec: null, locked: null })
})

test('Linux: xprintidle on X11 only, GNOME over D-Bus, logind, a running locker', async () => {
  const now = () => 1_000_000_000_000
  // X11: xprintidle; no locker running says nothing outside a locker-only desktop.
  const x11 = fakeExec({ xprintidle: done('30000'), pgrep: done('', 1) })
  assert.deepEqual(await observe('linux', { DISPLAY: ':0' }, x11, now), { idleSec: 30, locked: null })
  assert.ok(x11.calls.some(c => c.startsWith('loginctl show-session auto ')))
  // Wayland: no xprintidle (it would see XWayland's input alone).
  const wayland = fakeExec({ xprintidle: done('999999'), pgrep: done('', 1) })
  assert.deepEqual(await observe('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, wayland, now), {
    idleSec: null,
    locked: null,
  })
  assert.ok(!wayland.calls.some(c => c.startsWith('xprintidle')))
  // GNOME: Mutter's idle time and the screensaver.
  const gnome = fakeExec({ gdbus: done('(uint64 120000,)'), pgrep: done('', 1) })
  const g = await observe('linux', { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', XDG_SESSION_ID: '3' }, gnome, now)
  assert.equal(g.idleSec, 120)
  assert.ok(gnome.calls.some(c => c.startsWith('loginctl show-session 3 ')))
  // Hyprland: hyprlock running is locked; not running is unlocked.
  const locked = fakeExec({ pgrep: done('4242\n', 0) })
  assert.deepEqual(await observe('linux', { XDG_CURRENT_DESKTOP: 'Hyprland' }, locked, now), {
    idleSec: null,
    locked: true,
  })
  const open = fakeExec({ pgrep: done('', 1) })
  assert.deepEqual(await observe('linux', { XDG_CURRENT_DESKTOP: 'Hyprland' }, open, now), {
    idleSec: null,
    locked: false,
  })
})
