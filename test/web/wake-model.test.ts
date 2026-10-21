// Settings → Sleep and wake…'s rules on their own (web/src/models/wake.ts): the state line in the
// board's words and time format, when the toolbar's quiet "Wake stopped" note shows, the buttons
// each state offers, Telegram's line, what an edit of the reaper's fields sends, and the switches
// the page holds as sent until the board says the same.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { WakeSettingsView, WakeView } from '../../src/core/wake/view.ts'
import { shortWhen, timeOf } from '../../src/core/when-format.ts'
import {
  excludeEdited,
  hookNotes,
  isWakeReply,
  isWakeView,
  minutesEdited,
  noteShown,
  settledPending,
  stateLine,
  telegramLine,
  wakeButtons,
  withPending,
} from '../../web/src/models/wake.ts'

const en = translator('en')
const ru = translator('ru')
const NOW = new Date(2026, 9, 21, 15, 30).getTime()
const NINE_TWELVE = new Date(2026, 9, 21, 9, 12).getTime()

const view = (fields: Partial<WakeView> = {}): WakeView => ({
  on: true,
  state: 'running',
  since: NINE_TWELVE,
  asleep: 4,
  port: 12421,
  downSince: null,
  ...fields,
})

const SETTINGS: WakeSettingsView = {
  reaper: { enabled: false, idleMinutes: 60, exclude: [], maxPerRound: 3 },
  telegram: 'off',
  found: null,
  lastError: null,
  log: 'C:\\Users\\Иван Петров\\AppData\\Local\\herdr\\plugins\\agent-board\\wake.log',
  hooks: [],
}

describe('the state line', () => {
  test('running: since when, in the board’s time format, and how many sleep', () => {
    expect(stateLine(view(), en, NOW)).toBe(`Running since ${timeOf(NINE_TWELVE, en)}, 4 asleep`)
    expect(stateLine(view(), ru, NOW)).toBe(`Работает с ${timeOf(NINE_TWELVE, ru)}, 4 спят`)
    expect(stateLine(view({ asleep: 1 }), ru, NOW)).toBe(`Работает с ${timeOf(NINE_TWELVE, ru)}, 1 спит`)
    expect(stateLine(view({ asleep: 5 }), ru, NOW)).toBe(`Работает с ${timeOf(NINE_TWELVE, ru)}, 5 спят`)
    // Since yesterday: the day too, as a card says it.
    const yesterday = NINE_TWELVE - 86_400_000
    expect(stateLine(view({ since: yesterday }), en, NOW)).toBe(
      `Running since ${shortWhen(yesterday, en, NOW)}, 4 asleep`,
    )
  })

  test('off: with the sessions that still sleep, which wake from their cards', () => {
    expect(stateLine(view({ on: false, state: 'off', since: null, asleep: 0 }), en, NOW)).toBe('Off')
    expect(stateLine(view({ on: false, state: 'off', since: null, asleep: 3 }), en, NOW)).toBe(
      'Off. 3 asleep still wake from their cards',
    )
    expect(stateLine(view({ on: false, state: 'off', since: null, asleep: 1 }), ru, NOW)).toBe(
      'Выключено. 1 спящая сессия всё ещё будится со своей карточки',
    )
    expect(stateLine(view({ on: false, state: 'off', since: null, asleep: 3 }), ru, NOW)).toBe(
      'Выключено. 3 спящие сессии всё ещё будятся со своих карточек',
    )
  })

  test('crashed: after how many crashes, and the first line of the last error', () => {
    const crashed = view({ state: 'crashed', since: null, crashes: 5, error: 'EADDRINUSE\n    at listen (net.js:1)' })
    expect(stateLine(crashed, en, NOW)).toBe('Crashed: stopped after 5 crashes in 10 minutes. EADDRINUSE')
    expect(stateLine(crashed, ru, NOW)).toBe('Упало: остановлено после 5 падений за 10 минут. EADDRINUSE')
    // No error recorded: the sentence ends there.
    expect(stateLine(view({ state: 'crashed', since: null, crashes: 1 }), en, NOW)).toBe(
      'Crashed: stopped after 1 crashes in 10 minutes.',
    )
  })

  test('the others: starting, not running, held by the old plugin, its port taken', () => {
    expect(stateLine(view({ state: 'starting', since: null }), en, NOW)).toBe('Starting…')
    expect(stateLine(view({ state: 'notRunning', since: null }), en, NOW)).toBe('Not running')
    expect(stateLine(view({ state: 'held', since: null }), en, NOW)).toBe(
      'The separate herdr-wake plugin does this now',
    )
    expect(stateLine(view({ state: 'portTaken', since: null, port: 12500 }), en, NOW)).toBe(
      'Port 12500 is taken by another program',
    )
    expect(stateLine(view({ state: 'notRunning', since: null }), ru, NOW)).toBe('Не работает')
  })
})

describe('the toolbar’s note', () => {
  const MIN = 60_000
  test('on and not running for more than a minute, by downSince', () => {
    for (const state of ['crashed', 'notRunning', 'portTaken', 'starting'] as const) {
      expect([state, noteShown(view({ state, since: null, downSince: NOW - MIN - 1 }), NOW)]).toEqual([state, true])
      // A minute or less: not yet.
      expect([state, noteShown(view({ state, since: null, downSince: NOW - MIN }), NOW)]).toEqual([state, false])
      expect([state, noteShown(view({ state, since: null, downSince: NOW - 5000 }), NOW)]).toEqual([state, false])
    }
  })

  test('never while running, off or held, without downSince, or without wake in the payload', () => {
    const long = NOW - 3_600_000
    expect(noteShown(view({ downSince: long }), NOW)).toBe(false)
    expect(noteShown(view({ on: false, state: 'off', since: null, downSince: long }), NOW)).toBe(false)
    expect(noteShown(view({ state: 'held', since: null, downSince: long }), NOW)).toBe(false)
    expect(noteShown(view({ state: 'crashed', since: null, downSince: null }), NOW)).toBe(false)
    expect(noteShown(view({ state: 'crashed', since: null }), NOW)).toBe(false)
    expect(noteShown(undefined, NOW)).toBe(false)
  })
})

test('the buttons each state offers: Start when not running; Start again and Log once crashed; none otherwise', () => {
  expect(wakeButtons(view({ state: 'notRunning' }))).toEqual(['start'])
  expect(wakeButtons(view({ state: 'crashed' }))).toEqual(['again', 'log'])
  for (const state of ['running', 'starting', 'held', 'portTaken'] as const)
    expect(wakeButtons(view({ state }))).toEqual([])
  expect(wakeButtons(view({ on: false, state: 'off' }))).toEqual([])
})

test('Telegram’s line: the last poll error, the host it found, or that there is none', () => {
  const auto = { ...SETTINGS, telegram: 'auto' as const }
  expect(telegramLine(auto, en)).toBe('no tg-mcp set up')
  expect(telegramLine({ ...auto, found: { host: '127.0.0.1:8787' } }, en)).toBe('connected to 127.0.0.1:8787')
  expect(telegramLine({ ...auto, found: { host: '127.0.0.1:8787' }, lastError: 'fetch failed' }, en)).toBe(
    'last poll: fetch failed',
  )
  expect(telegramLine({ ...auto, found: { host: 'tg.local' } }, ru)).toBe('подключено к tg.local')
  // Off: only that there is none to turn on, never "connected".
  expect(telegramLine(SETTINGS, en)).toBe('no tg-mcp set up')
  expect(telegramLine({ ...SETTINGS, found: { host: '127.0.0.1:8787' } }, en)).toBeNull()
})

test('the hooks the panel names: per shown profile, only while wake is on and not held; installed ones none', () => {
  const work = { id: 'work', title: 'Работа 100%', state: 'missing' as const }
  const old = { id: 'old', title: 'Old', state: 'old' as const }
  const s = { ...SETTINGS, hooks: [{ id: 'default', title: 'Private', state: 'in' as const }, work, old] }
  expect(hookNotes(view(), s)).toEqual([work, old])
  expect(hookNotes(view({ state: 'notRunning' }), s)).toEqual([work, old])
  expect(hookNotes(view({ state: 'held' }), s)).toEqual([])
  expect(hookNotes(view({ on: false, state: 'off' }), s)).toEqual([])
  expect(hookNotes(view(), null)).toEqual([])
})

test('the reaper’s fields: what an edit sends, nothing when it is what the board has', () => {
  expect(minutesEdited(60, ' 45 ')).toBe(45)
  expect(minutesEdited(60, '60')).toBeNull()
  expect(minutesEdited(60, ' 060 ')).toBeNull()
  // Not a number: sent as typed, so the board says why it refuses it.
  expect(minutesEdited(60, 'soon')).toBe('soon')
  expect(minutesEdited(60, '1.5')).toBe(1.5)
  expect(minutesEdited(60, '   ')).toBeNull()
  expect(excludeEdited(['build', 'Проект x 50%'], 'build\n  Проект x 50%  \n\n')).toBeNull()
  expect(excludeEdited(['build'], 'build\r\n/^tmp/\n')).toEqual(['build', '/^tmp/'])
  expect(excludeEdited(['build'], '  \n')).toEqual([])
})

test('a switch shows as sent until the board says the same', () => {
  const sent = { on: false, reaper: { enabled: true, idleMinutes: 45 }, telegram: 'auto' as const }
  const shown = withPending(view(), SETTINGS, sent)
  expect(shown.view?.on).toBe(false)
  expect(shown.settings?.reaper).toEqual({ enabled: true, idleMinutes: 45, exclude: [], maxPerRound: 3 })
  expect(shown.settings?.telegram).toBe('auto')
  expect(withPending(undefined, null, sent)).toEqual({ view: undefined, settings: null })
  // The board says the same for some: those are settled, the rest still wait.
  const later = { ...SETTINGS, reaper: { ...SETTINGS.reaper, enabled: true }, telegram: 'auto' as const }
  expect(settledPending(view({ on: false, state: 'off' }), later, sent)).toEqual({ reaper: { idleMinutes: 45 } })
  expect(
    settledPending(view({ on: false, state: 'off' }), { ...later, reaper: { ...later.reaper, idleMinutes: 45 } }, sent),
  ).toEqual({})
  // Not read yet: nothing settles.
  expect(settledPending(view(), null, { reaper: { exclude: ['a'] } })).toEqual({ reaper: { exclude: ['a'] } })
})

test('the guards: the payload’s state line and GET /api/wake’s answer', () => {
  expect(isWakeView(view())).toBe(true)
  expect(isWakeView(view({ state: 'crashed', crashes: 2, error: 'x', since: null }))).toBe(true)
  expect(isWakeView({ ...view(), state: 'sleeping' })).toBe(false)
  expect(isWakeView({ ...view(), on: 'yes' })).toBe(false)
  expect(isWakeView(null)).toBe(false)
  expect(isWakeReply({ view: view(), settings: SETTINGS })).toBe(true)
  expect(isWakeReply({ view: view(), settings: { ...SETTINGS, hooks: 'none' } })).toBe(false)
  expect(isWakeReply({ view: view() })).toBe(false)
})
