// The PDF viewer's geometry (models/pdf-view.ts, #176): how the pages fit, what the zoom bar says,
// how sharp a page's pixels can be, the point that stays put through a zoom, the page on show and
// the pages worth drawing.
import { describe, expect, test } from 'bun:test'
import {
  cssScale,
  FIT_MAX,
  fitZoom,
  PAGE_PAD,
  type PagePlace,
  PRINTED,
  pageAt,
  pagesToDraw,
  pdfLimits,
  pdfZoomState,
  pixelRatio,
  pointOn,
  scrollFor,
} from '../../web/src/models/pdf-view.ts'

const A4 = { w: 595, h: 842 }

describe('the PDF viewer’s geometry', () => {
  test('pages fit the width, up to half again their printed size', () => {
    // A phone: an A4 page a little under half its printed size.
    const phone = fitZoom(A4, 390)
    expect(cssScale(phone) * A4.w).toBeCloseTo(390 - 2 * PAGE_PAD, 5)
    expect(phone).toBeCloseTo(0.4513, 3)
    // A wide window keeps margins.
    expect(fitZoom(A4, 3000)).toBe(FIT_MAX)
    // Not laid out yet: something small, never nothing.
    expect(fitZoom(A4, 0)).toBeGreaterThan(0)
  })

  test('the zoom bar: in from fit to 100%, or to twice fit when that is near 100% already', () => {
    expect(pdfZoomState(0.45, 0.45)).toEqual({ s: 0.45, fit: true, to: 1 })
    expect(pdfZoomState(1, 0.45)).toEqual({ s: 1, fit: false, to: 1 })
    expect(pdfZoomState(1.2, 1.2)).toEqual({ s: 1.2, fit: true, to: 2.4 })
    expect(pdfLimits(0.45)).toEqual({ fit: 0.45, max: 4 })
    expect(pdfLimits(1.5)).toEqual({ fit: 1.5, max: 6 })
    expect(PRINTED).toBeCloseTo(4 / 3, 10)
  })

  test('a page as sharp as the screen, unless that is more pixels than a canvas should hold', () => {
    expect(pixelRatio({ w: 800, h: 1100 }, 2, 16_000_000)).toBe(2)
    const big = pixelRatio({ w: 3200, h: 4500 }, 3, 5_000_000)
    expect(3200 * 4500 * big * big).toBeCloseTo(5_000_000, -2)
    expect(pixelRatio({ w: 800, h: 1100 }, 0, 16_000_000)).toBe(1)
  })

  const places: PagePlace[] = [
    { left: 16, top: 16, width: 400, height: 560 },
    { left: 16, top: 588, width: 400, height: 560 },
    { left: 66, top: 1160, width: 300, height: 200 },
  ]

  test('the point under the fingers stays there through a zoom', () => {
    const at = { x: 120, y: 300 }
    const scroll = { left: 0, top: 500 }
    const point = pointOn(places, { x: scroll.left + at.x, y: scroll.top + at.y })
    expect(point.page).toBe(1)
    expect(point.x).toBeCloseTo((120 - 16) / 400, 10)
    expect(point.y).toBeCloseTo((800 - 588) / 560, 10)
    // Twice the size: the pages laid out anew, the same point of page 2 under the same spot.
    const twice = places.map((p, i) => ({
      left: 16,
      top: 16 + i * (1120 + 12),
      width: p.width * 2,
      height: p.height * 2,
    }))
    const to = scrollFor(point, twice, at)
    const back = pointOn(twice, { x: to.left + at.x, y: to.top + at.y })
    expect(back.page).toBe(1)
    expect(back.x).toBeCloseTo(point.x, 10)
    expect(back.y).toBeCloseTo(point.y, 10)
    // Between the pages or past the last: held to the nearest one.
    expect(pointOn(places, { x: 0, y: 0 })).toEqual({ page: 0, x: 0, y: 0 })
    expect(pointOn(places, { x: 9999, y: 9999 })).toEqual({ page: 2, x: 1, y: 1 })
  })

  test('the page on show is the one across a third of the way down', () => {
    expect(pageAt(places, 0, 600)).toBe(1)
    expect(pageAt(places, 400, 600)).toBe(2)
    expect(pageAt(places, 5000, 600)).toBe(3)
    expect(pageAt([], 0, 600)).toBe(1)
  })

  test('the pages drawn: those near the view and one either side, the middle first', () => {
    expect(pagesToDraw([4, 5], 10, 5)).toEqual([5, 4, 6, 3])
    expect(pagesToDraw([0], 3, 0)).toEqual([0, 1])
    expect(pagesToDraw([], 3, 0)).toEqual([])
  })
})
