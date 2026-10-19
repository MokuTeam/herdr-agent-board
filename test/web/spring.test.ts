// The springs and gesture helpers every motion of the board uses. The values are pinned from the
// old web/spring.js (same constructor defaults, same integration steps).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { project, reducedMotion, rubberband, Spring, velocityOf } from '../../web/src/models/spring.ts'

// Bun has no animation frames: `to()` only asks for one; the tests step the springs themselves.
// The id it gets back is 0, so the shared frame loop never waits on a frame that will not come
// (test files after this one run their springs on a fake world's frames). The springs left
// moving here are stopped, so none is stepped by those frames.
const RAF = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
const left: Spring[] = []
beforeAll(() => {
  globalThis.requestAnimationFrame = () => 0
})
afterAll(() => {
  for (const spring of left) spring.stop()
  if (RAF) Object.defineProperty(globalThis, 'requestAnimationFrame', RAF)
  else Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
})

/** Steps a spring at 60 fps until it rests; every value it went through. */
function run(spring: Spring, limit = 1000): number[] {
  const values: number[] = []
  while (spring.moving && values.length < limit) {
    spring.step(1 / 60)
    values.push(spring.value)
  }
  return values
}

describe('Spring', () => {
  test('critically damped (damping 1) it settles on the target without overshoot, then rests', () => {
    const rests: number[] = []
    const spring = new Spring({ value: 0, damping: 1, response: 0.42, precision: 0.2, onRest: v => rests.push(v) })
    spring.to(100)
    expect(spring.moving).toBe(true)
    const values = run(spring)
    expect(values.length).toBe(37)
    expect(Math.max(...values)).toBe(100)
    expect(values.every((v, i) => i === 0 || v >= (values[i - 1] ?? 0))).toBe(true)
    expect([spring.value, spring.velocity, spring.moving]).toEqual([100, 0, false])
    expect(rests).toEqual([100])
  })

  test('the same integration as before: stiffness, friction and the first frames', () => {
    const spring = new Spring({ value: 0, damping: 1, response: 0.35 })
    left.push(spring)
    expect(spring.stiffness).toBeCloseTo(322.27279677026473, 10)
    expect(spring.friction).toBeCloseTo(35.90391604102621, 10)
    spring.to(10)
    const first = [0, 1, 2].map(() => {
      spring.step(1 / 60)
      return spring.value
    })
    expect(first[0]).toBeCloseTo(0.4777304753849156, 10)
    expect(first[1]).toBeCloseTo(1.4019949904572317, 10)
    expect(first[2]).toBeCloseTo(2.4943313609706146, 10)
  })

  test('below 1 it bounces past the target', () => {
    const spring = new Spring({ value: 0, damping: 0.5, response: 0.35 })
    left.push(spring)
    spring.to(100)
    expect(Math.max(...run(spring, 60))).toBeCloseTo(115.548063661892, 8)
  })

  test('set jumps without motion and reports it; a retarget keeps the velocity it is given', () => {
    const updates: number[] = []
    const spring = new Spring({ onUpdate: v => updates.push(v) })
    spring.set(42)
    expect([spring.value, spring.target, spring.velocity, spring.moving]).toEqual([42, 42, 0, false])
    expect(updates).toEqual([42])
    spring.to(0, { velocity: -300, damping: 0.8, response: 0.2 })
    expect([spring.velocity, spring.damping, spring.response, spring.moving]).toEqual([-300, 0.8, 0.2, true])
    spring.stop()
    expect(spring.moving).toBe(false)
  })

  test('outside a browser reduced motion reads as off', () => {
    expect(reducedMotion.matches).toBe(false)
  })
})

test('rubberband: the further past the edge, the less it follows', () => {
  expect(rubberband(50, 300)).toBeCloseTo(25.19083969465649, 12)
  expect(rubberband(-120, 400)).toBeCloseTo(-56.65236051502146, 12)
  expect(rubberband(10, 200, 0.3)).toBeCloseTo(2.955665024630542, 12)
  expect(rubberband(0, 300)).toBe(0)
})

test('project: where a flick comes to rest', () => {
  expect(project(1200)).toBeCloseTo(598.7999999999995, 9)
  expect(project(-800, 0.99)).toBeCloseTo(-79.19999999999993, 9)
})

test('velocityOf: px/s over the last ~100 ms of samples', () => {
  const samples = [
    { x: 0, y: 0, t: 0 },
    { x: 10, y: 5, t: 50 },
    { x: 30, y: 10, t: 120 },
    { x: 60, y: 20, t: 160 },
  ]
  expect(velocityOf(samples)).toEqual({ x: 750, y: 250 })
  expect(velocityOf([])).toEqual({ x: 0, y: 0 })
  expect(velocityOf([{ x: 5, y: 5, t: 10 }])).toEqual({ x: 0, y: 0 })
  expect(
    velocityOf([
      { x: 0, y: 0, t: 10 },
      { x: 9, y: 9, t: 10 },
    ]),
  ).toEqual({ x: 0, y: 0 })
})
