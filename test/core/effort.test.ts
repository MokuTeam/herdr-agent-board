import { expect, test } from 'bun:test'
import { effortFromScreen, modelFromScreen } from '../../src/core/effort.ts'

test('the latest /effort line on screen says the session’s effort now', () => {
  expect(effortFromScreen('Set effort level to medium (this session only): …')).toBe('medium')
  expect(
    effortFromScreen(
      'Set effort level to high (this session only): …\nmore\nSet effort level to max (this session only): …',
    ),
  ).toBe('max')
  expect(effortFromScreen('nothing about it')).toBe('')
  expect(effortFromScreen(undefined)).toBe('')
})

test('the latest /model line on screen says the session’s model now', () => {
  expect(modelFromScreen('Set model to Sonnet 5.5 and saved as your default for new sessions')).toBe('Sonnet 5.5')
  expect(
    modelFromScreen(
      'Set model to Opus 4.5 and saved as your default for new sessions\nmore\nSet model to Sonnet 5.5 (this session only): …',
    ),
  ).toBe('Sonnet 5.5')
  expect(modelFromScreen('nothing about it')).toBe('')
})
