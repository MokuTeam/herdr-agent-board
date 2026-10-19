import { expect, test } from 'bun:test'
import { ASKED_MS, serverLanguage } from '../../web/src/models/language.ts'

test('a board from the server switches the language, except one sent before the user just picked another', () => {
  expect(serverLanguage('ru', 'en', null, 0)).toBe('ru')
  expect(serverLanguage('en', 'en', null, 0)).toBe(null)
  const asked = { lang: 'ru', at: 1000 }
  expect(serverLanguage('en', 'ru', asked, 1000 + ASKED_MS - 1)).toBe(null)
  expect(serverLanguage('ru', 'en', asked, 1000 + ASKED_MS - 1)).toBe('ru')
  expect(serverLanguage('en', 'ru', asked, 1000 + ASKED_MS)).toBe('en')
})
