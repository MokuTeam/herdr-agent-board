// How the web board folds a session asleep in "Waiting", as config.json's `foldWaiting` says.
import { expect, test } from 'bun:test'
import { FOLD_MODES, foldModeOf, isFoldMode } from '../../src/core/fold-mode.ts'

test('the cards below move apart by default; over them, or no folding, when config.json says so', () => {
  expect(FOLD_MODES).toEqual(['push', 'over', 'off'])
  for (const mode of FOLD_MODES) expect(foldModeOf(mode)).toBe(mode)
  for (const other of [undefined, null, '', 'OVER', 'on', true, 1]) {
    expect(foldModeOf(other)).toBe('push')
    expect(isFoldMode(other)).toBe(false)
  }
})
