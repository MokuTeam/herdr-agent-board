// A folded card unfolding (#61): what keeps it open, which tap only unfolds, and its frames on the way.
import { describe, expect, test } from 'bun:test'
import { foldFrame, hovers, tapUnfolds, wantsOpen } from '../../web/src/models/fold.ts'

describe('fold', () => {
  test('open while pointed at, focused by the keyboard or tapped once; folded with none of them', () => {
    expect(wantsOpen({ hover: false, focus: false, touch: false })).toBe(false)
    expect(wantsOpen({ hover: true, focus: false, touch: false })).toBe(true)
    expect(wantsOpen({ hover: false, focus: true, touch: false })).toBe(true)
    expect(wantsOpen({ hover: false, focus: false, touch: true })).toBe(true)
  })

  test('a mouse or a pen hovers, a finger does not', () => {
    expect(hovers('mouse')).toBe(true)
    expect(hovers('pen')).toBe(true)
    expect(hovers('touch')).toBe(false)
  })

  test('the first tap on a folded card unfolds it; the next one, a button or a mouse click go on as before', () => {
    expect(tapUnfolds({ pointerType: 'touch', open: false, onControl: false })).toBe(true)
    expect(tapUnfolds({ pointerType: 'touch', open: true, onControl: false })).toBe(false)
    expect(tapUnfolds({ pointerType: 'touch', open: false, onControl: true })).toBe(false)
    expect(tapUnfolds({ pointerType: 'mouse', open: false, onControl: false })).toBe(false)
  })

  test('on its way the cards below stay put and the hidden lines fade in with the height', () => {
    expect(foldFrame(60, 60, 160)).toEqual({ height: 60, marginBottom: 0, opacity: 0 })
    expect(foldFrame(110, 60, 160)).toEqual({ height: 110, marginBottom: -50, opacity: 0.5 })
    expect(foldFrame(160, 60, 160)).toEqual({ height: 160, marginBottom: -100, opacity: 1 })
    // A spring a touch past either end, and nothing to unfold.
    expect(foldFrame(58, 60, 160).opacity).toBe(0)
    expect(foldFrame(162, 60, 160).opacity).toBe(1)
    expect(foldFrame(60, 60, 60)).toEqual({ height: 60, marginBottom: 0, opacity: 1 })
  })
})
