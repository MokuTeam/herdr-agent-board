import { expect, onTestFinished, test } from 'bun:test'
import { knobMs, pace, pause } from '../../src/adapters/pacing.ts'

// The tests' knobs (#358): unset, as in production, and anything that is not one, every wait is
// as written.
/** A setter of `name` for this test; the value it had comes back after it. */
function envOf(name: string): (value: string | undefined) => void {
  const was = process.env[name]
  const set = (value: string | undefined): void => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  onTestFinished(() => set(was))
  return set
}

test('BOARD_TEST_PACE: a factor above 0 and at most 1; unset or anything else is 1', () => {
  const cases: [string | undefined, number][] = [
    [undefined, 1],
    ['', 1],
    ['0', 1],
    ['-1', 1],
    ['2', 1],
    ['1.5', 1],
    ['x', 1],
    ['Infinity', 1],
    ['1', 1],
    ['0.5', 0.5],
    ['0.02', 0.02],
  ]
  const set = envOf('BOARD_TEST_PACE')
  expect(
    cases.map(([value]) => {
      set(value)
      return pace()
    }),
  ).toEqual(cases.map(([, want]) => want))
})

test('a knob: a whole number of ms above 0 from its variable; unset or anything else is the wait as written', () => {
  const cases: [string | undefined, number][] = [
    [undefined, 2000],
    ['', 2000],
    ['0', 2000],
    ['-300', 2000],
    ['300.5', 2000],
    ['3e2', 300],
    ['x', 2000],
    ['300', 300],
  ]
  const set = envOf('BOARD_TEST_KNOB_MS')
  expect(
    cases.map(([value]) => {
      set(value)
      return knobMs('BOARD_TEST_KNOB_MS', 2000)
    }),
  ).toEqual(cases.map(([, want]) => want))
})

test('pause: the wait as written when unset, its fraction when paced', async () => {
  const set = envOf('BOARD_TEST_PACE')
  set(undefined)
  let t = performance.now()
  await pause(60)
  expect(performance.now() - t).toBeGreaterThanOrEqual(55)
  set('0.01')
  t = performance.now()
  await pause(5000)
  expect(performance.now() - t).toBeLessThan(1000)
})
