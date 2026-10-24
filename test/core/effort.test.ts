import { expect, test } from 'bun:test'
import { effortFromScreen } from '../../src/core/effort.ts'

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
