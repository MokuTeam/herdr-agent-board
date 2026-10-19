// How many of the session panel's actions a row's width holds (upstream's test/row-model.test.mjs, #58).
import { expect, test } from 'bun:test'
import { fitRow } from '../../web/src/models/row-model.ts'
import { oldModule } from './support/old-app.ts'

// Go to herdr, MokuPilot, Terminal, Changes, History, Sleep, Restart, New session here.
const row = [145, 110, 107, 116, 98, 120, 130, 160].map(words => ({ words, icon: 30 }))
const sum = (widths: number[], gap = 6) => widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1)

test('everything that fits with its words shows with them, and More goes when nothing is left over', () => {
  expect(fitRow(row, sum(row.map(b => b.words)))).toEqual({ words: true, shown: 8 })
  expect(fitRow(row, 2000)).toEqual({ words: true, shown: 8 })
})

test('the row shows as many as fit from the front and keeps room for More', () => {
  // Five with words and More: 145+110+107+116+98 + 4 gaps + gap + 30 = 636.
  expect(fitRow(row, 636)).toEqual({ words: true, shown: 5 })
  expect(fitRow(row, 635)).toEqual({ words: true, shown: 4 })
})

test('fewer than four with words: icons instead, the first keeping its words', () => {
  const four = sum([145, 110, 107, 116]) + 6 + 30
  expect(fitRow(row, four).words).toBe(true)
  const narrow = fitRow(row, four - 1)
  expect(narrow.words).toBe(false)
  // As icons all eight fit: 145 + 7 * 30 + 7 gaps = 397.
  expect(narrow.shown).toBe(8)
  // One short of that: seven would leave no room for More, so six and More.
  expect(fitRow(row, 396)).toEqual({ words: false, shown: 6 })
  // A panel at its narrowest: the first, a few icons and More.
  expect(fitRow(row, 328)).toEqual({ words: false, shown: 5 })
})

test('a short row needs all of its buttons with words, and the first shows however narrow', () => {
  const two = row.slice(0, 2)
  expect(fitRow(two, 261)).toEqual({ words: true, shown: 2 })
  expect(fitRow(two, 260)).toEqual({ words: false, shown: 2 })
  expect(fitRow(row, 50)).toEqual({ words: false, shown: 1 })
  expect(fitRow([], 300)).toEqual({ words: true, shown: 0 })
})

test('upstream’s fitRow at #58, width by width, row by row, with its options', async () => {
  const fn = (await oldModule('web/row-model.js', 'b2c5afa')).get('fitRow')
  if (typeof fn !== 'function') throw new Error('no fitRow')
  const rows = [row, row.slice(0, 1), row.slice(0, 3), row.map(b => ({ ...b, icon: 36 }))]
  for (const buttons of rows)
    for (const options of [undefined, { gap: 0, more: 36 }, { gap: 8, wordsFor: 2 }])
      for (let room = 0; room <= 1200; room += 7)
        expect(fitRow(buttons, room, options)).toEqual(Reflect.apply(fn, undefined, [buttons, room, options]))
})
