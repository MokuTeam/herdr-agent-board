// The PDF viewer's geometry without the DOM (viewers/pdf.ts): the scale at which the pages fit
// the width, the zoom as the footer shows it (100% is the page's printed size), how sharp a
// page's pixels can be, where the view goes so that the point under the fingers or the pointer
// stays there after a zoom, which page is on show, which pages are near enough to draw, and
// what went wrong reading one.
import type { ZoomLimits, ZoomState } from './zoom.ts'
import { atFit, zoomInScale } from './zoom.ts'

export type PdfFailure = 'password' | 'broken' | 'other'

/** What went wrong reading a PDF, by the name of PDF.js's exception. */
export function failureOf(err: unknown): PdfFailure {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'PasswordException' ? 'password' : name === 'InvalidPDFException' ? 'broken' : 'other'
}

/** CSS pixels to a PDF point at 100%: PDF's 72 to the inch on the web's 96. */
export const PRINTED = 96 / 72
/** Room around the pages and between them, in CSS pixels (the stylesheet's .ql-pdf-pages). */
export const PAGE_PAD = 16
/** A fitted page is at most this much larger than printed: a wide window keeps margins. */
export const FIT_MAX = 1.5

export interface Box {
  w: number
  h: number
}

/** The zoom (printed size = 1) at which a page `page` points wide fits `room` CSS pixels. */
export const fitZoom = (page: Box, room: number): number =>
  Math.max(0.05, Math.min(FIT_MAX, (room - 2 * PAGE_PAD) / (page.w * PRINTED)))

/** From fit (never smaller: the pages fill the width) to four times it, or 400%. */
export const pdfLimits = (fit: number): ZoomLimits => ({ fit, max: Math.max(4, fit * 4) })

/** What the footer's zoom bar shows of a zoom `s` with the pages fitting at `fit` (files.ts zoomBar). */
export const pdfZoomState = (s: number, fit: number): ZoomState => {
  const lim = pdfLimits(fit)
  return { s, fit: atFit(s, fit), to: zoomInScale(lim) }
}

/** CSS pixels to a PDF point at zoom `s`. */
export const cssScale = (s: number): number => s * PRINTED

/**
 * Device pixels to a CSS pixel for a page `css` big: the screen's own, or fewer when that would
 * take more than `maxPixels` (a phone's canvas has a ceiling, and memory).
 */
export function pixelRatio(css: Box, dpr: number, maxPixels: number): number {
  const area = Math.max(1, css.w * css.h)
  return Math.max(0.25, Math.min(dpr || 1, Math.sqrt(maxPixels / area)))
}

/** A page's place in the scroller's content, in CSS pixels. */
export interface PagePlace {
  left: number
  top: number
  width: number
  height: number
}

/** A point of a page: which page, and where on it (0 to 1 each way). */
export interface PagePoint {
  page: number
  x: number
  y: number
}

/** The point of the pages under `at` (in the content's coordinates): on the nearest page, held to it. */
export function pointOn(places: PagePlace[], at: { x: number; y: number }): PagePoint {
  let page = 0
  for (let i = 0; i < places.length; i++) {
    if ((places[i] as PagePlace).top <= at.y) page = i
    else break
  }
  const p = places[page] ?? { left: 0, top: 0, width: 1, height: 1 }
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  return { page, x: clamp01((at.x - p.left) / (p.width || 1)), y: clamp01((at.y - p.top) / (p.height || 1)) }
}

/** The scroll that puts the page point `point` at `at` in the scroller's view, after a zoom laid the pages out anew. */
export function scrollFor(point: PagePoint, places: PagePlace[], at: { x: number; y: number }) {
  const p = places[point.page] ?? { left: 0, top: 0, width: 0, height: 0 }
  return { left: p.left + point.x * p.width - at.x, top: p.top + point.y * p.height - at.y }
}

/** The page on show: the one across the view's line a third of the way down (1-based). */
export function pageAt(places: PagePlace[], scrollTop: number, viewHeight: number): number {
  const line = scrollTop + viewHeight / 3
  let lo = 0
  let hi = places.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((places[mid] as PagePlace).top <= line) lo = mid
    else hi = mid - 1
  }
  return Math.max(0, lo) + 1
}

/**
 * The pages to keep drawn, by index: those near the view (`near`, as IntersectionObserver says)
 * and the next and previous one, nearest the middle of the view first.
 */
export function pagesToDraw(near: Iterable<number>, count: number, middle: number): number[] {
  const want = new Set<number>()
  for (const i of near) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < count) want.add(j)
  return [...want].sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b)
}
