import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { LANGUAGES, missingKeys, resolveLanguage, translator } from '../../src/core/i18n/translator.ts'
import { WAKE_STRINGS } from '../../src/core/i18n/wake-strings.ts'

describe('languages', () => {
  test('every language has every text', () => {
    for (const lang of Object.keys(LANGUAGES) as Array<keyof typeof LANGUAGES>) {
      assert.deepEqual(missingKeys(lang), [], `missing in ${lang}`)
    }
    assert.deepEqual(missingKeys('ru'), [])
    assert.deepEqual(missingKeys('en'), [])
  })

  test('plural forms, placeholders, English as the fallback', () => {
    const en = translator('en')
    const ru = translator('ru')
    assert.equal(ru('col.me'), 'Ждёт меня')
    assert.equal(en('cat.sessions', { n: 1 }), '1 session')
    assert.equal(en('cat.sessions', { n: 5 }), '5 sessions')
    assert.deepEqual(
      [1, 2, 5, 11, 21, 22, 25].map(n => ru('cat.sessions', { n })),
      ['1 сессия', '2 сессии', '5 сессий', '11 сессий', '21 сессия', '22 сессии', '25 сессий'],
    )
    assert.equal(ru('sent.to', { name: 'X' }), 'Отправлено в X')
    assert.equal(translator('xx')('col.me'), 'Needs me')
    assert.equal(translator('xx').lang, 'en')
    assert.equal(en('no.such.key'), 'no.such.key')
  })

  test('resolveLanguage: explicit choice, else the system locale, else English', () => {
    assert.equal(resolveLanguage('auto', 'ru-RU'), 'ru')
    assert.equal(resolveLanguage('auto', 'de-DE'), 'en')
    assert.equal(resolveLanguage('en', 'ru-RU'), 'en')
    assert.equal(resolveLanguage('ru', 'en-US'), 'ru')
  })
})

describe('sleep and wake (#119)', () => {
  // The plan's English, word for word.
  const PLANNED: Record<string, string> = {
    'set.wake': 'Sleep and wake…',
    'wake.title': 'Sleep and wake',
    'wake.switch': 'Sleep and wake',
    'wake.switchHint': 'Put to sleep, Wake and Restart, in every profile',
    'wake.state.off': 'Off',
    'wake.state.offAsleep': 'Off. {n} asleep still wake from their cards',
    'wake.state.starting': 'Starting…',
    'wake.state.running': 'Running since {time}, {n} asleep',
    'wake.state.crashed': 'Crashed: stopped after {n} crashes in 10 minutes. {error}',
    'wake.state.notRunning': 'Not running',
    'wake.state.held': 'The separate herdr-wake plugin does this now',
    'wake.state.portTaken': 'Port {port} is taken by another program',
    'wake.start': 'Start',
    'wake.again': 'Start again',
    'wake.log': 'Log',
    'wake.reaper': 'Put idle sessions to sleep',
    'wake.reaper.after': 'after {min} minutes',
    'wake.reaper.minutes': 'Minutes idle',
    'wake.reaper.exclude': 'Never put to sleep',
    'wake.reaper.excludeHint': 'Names, workspaces or /regex/, one per line',
    'wake.telegram': 'Telegram messages (tg-mcp)',
    'wake.telegram.auto': 'Auto',
    'wake.telegram.off': 'Off',
    'wake.telegram.connected': 'connected to {host}',
    'wake.telegram.none': 'no tg-mcp set up',
    'wake.telegram.error': 'last poll: {error}',
    'wake.stopped': 'Wake stopped',
    'wake.stoppedHint': 'Sleep and wake is on but not running: open its settings',
    'wake.readOnly': 'Changed on the computer only',
    'err.wakeOff': 'Sleep and wake is off (Settings → Sleep and wake…)',
    'err.wakeBusy': 'Wake is slow to answer and may be waking {name} already; try again in a minute',
    'err.canWake.board': '{name} could not be woken again: the board command is not on PATH',
    'err.canWake.profile': '{name} could not be woken again: its profile is not known',
    'err.canWake.transcript': "{name} could not be woken again: its conversation is not in its profile's folder",
    'err.wakeSetting': '{field}: {why}',
    'setup.wake.running': 'Sleep and wake runs',
    'setup.wake.runningDetail': 'on 127.0.0.1:{port}, {n} asleep',
    'setup.wake.newOff': 'Sleep and wake is off',
    'setup.wake.newOffFix':
      'Turn it on in Settings → Sleep and wake…, or set "wake": { "enabled": true } in the board\'s config.json',
    'setup.wake.crashed': 'Sleep and wake crashed',
    'setup.wake.crashedFix': 'Settings → Sleep and wake… → Start again. Its log: {file}',
    'setup.wake.held': 'The separate herdr-wake plugin puts sessions to sleep',
    'setup.wake.heldFix': 'Settings → Sleep and wake… → Switch over…',
    'setup.wake.notAnswering': 'Sleep and wake is on but does not answer on port {port}',
    'setup.wake.notAnsweringFix': 'Settings → Sleep and wake… → Start. Its log: {file}',
    'setup.wake.portTaken': 'Port {port} is taken by another program',
    'setup.wake.portTakenFix': 'Set another "port" in the wake section of the board\'s config.json',
    'setup.wake.urlUnused': 'wakeUrl in config.json is not used while Sleep and wake is on',
  }

  test('every text in English and Russian, merged into the dictionaries', () => {
    const en = Object.keys(WAKE_STRINGS.en)
    assert.deepEqual(Object.keys(WAKE_STRINGS.ru).sort(), [...en].sort())
    for (const [key, text] of Object.entries(PLANNED)) assert.equal(WAKE_STRINGS.en[key], text, key)
    const [enT, ruT] = [translator('en'), translator('ru')]
    for (const key of en) {
      assert.notEqual(enT(key, { n: 2 }), key, key)
      // Words to translate: all but '{field}: {why}'.
      if (/[a-z]/i.test(String(WAKE_STRINGS.en[key]).replace(/\{\w+\}/g, '')))
        assert.notEqual(ruT(key, { n: 2 }), enT(key, { n: 2 }), `${key} is not in Russian`)
    }
    assert.deepEqual(missingKeys('ru'), [])
  })

  test('Russian counts take their plural forms; placeholders are kept', () => {
    const ru = translator('ru')
    assert.deepEqual(
      [1, 3, 5, 21].map(n => ru('wake.state.offAsleep', { n })),
      [
        'Выключено. 1 спящая сессия всё ещё будится со своей карточки',
        'Выключено. 3 спящие сессии всё ещё будятся со своих карточек',
        'Выключено. 5 спящих сессий всё ещё будятся со своих карточек',
        'Выключено. 21 спящая сессия всё ещё будится со своей карточки',
      ],
    )
    for (const key of Object.keys(WAKE_STRINGS.en)) {
      const own = (s: string | string[]): string[] => [...new Set(String(s).match(/\{\w+\}/g) ?? [])].sort()
      const ruForms = WAKE_STRINGS.ru[key]
      for (const form of Array.isArray(ruForms) ? ruForms : [ruForms ?? ''])
        assert.deepEqual(own(form), own(WAKE_STRINGS.en[key] ?? ''), key)
    }
  })
})
