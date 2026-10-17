// The side panel's gesture rules and chrome, pulled out of web/panel.js: every expectation here is
// what the old Panel class computed inline for the same input.
import { describe, expect, test } from 'bun:test'
import type { PanelLayout } from '../../web/src/models/panel-layout.ts'
import {
  alongOut,
  anchorScroll,
  draggedSize,
  EDGES,
  edgeChrome,
  floatResizeVelocity,
  foldVelocity,
  growSpeed,
  headDrag,
  keepsAnchor,
  menuPlacement,
  menuStep,
  outOffset,
  panelChrome,
  panelStyle,
  primaryEdge,
  resetLayout,
  resizeVelocity,
  restPlace,
  roomValue,
  roomWanted,
  thrownLayout,
} from '../../web/src/models/panel-motion.ts'
import { rubberband } from '../../web/src/models/spring.ts'

const vp = { w: 1600, h: 1000 }
const fresh: PanelLayout = { dock: 'right', side: null, bottom: null, float: null }

describe('a press on the head, once it has moved 6 px', () => {
  test('out along its edge flicks it away, any other way pulls it loose', () => {
    expect(headDrag('right', 3, 3)).toBeNull() // 4.2 px: still a press
    expect(headDrag('right', 10, 0)).toBe('dismiss')
    expect(headDrag('right', -10, 0)).toBe('pull')
    expect(headDrag('right', 5, 5)).toBe('dismiss') // along = across: out wins
    expect(headDrag('right', 4, 5)).toBe('pull')
    expect(headDrag('right', 0, 10)).toBe('pull')
    expect(headDrag('left', -10, 0)).toBe('dismiss')
    expect(headDrag('left', 10, 0)).toBe('pull')
    expect(headDrag('bottom', 0, 10)).toBe('dismiss')
    expect(headDrag('bottom', 0, -10)).toBe('pull')
  })
  test('a floating panel moves; a phone sheet only flicks', () => {
    expect(headDrag('float', -6, 0)).toBe('move')
    expect(headDrag('float', 2, 2)).toBeNull()
    expect(headDrag('mobile', -10, 0)).toBe('dismiss')
    expect(headDrag('mobile', 0, -10)).toBe('dismiss')
  })
})

test('flicked out it follows 1:1; pushed back past its place it resists', () => {
  expect(outOffset(40, 560)).toBe(40)
  expect(outOffset(0, 560)).toBe(0)
  expect(outOffset(-40, 560)).toBe(rubberband(-40, 560))
  expect(outOffset(-40, 560)).toBeGreaterThan(-40)
})

test('the pointer’s speed along the way out, carried as a velocity', () => {
  const flat = ({ along, velocity }: ReturnType<typeof alongOut>) => [along, velocity.x + 0, velocity.y + 0]
  expect(flat(alongOut('right', { x: 900, y: 300 }))).toEqual([900, 900, 0])
  expect(flat(alongOut('left', { x: -900, y: 300 }))).toEqual([900, -900, 0])
  expect(flat(alongOut('bottom', { x: 50, y: -400 }))).toEqual([-400, 0, -400])
  expect(flat(alongOut('mobile', { x: 700, y: 30 }))).toEqual([700, 700, 0])
})

describe('a docked panel’s edge', () => {
  const at = { x: 1028, y: 12, w: 560, h: 976 }
  test('asks for the size the drag says, towards the board', () => {
    expect(draggedSize('right', at, -40, 9)).toBe(600)
    expect(draggedSize('left', at, 40, 9)).toBe(600)
    expect(draggedSize('bottom', { ...at, h: 420 }, 9, -30)).toBe(450)
  })
  test('lets go with the speed it grows at', () => {
    expect(growSpeed('right', { x: -300, y: 10 })).toBe(300)
    expect(growSpeed('left', { x: 300, y: 10 })).toBe(300)
    expect(growSpeed('bottom', { x: 10, y: -200 })).toBe(200)
    expect(resizeVelocity('right', 300)).toEqual({ x: -300, w: 300 })
    expect(resizeVelocity('left', 300)).toEqual({ w: 300 })
    expect(resizeVelocity('bottom', 200)).toEqual({ y: -200, h: 200 })
  })
  test('folds away out its own side at the speed it was flung', () => {
    expect(foldVelocity('right', -800)).toEqual({ x: 800, y: 0 })
    expect(foldVelocity('left', -800)).toEqual({ x: -800, y: 0 })
    expect(foldVelocity('bottom', -800)).toEqual({ x: 0, y: 800 })
  })
})

test('a floating panel’s edges hand the release speed to the sides that moved', () => {
  const v = { x: 100, y: 200 }
  expect(floatResizeVelocity('se', v)).toEqual({ x: 0, y: 0, w: 100, h: 200 })
  expect(floatResizeVelocity('nw', v)).toEqual({ x: 100, y: 200, w: -100, h: -200 })
  expect(floatResizeVelocity('e', v)).toEqual({ x: 0, y: 0, w: 100, h: 0 })
  expect(floatResizeVelocity('n', v)).toEqual({ x: 0, y: 200, w: 0, h: -200 })
})

test('default size: a docked panel forgets its own size, a floating one its size and spot', () => {
  const mine: PanelLayout = { dock: 'right', side: 700, bottom: 400, float: { x: 1, y: 2, w: 500, h: 600 } }
  expect(resetLayout(mine)).toEqual({ ...mine, side: null })
  expect(resetLayout({ ...mine, dock: 'left' })).toEqual({ ...mine, dock: 'left', side: null })
  expect(resetLayout({ ...mine, dock: 'bottom' })).toEqual({ ...mine, dock: 'bottom', bottom: null })
  expect(resetLayout({ ...mine, dock: 'float' })).toEqual({ ...mine, dock: 'float', float: null })
})

test('let go loose: docks where thrown, else floats where it glides to', () => {
  const loose: PanelLayout = { ...fresh, dock: 'float', side: 600 }
  const at = { x: 500, y: 300, w: 480, h: 680 }
  expect(thrownLayout(loose, 'left', at, { x: -2000, y: 0 }, vp)).toEqual({ ...loose, dock: 'left' })
  expect(thrownLayout(loose, null, at, { x: 0, y: 0 }, vp)).toEqual({ ...loose, float: at })
  const glide = thrownLayout(loose, null, at, { x: 1000, y: 0 }, vp).float
  expect(glide?.x).toBeGreaterThan(500)
  expect(glide?.y).toBe(300)
})

describe('where a panel rests and where it comes from', () => {
  test('docked: its rectangle, coming in from past its edge', () => {
    expect(restPlace('right', fresh, vp, false, 0, { w: 0, h: 0 })).toEqual({ x: 1028, y: 12, w: 560, h: 976, p: 1 })
    expect(restPlace('right', fresh, vp, true, 0, { w: 0, h: 0 })).toEqual({ x: 1620, y: 12, w: 560, h: 976, p: 1 })
  })
  test('floating: in place, faded out', () => {
    const float = { ...fresh, dock: 'float' as const, float: { x: 300, y: 200, w: 500, h: 600 } }
    expect(restPlace('float', float, vp, true, 0, { w: 0, h: 0 })).toEqual({ x: 300, y: 200, w: 500, h: 600, p: 0 })
  })
  test('on a phone: only across, by its own width, keeping its size', () => {
    expect(restPlace('mobile', fresh, vp, true, 380, { w: 7, h: 9 })).toEqual({ x: 412, y: 0, w: 7, h: 9, p: 1 })
    expect(restPlace('mobile', fresh, vp, false, 380, { w: 7, h: 9 })).toEqual({ x: 0, y: 0, w: 7, h: 9, p: 1 })
  })
})

describe('the panel’s inline style', () => {
  test('on whole device pixels; scaled and faded while a floating one comes and goes', () => {
    expect(panelStyle('right', { x: 1027.6, y: 12, w: 560.2, h: 976, p: 1 }, 1)).toEqual({
      width: '560px',
      height: '976px',
      transform: 'translate3d(1028px, 12px, 0)',
      opacity: '',
    })
    expect(panelStyle('float', { x: 300, y: 200, w: 500, h: 600, p: 0.5 }, 1)).toEqual({
      width: '500px',
      height: '600px',
      transform: 'translate3d(300px, 200px, 0) scale(0.97)',
      opacity: '0.8',
    })
    expect(panelStyle('float', { x: 300, y: 200, w: 500, h: 600, p: -0.1 }, 1).opacity).toBe('0')
    expect(panelStyle('float', { x: 300, y: 200, w: 500, h: 600, p: -0.1 }, 1).transform).toBe(
      'translate3d(300px, 200px, 0) scale(0.94)',
    )
  })
  test('a phone sheet only slides', () => {
    expect(panelStyle('mobile', { x: 40.3, y: 9, w: 9, h: 9, p: 1 }, 2)).toEqual({
      transform: 'translate3d(40.5px, 0, 0)',
    })
  })
})

describe('the handles and the place button', () => {
  test('the edge towards the board resizes; a floating one by its corner; none on a phone', () => {
    expect(primaryEdge('right')).toBe('w')
    expect(primaryEdge('left')).toBe('e')
    expect(primaryEdge('bottom')).toBe('n')
    expect(primaryEdge('float')).toBe('se')
    expect(primaryEdge('mobile')).toBeNull()
    expect(EDGES).toEqual(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'])
  })
  test('a docked panel’s edge is a separator with its size and limits', () => {
    const chrome = panelChrome('right', { ...fresh, side: 700 }, vp)
    expect(chrome).toEqual({
      mode: 'right',
      glyph: 'right',
      separator: { orientation: 'vertical', min: 360, max: 1200, now: 700 },
    })
    expect(edgeChrome('w', chrome)).toEqual({ on: true, separator: chrome.separator })
    expect(edgeChrome('e', chrome)).toEqual({ on: false, separator: null })
    expect(panelChrome('bottom', fresh, { w: 1000, h: 801 }).separator).toEqual({
      orientation: 'horizontal',
      min: 320,
      max: 597,
      now: 336,
    })
  })
  test('a floating one’s corner is no separator; the button shows the viewer’s place, not the painted one', () => {
    const chrome = panelChrome('float', { ...fresh, dock: 'float' }, vp)
    expect(chrome.separator).toBeNull()
    expect(edgeChrome('se', chrome)).toEqual({ on: true, separator: null })
    const phone = panelChrome('mobile', { ...fresh, dock: 'bottom' }, vp)
    expect(phone).toEqual({ mode: 'mobile', glyph: 'bottom', separator: null })
    expect(EDGES.map(edge => edgeChrome(edge, phone).on)).toEqual(EDGES.map(() => false))
  })
})

describe('the place menu', () => {
  test('under its button, right-aligned with it, inside the window; above it when there is no room below', () => {
    const button = { left: 1500, right: 1530, top: 20, bottom: 50, width: 30, height: 30 }
    expect(menuPlacement(button, { width: 210, height: 180 }, vp)).toEqual({
      left: 1320,
      top: 56,
      origin: '195px 0px',
    })
    const low = { ...button, top: 900, bottom: 930 }
    expect(menuPlacement(low, { width: 210, height: 180 }, vp)).toEqual({
      left: 1320,
      top: 714,
      origin: '195px 180px',
    })
    const corner = { left: 0, right: 20, top: 5, bottom: 25, width: 20, height: 20 }
    expect(menuPlacement(corner, { width: 210, height: 180 }, vp).left).toBe(8)
  })
  test('arrows walk round, Home and End jump, other keys do nothing', () => {
    expect(menuStep('ArrowDown', 0, 5)).toBe(1)
    expect(menuStep('ArrowDown', 4, 5)).toBe(0)
    expect(menuStep('ArrowUp', 0, 5)).toBe(4)
    expect(menuStep('ArrowUp', -1, 5)).toBe(3) // nothing focused: as the old modulo did
    expect(menuStep('Home', 3, 5)).toBe(0)
    expect(menuStep('End', 0, 5)).toBe(4)
    expect(menuStep('a', 0, 5)).toBeNull()
  })
})

describe('the board makes room', () => {
  test('for an open docked panel; none on a phone, when closed or floating', () => {
    expect(roomWanted(true, false, fresh, { w: 1800, h: 1000 })).toEqual({ left: 0, right: 572, bottom: 0 })
    expect(roomWanted(false, false, fresh, { w: 1800, h: 1000 })).toEqual({ left: 0, right: 0, bottom: 0 })
    expect(roomWanted(true, true, fresh, { w: 1800, h: 1000 })).toEqual({ left: 0, right: 0, bottom: 0 })
    expect(roomValue(571.66)).toBe('571.7px')
  })
  test('the card in the panel keeps its place on screen, clear of a panel at the bottom', () => {
    const card = { top: 300, bottom: 400, height: 100 }
    expect(keepsAnchor(card, 120, 1000, 0)).toBe(true)
    expect(keepsAnchor({ ...card, height: 0 }, 120, 1000, 0)).toBe(false)
    expect(keepsAnchor({ top: 20, bottom: 110, height: 90 }, 120, 1000, 0)).toBe(false) // under the toolbar
    expect(keepsAnchor({ top: 700, bottom: 800, height: 100 }, 120, 1000, 320)).toBe(false) // under the panel
    // Kept at y 300 while it moved to 340: scroll back by 40.
    expect(anchorScroll(300, { ...card, top: 340 }, 120, 1000, 0)).toBe(40)
    expect(anchorScroll(300, { ...card, top: 300.4 }, 120, 1000, 0)).toBe(0)
    // A panel coming up from the bottom pushes it up to stay clear.
    expect(anchorScroll(800, { top: 800, bottom: 900, height: 100 }, 120, 1000, 420)).toBe(336)
    // Never above the toolbar's bottom + 8.
    expect(anchorScroll(100, { top: 100, bottom: 200, height: 100 }, 120, 1000, 0)).toBe(-28)
  })
})
