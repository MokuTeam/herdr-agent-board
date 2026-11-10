// Whether the page is drawn (#333, models/drawn.ts): one frame asked for at a time; two looks in a
// row without it say the page is not drawn, once; the frame that comes at last says it is drawn
// again, once. While not drawn, each look asks anew in place of the frame before.
import { expect, test } from 'bun:test'
import { DRAWN_EVERY_MS, DRAWN_MISSES, watchDrawn } from '../../web/src/models/drawn.ts'

/** A page's frames and the watch's timer, both run by the test. */
function page() {
  const frames = new Map<number, () => void>()
  let id = 0
  let look: (() => void) | null = null
  let every = 0
  const said: string[] = []
  const watch = watchDrawn({
    undrawn: () => said.push('undrawn'),
    drawn: () => said.push('drawn'),
    frame: fn => {
      frames.set(++id, fn)
      return id
    },
    cancel: n => frames.delete(n as number),
    every: (fn, ms) => {
      look = fn
      every = ms
      return 1
    },
    stopEvery: () => {
      look = null
    },
  })
  return {
    said,
    watch,
    every: () => every,
    asked: () => frames.size,
    draw() {
      const due = [...frames.values()]
      frames.clear()
      for (const fn of due) fn()
    },
    look(times = 1) {
      for (let i = 0; i < times; i++) look?.()
    },
    looking: () => look !== null,
  }
}

test('a page drawn as usual: one frame asked for at a time, and nothing said', () => {
  const p = page()
  expect(p.every()).toBe(DRAWN_EVERY_MS)
  expect(p.asked()).toBe(1)
  for (let i = 0; i < 10; i++) {
    p.draw()
    p.look()
    expect(p.asked()).toBe(1)
  }
  expect(p.said).toEqual([])
})

test('a frame held back past one look (a long task) is no verdict', () => {
  const p = page()
  p.look(DRAWN_MISSES - 1)
  p.draw()
  p.look()
  p.look(DRAWN_MISSES - 1)
  p.draw()
  expect(p.said).toEqual([])
})

test('no frame over two looks: not drawn, said once however long it lasts, one frame asked for all along', () => {
  const p = page()
  p.look(DRAWN_MISSES)
  expect(p.said).toEqual(['undrawn'])
  for (let i = 0; i < 20; i++) {
    p.look()
    expect(p.asked()).toBe(1)
  }
  expect(p.said).toEqual(['undrawn'])
})

test('the frame that comes at last: drawn again, once; then the watch goes on as before', () => {
  const p = page()
  p.look(DRAWN_MISSES + 3)
  p.draw()
  expect(p.said).toEqual(['undrawn', 'drawn'])
  p.look()
  p.draw()
  p.look()
  expect(p.said).toEqual(['undrawn', 'drawn'])
  p.look(DRAWN_MISSES)
  expect(p.said).toEqual(['undrawn', 'drawn', 'undrawn'])
})

test('stopped: no more looks, and the frame asked for is given back', () => {
  const p = page()
  p.look(DRAWN_MISSES)
  p.watch.stop()
  expect(p.looking()).toBe(false)
  expect(p.asked()).toBe(0)
  p.draw()
  expect(p.said).toEqual(['undrawn'])
})
