// The picture moved here ahead of the server's frames (web/src/models/local-scroll.ts): the finger
// moves it at once; a big frame drawn after the server had a batch of steps moves it back as far
// as they scroll, those before it too, not those it did not have yet; steps no frame showed go back
// when they expire; all shown, the picture is moved by nothing.
import { expect, test } from 'bun:test'
import { LocalScroll } from '../../web/src/models/local-scroll.ts'

function scene() {
  const moves: string[] = []
  const scroll = new LocalScroll(settle => moves.push(`${scroll.x},${scroll.y}${settle ? ' settle' : ''}`))
  return { scroll, moves }
}

test('a swipe up 40 px: two steps of 26.5 sent; each frame that shows them moves it back; the rest goes back at the let go', () => {
  const { scroll, moves } = scene()
  scroll.move(0, -20)
  scroll.move(0, -20)
  expect([scroll.x, scroll.y]).toEqual([0, -40])
  // steps sent in two batches (down: the content up), marked 1 and 2
  scroll.sent(1, 0, 26.5)
  scroll.sent(2, 0, 26.5)
  scroll.answered(1)
  // a big frame drawn after the server had batch 1 only
  scroll.drawn(1)
  expect(scroll.y).toBe(-13.5)
  scroll.answered(2)
  scroll.drawn(2)
  expect(scroll.y).toBe(13)
  // let go: 13 px of the finger's way made no step
  scroll.move(0, -13, true)
  expect(scroll.idle).toBe(true)
  expect(moves).toEqual(['0,-20', '0,-40', '0,-13.5', '0,13', '0,0 settle'])
})

test('a frame shows only what the server had: the batches after it wait; one it had later is not shown yet', () => {
  const { scroll } = scene()
  scroll.move(0, -60)
  scroll.sent(1, 0, 20)
  scroll.sent(2, 0, 20)
  scroll.sent(3, 0, 20)
  scroll.answered(1)
  scroll.answered(2)
  expect(scroll.lastAnswered()).toBe(2)
  // the frame's update came when the server had 1 only (answered 2 since, while it was drawn)
  scroll.drawn(1)
  expect(scroll.y).toBe(-40)
  scroll.drawn(2)
  expect(scroll.y).toBe(-20)
  expect(scroll.lastAnswered()).toBeNull()
  expect(scroll.idle).toBe(false)
})

test('steps no frame showed (the page’s end) go back when they expire, settled; a reset leaves nothing', () => {
  const { scroll, moves } = scene()
  scroll.move(0, -30)
  scroll.sent(1, 0, 30)
  // not answered yet: not expired
  scroll.expire(1)
  expect(scroll.y).toBe(-30)
  scroll.answered(1)
  scroll.expire(1)
  expect(scroll.idle).toBe(true)
  expect(moves.at(-1)).toBe('0,0 settle')
  scroll.move(5, 5)
  scroll.sent(2, 1, 1)
  scroll.reset()
  expect(scroll.idle).toBe(true)
  expect(scroll.answered(2)).toBe(false)
})
