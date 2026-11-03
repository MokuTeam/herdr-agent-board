// Cutting a card line at a word (#321; web/src/hooks/useWordClip.ts): how many words fit, measured
// on a copy of the element. No browser here: a stand-in element whose text wraps every `perLine`
// characters, its lines 20px high.
import { expect, test } from 'bun:test'
import { wordsThatFit } from '../../web/src/hooks/useWordClip.ts'

function element(perLine: number, label = '') {
  const slot = { textContent: '' }
  const seen = { added: 0, removed: 0, style: {} as Record<string, string> }
  const copy = {
    style: seen.style,
    querySelector: (selector: string) => (selector === '[data-clip]' ? slot : null),
    removeAttribute() {},
    setAttribute() {},
    remove() {
      seen.removed++
    },
    get scrollHeight() {
      return Math.ceil((label + slot.textContent).length / perLine) * 20
    },
  }
  const el = {
    cloneNode: () => copy,
    parentElement: {
      appendChild() {
        seen.added++
      },
    },
  }
  return { el: el as unknown as HTMLElement, seen }
}
const style = () => ({ lineHeight: '20px' })
const TEXT = 'one two three four five six' // 27 characters

test('the most words that fit with "…"; null when the whole text does', () => {
  // Two lines of 10: "one two three four…" (19) fits, "one two three four five…" (24) does not.
  expect(wordsThatFit(element(10).el, TEXT, 2, 200, style)).toBe(4)
  expect(wordsThatFit(element(10).el, TEXT, 3, 200, style)).toBeNull()
  // What stands before the text (a label) takes its room too.
  expect(wordsThatFit(element(10, 'Task ').el, TEXT, 2, 200, style)).toBe(3)
  // Not even one word: the "…" alone.
  expect(wordsThatFit(element(1).el, TEXT, 1, 200, style)).toBe(0)
})

test('measured on a hidden copy at the width given, taken out again', () => {
  const { el, seen } = element(10)
  wordsThatFit(el, TEXT, 2, 187.5, style)
  expect(seen).toMatchObject({ added: 1, removed: 1 })
  expect(seen.style).toMatchObject({
    width: '187.5px',
    visibility: 'hidden',
    maxHeight: 'none',
    webkitLineClamp: 'none',
  })
})

test('nothing to measure: the text stays whole', () => {
  const orphan = { cloneNode: () => ({}), parentElement: null } as unknown as HTMLElement
  expect(wordsThatFit(orphan, TEXT, 2, 200, style)).toBeNull()
  expect(wordsThatFit(element(10).el, TEXT, 2, 200, () => ({ lineHeight: 'normal' }))).toBeNull()
})
