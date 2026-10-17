// A session to show from outside (web/src/models/reveal.ts): the page's address, the stream's
// `reveal` event, and what showing it takes (upstream's web/app.js revealOnLoad and reveal).
import { expect, test } from 'bun:test'
import { revealedKey, revealStep, sessionInHash } from '../../web/src/models/reveal.ts'

test('a page opened for a session: #session=<key> in its address', () => {
  expect(sessionInHash('#session=abc-1')).toBe('abc-1')
  expect(sessionInHash(`#session=${encodeURIComponent('a b/ü')}`)).toBe('a b/ü')
  expect(sessionInHash('#other=1&session=k')).toBe('k')
  expect(sessionInHash('')).toBe(null)
  expect(sessionInHash('#')).toBe(null)
})

test('the stream names a session as { key }; anything else names none', () => {
  expect(revealedKey(JSON.stringify({ key: 's1' }))).toBe('s1')
  expect(revealedKey('{"pane":"p1"}')).toBe(null)
  expect(revealedKey('{"key":7}')).toBe(null)
  expect(revealedKey('not json')).toBe(null)
  expect(revealedKey('null')).toBe(null)
})

test('showing a session: none off the board; its sheet opens unless it is the one open', () => {
  const items = [{ key: 'a' }, { key: 'b' }]
  expect(revealStep('c', items, null)).toBe(null)
  expect(revealStep('a', items, null)).toEqual({ openSheet: true })
  expect(revealStep('a', items, 'b')).toEqual({ openSheet: true })
  expect(revealStep('a', items, 'a')).toEqual({ openSheet: false })
})
