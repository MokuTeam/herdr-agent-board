// The live signs' pace (web/src/models/pace.ts, #109): an endless animation is held at a frame of its
// own clock, PACE_FPS of them a second, while a finite one (a transition, a card appearing) keeps the
// display's rate; the timer runs only while there is something endless on a page on show.
import { describe, expect, test } from 'bun:test'
import { endless, frameAt, PACE_FPS, type Paceable, startPace, tick } from '../../web/src/models/pace.ts'

const FRAME = 1000 / PACE_FPS

class Fake implements Paceable {
  currentTime: CSSNumberish | null
  playState: AnimationPlayState = 'running'
  readonly effect: AnimationEffect
  constructor(iterations: number, time = 0) {
    this.currentTime = time
    this.effect = { getTiming: () => ({ iterations }) } as AnimationEffect
  }
  pause() {
    this.playState = 'paused'
  }
}

describe('a tick', () => {
  test('holds every endless animation at the frame of its clock, which goes on from where it was', () => {
    const pulse = new Fake(Infinity, 500)
    const spin = new Fake(Infinity, 0)
    const starts = new WeakMap<Paceable, number>()
    expect(tick([pulse, spin], 10_000, starts)).toBe(true)
    expect([pulse.playState, pulse.currentTime, spin.playState, spin.currentTime]).toEqual([
      'paused',
      frameAt(500),
      'paused',
      0,
    ])
    expect(tick([pulse, spin], 10_100, starts)).toBe(true)
    expect([pulse.currentTime, spin.currentTime]).toEqual([frameAt(600), frameAt(100)])
    expect(frameAt(100)).toBeCloseTo(FRAME)
    expect(frameAt(600)).toBeCloseTo(9 * FRAME)
  })

  test('leaves what ends alone: a transition, a card appearing', () => {
    const transition = new Fake(1, 40)
    expect(endless(transition)).toBe(false)
    expect(tick([transition], 10_000, new WeakMap())).toBe(false)
    expect([transition.playState, transition.currentTime]).toEqual(['running', 40])
  })

  test('the pace is a low one: a frame in 66 ms, not the display’s 7', () => {
    expect(PACE_FPS).toBe(15)
    expect(frameAt(FRAME - 1)).toBe(0)
  })
})

/** A document as the pace sees it: its animations, its clock, shown or hidden, and its events. */
class Doc extends EventTarget {
  hidden = false
  timeline = { currentTime: 0 as number | null }
  animations: Fake[] = []
  asked = 0
  getAnimations(): Fake[] {
    this.asked++
    return this.animations
  }
  show(hidden: boolean) {
    this.hidden = hidden
    this.dispatchEvent(new Event('visibilitychange'))
  }
}

describe('the page’s pace', () => {
  test('starts holding what loops at once, ticks while it is there, and rests when it is gone', async () => {
    const doc = new Doc()
    const pulse = new Fake(Infinity)
    doc.animations = [pulse]
    const stop = startPace(doc as unknown as Document)
    expect(pulse.playState).toBe('paused')
    doc.timeline.currentTime = 1000
    await Bun.sleep(3 * FRAME)
    expect(pulse.currentTime).toBe(frameAt(1000))
    doc.animations = []
    await Bun.sleep(2 * FRAME)
    const asked = doc.asked
    await Bun.sleep(3 * FRAME)
    expect(doc.asked).toBe(asked)
    stop()
  })

  test('a loop that starts wakes it; a hidden page is left alone until it shows again; stopped, it is deaf', () => {
    const doc = new Doc()
    const stop = startPace(doc as unknown as Document)
    const spin = new Fake(Infinity)
    doc.animations = [spin]
    doc.dispatchEvent(new Event('animationstart'))
    expect(spin.playState).toBe('paused')

    doc.show(true)
    const later = new Fake(Infinity)
    doc.animations = [later]
    doc.dispatchEvent(new Event('animationstart'))
    expect(later.playState).toBe('running')
    doc.show(false)
    expect(later.playState).toBe('paused')

    stop()
    const after = new Fake(Infinity)
    doc.animations = [after]
    doc.dispatchEvent(new Event('animationstart'))
    doc.show(false)
    expect(after.playState).toBe('running')
  })
})
