import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitRow } from '../web/row-model.js'

// Go to herdr, MokuPilot, Terminal, Changes, History, Sleep, Restart, New session here.
const row = [145, 110, 107, 116, 98, 120, 130, 160].map(words => ({ words, icon: 30 }))
const sum = (widths, gap = 6) => widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1)

test('everything that fits with its words shows with them, and More goes when nothing is left over', () => {
  assert.deepEqual(fitRow(row, sum(row.map(b => b.words))), { words: true, shown: 8 })
  assert.deepEqual(fitRow(row, 2000), { words: true, shown: 8 })
})

test('the row shows as many as fit from the front and keeps room for More', () => {
  // Five with words and More: 145+110+107+116+98 + 4 gaps + gap + 30 = 636.
  assert.deepEqual(fitRow(row, 636), { words: true, shown: 5 })
  assert.deepEqual(fitRow(row, 635), { words: true, shown: 4 })
})

test('fewer than four with words: icons instead, the first keeping its words', () => {
  const four = sum([145, 110, 107, 116]) + 6 + 30
  assert.equal(fitRow(row, four).words, true)
  const narrow = fitRow(row, four - 1)
  assert.equal(narrow.words, false)
  // As icons all eight fit: 145 + 7 * 30 + 7 gaps = 397.
  assert.equal(narrow.shown, 8)
  // One short of that: seven would leave no room for More, so six and More.
  assert.deepEqual(fitRow(row, 396), { words: false, shown: 6 })
  // A panel at its narrowest: the first, a few icons and More.
  assert.deepEqual(fitRow(row, 328), { words: false, shown: 5 })
})

test('a short row needs all of its buttons with words, and the first shows however narrow', () => {
  const two = row.slice(0, 2)
  assert.deepEqual(fitRow(two, 261), { words: true, shown: 2 })
  assert.deepEqual(fitRow(two, 260), { words: false, shown: 2 })
  assert.deepEqual(fitRow(row, 50), { words: false, shown: 1 })
  assert.deepEqual(fitRow([], 300), { words: true, shown: 0 })
})
