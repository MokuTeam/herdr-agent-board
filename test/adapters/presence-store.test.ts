// presence.json and the cards' presenceSeen (#172): a switch, the news a prompt reads once, the
// sessions marked when presence is turned on and unmarked when it is turned off; and editPresence,
// the Settings menu's switch into config.json.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readCard, writeCard } from '../../src/adapters/cards.ts'
import { configFile, editPresence } from '../../src/adapters/config-file.ts'
import { configDir } from '../../src/adapters/paths.ts'
import {
  clearPresence,
  currentPresence,
  markSessions,
  presenceFile,
  presenceForBrief,
  presenceNews,
  readPresence,
  setPresence,
  unmarkSessions,
} from '../../src/adapters/presence-store.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { NO_PRESENCE } from '../../src/core/presence.ts'
import { isolatedHome } from '../support/env.ts'

test('a switch is saved once; the same state again changes nothing', () => {
  isolatedHome()
  expect(readPresence()).toBeNull()
  expect(currentPresence()).toEqual(NO_PRESENCE)
  // "Here" before anyone set anything is a first record, not a no-op: the file says who said it.
  expect(setPresence('here', 'user', 'web', 100)).toEqual({
    presence: { state: 'here', since: 100, by: 'user', from: 'web' },
    changed: true,
  })
  expect(setPresence('here', 'auto', 'auto', 200).changed).toBe(false)
  const away = setPresence('away', 'auto', 'auto', 300)
  expect(away).toEqual({ presence: { state: 'away', since: 300, by: 'auto', from: 'auto' }, changed: true })
  expect(setPresence('away', 'user', 'phone', 400)).toEqual({ presence: away.presence, changed: false })
  expect(JSON.parse(readFileSync(presenceFile(), 'utf8')).since).toBe(300)
  clearPresence()
  expect(existsSync(presenceFile())).toBe(false)
  clearPresence()
})

test('a call keeps the state it started from, and drops it once over', () => {
  isolatedHome()
  expect(setPresence('call', 'auto', 'auto', 100).presence).toEqual({
    state: 'call',
    since: 100,
    by: 'auto',
    from: 'auto',
    before: 'here',
  })
  expect(setPresence('call', 'user', 'web', 200).changed).toBe(false)
  expect(setPresence('away', 'user', 'web', 300).presence).toEqual({
    state: 'away',
    since: 300,
    by: 'user',
    from: 'web',
  })
  expect(setPresence('call', 'user', 'cli', 400).presence).toMatchObject({ state: 'call', before: 'away' })
  expect(readPresence()).toMatchObject({ state: 'call', before: 'away', since: 400 })
})

test('presenceForBrief: nothing while config.json has no presence', () => {
  isolatedHome()
  setPresence('away', 'user', 'cli', 5)
  expect(presenceForBrief({})).toBeNull()
  expect(presenceForBrief({ presence: { mode: 'off' } })?.state).toBe('away')
  clearPresence()
  expect(presenceForBrief({ presence: true })).toEqual(NO_PRESENCE)
})

test('presenceNews: a card that never heard of presence reads nothing; a change is told once', () => {
  isolatedHome()
  expect(presenceNews(null)).toBeNull()
  expect(presenceNews({})).toBeNull()
  setPresence('away', 'user', 'web', 1000)
  expect(presenceNews({})).toBeNull()
  // Briefed at 1000: nothing new.
  expect(presenceNews({ presenceSeen: 1000 })).toBeNull()
  setPresence('here', 'auto', 'auto', 2000)
  const news = presenceNews({ presenceSeen: 1000 })
  expect(news?.seen).toBe(2000)
  expect(news?.line).toMatch(/at the computer/)
  // Marked (-1): told the state on record, or the default when there is none.
  expect(presenceNews({ presenceSeen: -1 })?.seen).toBe(2000)
  clearPresence()
  expect(presenceNews({ presenceSeen: -1 })).toEqual({ line: expect.stringMatching(/at the computer/), seen: 0 })
  expect(presenceNews({ presenceSeen: 2000 })).toBeNull()
})

test('markSessions marks briefed cards that never heard of it; unmarkSessions takes the mark off', () => {
  isolatedHome()
  writeCard('briefed', { briefV: 5 })
  writeCard('told', { briefV: 5, presenceSeen: 1234 })
  writeCard('bare', { title: 'no brief' })
  markSessions(['briefed', 'told', 'bare', 'missing'])
  expect(readCard('briefed')?.presenceSeen).toBe(-1)
  expect(readCard('told')?.presenceSeen).toBe(1234)
  expect(readCard('bare')?.presenceSeen).toBeUndefined()
  expect(readCard('missing')).toBeNull()
  unmarkSessions(['briefed', 'told', 'bare', 'missing'])
  for (const key of ['briefed', 'told', 'bare']) expect(readCard(key)).not.toHaveProperty('presenceSeen')
  expect(readCard('missing')).toBeNull()
})

const saved = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), 'utf8'))
const seed = (obj: unknown): void => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(obj))
}

test('editPresence turns presence on and off, sets the mode and the minutes, keeps the rest', () => {
  isolatedHome()
  useLanguage('en')
  seed({ language: 'en', mine: { a: 1 } })
  expect(editPresence({ on: true })).toEqual({ ok: true })
  expect(saved()).toEqual({ language: 'en', mine: { a: 1 }, presence: { mode: 'auto' } })
  expect(editPresence({ mode: 'suggest' })).toEqual({ ok: true })
  expect(editPresence({ idleMinutes: 30 })).toEqual({ ok: true })
  expect(saved().presence).toEqual({ mode: 'suggest', idleMinutes: 30 })
  // `true` becomes a section as it reads now.
  seed({ presence: true, future: 1 })
  expect(editPresence({ idleMinutes: 5 })).toEqual({ ok: true })
  expect(saved()).toEqual({ presence: { mode: 'auto', idleMinutes: 5 }, future: 1 })
  // Off: no section at all, as a setup that never turned it on.
  expect(editPresence({ on: false })).toEqual({ ok: true })
  expect(saved()).toEqual({ future: 1 })
  // Nothing asked while it is off leaves it off.
  expect(editPresence({})).toEqual({ ok: true })
  expect(saved()).toEqual({ future: 1 })
  // A mode alone turns it on in that mode.
  expect(editPresence({ mode: 'off' })).toEqual({ ok: true })
  expect(saved().presence).toEqual({ mode: 'off' })
})

test('editPresence refuses a value of the wrong kind and leaves config.json as it was', () => {
  isolatedHome()
  useLanguage('en')
  seed({ presence: { mode: 'auto' } })
  for (const body of [{ on: 'yes' }, { mode: 'sometimes' }]) {
    expect(editPresence(body)).toEqual({ ok: false, error: expect.any(String) })
  }
  for (const idleMinutes of [0, 1.5, 1441, '10']) {
    expect(editPresence({ idleMinutes })).toEqual({ ok: false, error: expect.stringMatching(/1440/) })
  }
  expect(saved()).toEqual({ presence: { mode: 'auto' } })
})
