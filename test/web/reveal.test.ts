// A session to show from outside (web/src/models/reveal.ts): the page's address, the stream's
// `reveal` event, and what showing it takes (upstream's web/app.js revealOnLoad and reveal).
import { expect, test } from 'bun:test'
import {
  listenForReveals,
  type Reveal,
  type RevealSource,
  revealedKey,
  revealStep,
  sessionInHash,
} from '../../web/src/models/reveal.ts'

/** A page's event stream (api/useBoard.ts's EventSource): the test says what comes, by name. */
class FakeStream implements RevealSource {
  private readonly listeners: { type: string; fn: (event: MessageEvent) => void }[] = []

  addEventListener(type: string, fn: (event: MessageEvent) => void): void {
    this.listeners.push({ type, fn })
  }

  say(name: string, data: string): void {
    for (const l of this.listeners) if (l.type === name) l.fn(new MessageEvent(name, { data }))
  }
}

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

test('the stream tells an open page a session: one on the board as it came last, counted on each ask', () => {
  const stream = new FakeStream()
  let board: { items: { key: string }[] } | null = null
  const page: { reveal: Reveal | null } = { reveal: null }
  let asks = 0
  listenForReveals(
    stream,
    () => board,
    next => {
      asks++
      page.reveal = next(page.reveal)
    },
  )

  // No board yet: nothing to show.
  stream.say('reveal', '{"key":"a"}')
  expect(page.reveal).toBe(null)
  board = { items: [{ key: 'a' }, { key: 'b' }] }
  stream.say('reveal', '{"key":"a"}')
  expect(page.reveal).toEqual({ key: 'a', n: 1 })
  // The same session asked again is a new reveal, so the page shows it again.
  stream.say('reveal', '{"key":"a"}')
  expect(page.reveal).toEqual({ key: 'a', n: 2 })
  // Off the board, not a session, or the board's payload: nothing changes.
  stream.say('reveal', '{"key":"c"}')
  stream.say('reveal', 'not json')
  stream.say('message', '{"key":"b"}')
  expect(page.reveal).toEqual({ key: 'a', n: 2 })
  stream.say('reveal', '{"key":"b"}')
  expect(page.reveal).toEqual({ key: 'b', n: 3 })
  // By the board as it came last: a session gone from it is not shown.
  board = { items: [{ key: 'b' }] }
  stream.say('reveal', '{"key":"a"}')
  expect(page.reveal).toEqual({ key: 'b', n: 3 })
  expect(asks).toBe(3)
})
