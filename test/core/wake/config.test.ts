import { expect, test } from 'bun:test'
import { telegramTarget, WAKE_SHIPPED, wakeConfig, wakeSwitch } from '../../../src/core/wake/config.ts'

const TELEGRAM = {
  mcpServers: { telegram: { url: 'http://127.0.0.1:8787/mcp', headers: { Authorization: 'Bearer t' } } },
}

test('without a wake section: the defaults, and no Telegram even with tg-mcp in ~/.claude.json', () => {
  const c = wakeConfig(undefined)
  expect(c).toEqual({
    enabled: WAKE_SHIPPED,
    reaper: { enabled: false, idleMinutes: 60, exclude: [], maxPerRound: 3 },
    telegram: 'off',
    port: 12421,
    workspace: 'Wake',
    url: null,
    authorization: null,
    server: 'telegram',
    wakeTimeoutSec: 120,
    pollTimeoutSec: 25,
    listSleepingDays: 7,
    closePanes: true,
  })
  expect(telegramTarget(c, TELEGRAM)).toBeNull()
})

test('closePanes: on unless the section says false (#204)', () => {
  expect(wakeConfig({ closePanes: false }).closePanes).toBe(false)
  for (const v of [true, undefined, 'no', 0, null]) expect(wakeConfig({ closePanes: v }).closePanes).toBe(true)
  expect(wakeConfig(false).closePanes).toBe(true)
})

test('auto: the telegram MCP server in ~/.claude.json gives the url and token, as before', () => {
  expect(telegramTarget(wakeConfig({ telegram: 'auto' }), TELEGRAM)).toEqual({
    url: 'http://127.0.0.1:8787',
    authorization: 'Bearer t',
    host: '127.0.0.1:8787',
  })
})

test('the wake section wins over ~/.claude.json, and its reaper over the defaults', () => {
  const c = wakeConfig({
    telegram: 'auto',
    url: 'http://box:1',
    authorization: 'Bearer own',
    reaper: { enabled: true, idleMinutes: 30 },
  })
  expect(telegramTarget(c, TELEGRAM)).toEqual({ url: 'http://box:1', authorization: 'Bearer own', host: 'box:1' })
  expect(c.reaper).toEqual({ enabled: true, idleMinutes: 30, exclude: [], maxPerRound: 3 })
})

test('a url without a token is no Telegram', () => {
  expect(telegramTarget(wakeConfig({ telegram: 'auto', url: 'http://box:1' }), {})).toBeNull()
})

test('true, false, and wrong types fall back to the defaults', () => {
  expect([wakeConfig(true).enabled, wakeConfig(false).enabled]).toEqual([true, false])
  const c = wakeConfig({ port: 0, telegram: 'on', workspace: ' ', reaper: { exclude: ['a', 1], idleMinutes: '5' } })
  expect([c.port, c.telegram, c.workspace, c.reaper.exclude, c.reaper.idleMinutes]).toEqual([
    12421,
    'off',
    'Wake',
    ['a'],
    60,
  ])
})

test('the kill switch: no config.json is the default, one that does not parse is off', () => {
  expect(wakeSwitch({ exists: false, raw: null })).toBe(WAKE_SHIPPED)
  expect(wakeSwitch({ exists: true, raw: null })).toBe(false)
  expect(wakeSwitch({ exists: true, raw: [] })).toBe(false)
  expect(wakeSwitch({ exists: true, raw: { wake: false } })).toBe(false)
  expect(wakeSwitch({ exists: true, raw: { wake: { enabled: false } } })).toBe(false)
  expect(wakeSwitch({ exists: true, raw: { wake: { enabled: true } } })).toBe(true)
  expect(wakeSwitch({ exists: true, raw: {} })).toBe(WAKE_SHIPPED)
})

test('the kill switch fails closed: a wake value or an enabled of the wrong type is off, never on', () => {
  // Wake is on by default: a switch written wrong ("off", 0, …) must not leave it on.
  expect(WAKE_SHIPPED).toBe(true)
  for (const wake of ['off', 'false', 'true', 0, 1, [], [true], null]) {
    expect([wake, wakeConfig(wake).enabled]).toEqual([wake, false])
    expect([wake, wakeSwitch({ exists: true, raw: { wake } })]).toEqual([wake, false])
  }
  for (const enabled of ['off', 'false', 'true', 0, 1, [], {}, null]) {
    expect([enabled, wakeConfig({ enabled }).enabled]).toEqual([enabled, false])
    expect([enabled, wakeSwitch({ exists: true, raw: { wake: { enabled } } })]).toEqual([enabled, false])
  }
  // A section without the switch, or no section: the default.
  expect([wakeConfig(undefined).enabled, wakeConfig({ port: 2000 }).enabled]).toEqual([true, true])
  expect(wakeSwitch({ exists: true, raw: { wake: { reaper: { enabled: true } } } })).toBe(true)
})

test('Telegram off ignores a url and token of its own; an invalid url or a port past 65535 is no setting', () => {
  expect(telegramTarget(wakeConfig({ url: 'http://box:1', authorization: 'Bearer own' }), TELEGRAM)).toBeNull()
  expect(telegramTarget(wakeConfig({ telegram: 'auto', url: 'not a url', authorization: 'Bearer own' }), {})).toBeNull()
  expect([wakeConfig({ port: 65536 }).port, wakeConfig({ port: 1.5 }).port, wakeConfig({ port: 65535 }).port]).toEqual([
    12421, 12421, 65535,
  ])
})
