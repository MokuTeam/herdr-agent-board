import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { LANGUAGES, missingKeys, resolveLanguage, translator } from '../../src/core/i18n/translator.ts'

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
