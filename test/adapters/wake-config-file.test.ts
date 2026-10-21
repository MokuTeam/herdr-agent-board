// editWake: the Sleep and wake panel's switches, written into config.json's `wake` section (#119).
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { configFile, editWake } from '../../src/adapters/config-file.ts'
import { configDir } from '../../src/adapters/paths.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { WAKE_SHIPPED, wakeConfig } from '../../src/core/wake/config.ts'
import { isolatedHome } from '../support/env.ts'

const saved = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), 'utf8'))
const seed = (obj: unknown): void => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(obj))
}

test("editWake turns wake on and off, keeps the section's other fields and the file's", () => {
  isolatedHome()
  seed({ language: 'ru', mine: { a: 1 }, wake: { port: 23456, url: 'http://tg', future: [1, 2] } })
  expect(editWake({ on: true })).toEqual({ ok: true })
  expect(saved()).toEqual({
    language: 'ru',
    mine: { a: 1 },
    wake: { port: 23456, url: 'http://tg', future: [1, 2], enabled: true },
  })
  expect(editWake({ on: false })).toEqual({ ok: true })
  expect(saved().wake).toEqual({ port: 23456, url: 'http://tg', future: [1, 2], enabled: false })

  // The reaper's fields merge into its own object; Telegram's mode is set as given.
  seed({ wake: { enabled: true, reaper: { enabled: false, maxPerRound: 5 } } })
  expect(editWake({ reaper: { enabled: true, idleMinutes: 45, exclude: ['Billing', ' /^tg-/ ', ''] } })).toEqual({
    ok: true,
  })
  expect(saved().wake).toEqual({
    enabled: true,
    reaper: { enabled: true, maxPerRound: 5, idleMinutes: 45, exclude: ['Billing', '/^tg-/'] },
  })
  expect(editWake({ reaper: { idleMinutes: 10 } })).toEqual({ ok: true })
  expect(editWake({ telegram: 'auto' })).toEqual({ ok: true })
  expect(saved().wake).toEqual({
    enabled: true,
    reaper: { enabled: true, maxPerRound: 5, idleMinutes: 10, exclude: ['Billing', '/^tg-/'] },
    telegram: 'auto',
  })
  expect(wakeConfig(saved().wake)).toMatchObject({ enabled: true, telegram: 'auto', port: 12421 })
})

test('"wake": false is replaced by an object, and so is true', () => {
  isolatedHome()
  seed({ wake: false })
  expect(editWake({ reaper: { enabled: true } })).toEqual({ ok: true })
  expect(saved().wake).toEqual({ enabled: false, reaper: { enabled: true } })
  seed({ wake: true })
  expect(editWake({ telegram: 'off' })).toEqual({ ok: true })
  expect(saved().wake).toEqual({ enabled: true, telegram: 'off' })
  seed({ wake: false })
  expect(editWake({ on: true })).toEqual({ ok: true })
  expect(saved().wake).toEqual({ enabled: true })
})

test('no wake section: a switch left alone stays the default', () => {
  isolatedHome()
  seed({ language: 'en' })
  expect(editWake({ reaper: { idleMinutes: 30 } })).toEqual({ ok: true })
  expect(saved()).toEqual({ language: 'en', wake: { reaper: { idleMinutes: 30 } } })
  expect(wakeConfig(saved().wake).enabled).toBe(WAKE_SHIPPED)
})

test('an idleMinutes below 1, a telegram mode other than auto or off, an exclude that is not strings: refused, config.json unchanged', () => {
  isolatedHome()
  useLanguage('en')
  const before = { language: 'en', wake: { enabled: true, reaper: { idleMinutes: 60 } } }
  seed(before)
  const text = readFileSync(configFile(), 'utf8')
  const refused: [unknown, string][] = [
    [{ reaper: { idleMinutes: 0 } }, 'Minutes idle: a whole number of minutes, 1 or more'],
    [{ reaper: { idleMinutes: 2.5 } }, 'Minutes idle: a whole number of minutes, 1 or more'],
    [{ reaper: { idleMinutes: '30' } }, 'Minutes idle: a whole number of minutes, 1 or more'],
    [{ telegram: 'on' }, 'Telegram messages (tg-mcp): auto or off'],
    [{ reaper: { exclude: ['ok', 3] } }, 'Never put to sleep: a list of names'],
    [{ reaper: { exclude: 'Billing' } }, 'Never put to sleep: a list of names'],
    [{ reaper: { enabled: 'yes' } }, 'Put idle sessions to sleep: on or off'],
    [{ reaper: [] }, 'Put idle sessions to sleep: on or off'],
    [{ on: 'true' }, 'Sleep and wake: on or off'],
    // A valid field beside a refused one is not written either.
    [{ on: false, reaper: { idleMinutes: -5 } }, 'Minutes idle: a whole number of minutes, 1 or more'],
  ]
  for (const [body, error] of refused) {
    expect(editWake(body)).toEqual({ ok: false, error })
    expect(readFileSync(configFile(), 'utf8')).toBe(text)
  }
})

test('the refusal in Russian', () => {
  isolatedHome()
  useLanguage('ru')
  try {
    seed({ wake: { enabled: true } })
    const r = editWake({ telegram: 'sometimes' })
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.error).toBe('Сообщения из Telegram (tg-mcp): auto или off')
  } finally {
    useLanguage('en')
  }
})
