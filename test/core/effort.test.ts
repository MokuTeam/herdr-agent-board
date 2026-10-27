import { expect, test } from 'bun:test'
import { changesMeter, effortFromScreen, meterReads, modelFromScreen } from '../../src/core/effort.ts'

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

test('the meter reads only an awake Claude with a pane: a sleeper may keep a pane that holds a shell', () => {
  expect(meterReads({ agent: 'claude', pane: 'p1' })).toBe(true)
  expect(meterReads({ agent: 'claude', pane: 'p1', sleeping: true })).toBe(false)
  expect(meterReads({ agent: 'claude', pane: null })).toBe(false)
  for (const agent of ['codex', 'pi', 'agy', undefined]) expect(meterReads({ agent, pane: 'p1' })).toBe(false)
})

test("a message changes the meter when it is Claude's own /model or /effort, nothing else", () => {
  for (const text of ['/model', '/effort max', '  /model sonnet ', '/EFFORT high'])
    expect(changesMeter(text)).toBe(true)
  for (const text of ['/models', '/effortless', 'set /model', 'model', '', undefined])
    expect(changesMeter(text)).toBe(false)
})
