// The quick look's PDF viewer (#176): PDF.js draws the pages in the page itself, since Chrome on
// Android and the installed board draw no PDF in a frame. A script of its own, bundled apart from
// app.js (server/viewers.ts) and imported when a PDF is opened (components/files/Preview.tsx).
//
// The pages are laid out at once (at the first page's size until each is read) and drawn as they
// come near the view, at the screen's pixel density, with their text selectable over them (PDF.js's
// text layer); pages far away let go of their pixels. They fit the width. Ctrl+wheel or a trackpad
// pinch, two fingers on a phone, + − 0 and the footer's button zoom around the point under the
// pointer, the fingers or the middle: the drawn pages scale at once, and are laid out and drawn
// sharp again when the zoom rests; a pinch past fit or the largest zoom gives, and springs back.
// A plain wheel, a finger and the arrow and page keys scroll. Geometry: models/pdf-view.ts.
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
  TextLayer,
} from 'pdfjs-dist'
import type { ImageZoom, ZoomKey } from '../components/files/zoom.ts'
import {
  type Box,
  cssScale,
  failureOf,
  fitZoom,
  type PagePlace,
  type PagePoint,
  type PdfFailure,
  pageAt,
  pagesToDraw,
  pdfLimits,
  pdfZoomState,
  pixelRatio,
  pointOn,
  scrollFor,
} from '../models/pdf-view.ts'
import { reducedMotion, Spring } from '../models/spring.ts'
import { atFit, softScale, stepScale, wheelZoom, type ZoomState, zoomInScale } from '../models/zoom.ts'

export interface PdfOptions {
  /** The bytes, through the board's file route with its token. */
  url: string
  /** The file's size: a large one is read in ranges as the pages need them, not all at once. */
  size?: number | null | undefined
  /** PDF.js's worker, served beside the viewer. */
  worker: string
  /** Where PDF.js's decoders, character maps, fonts and color profiles are (a folder, with its slash). */
  assets: string
  /** The page on show, for the badge while scrolling: "3 of 12". */
  pageLabel: (n: number, total: number) => string
  onPages?: (count: number) => void
  onFail?: (why: PdfFailure, message: string) => void
}

export interface PdfViewer {
  /** Its zoom for the quick look's keys and footer: `onChange` hears every change of it. */
  zoom(onChange: (z: ZoomState) => void): ImageZoom
  destroy(): void
}

// Read in ranges past this size; below it, at once (fewer trips over a slow link).
const RANGES_FROM = 8 << 20
// A phone's canvas has a ceiling, and every page drawn holds its pixels.
const coarse = () => globalThis.matchMedia?.('(pointer: coarse)').matches ?? false
const SCROLL_KEYS: Record<string, (view: HTMLElement) => { top?: number; left?: number }> = {
  ArrowDown: () => ({ top: 48 }),
  ArrowUp: () => ({ top: -48 }),
  ArrowRight: () => ({ left: 48 }),
  ArrowLeft: () => ({ left: -48 }),
  PageDown: v => ({ top: v.clientHeight * 0.9 }),
  PageUp: v => ({ top: -v.clientHeight * 0.9 }),
  Home: v => ({ top: -v.scrollHeight }),
  End: v => ({ top: v.scrollHeight }),
}

interface Page {
  i: number
  el: HTMLDivElement
  /** Its own size in points, once read; until then the first page's. */
  box: Box | null
  proxy: PDFPageProxy | null
  /** The CSS scale its canvas is drawn at; 0 for none. */
  drawn: number
  canvas: HTMLCanvasElement | null
  text: TextLayer | null
  textEl: HTMLDivElement | null
  task: RenderTask | null
}

const div = (className: string): HTMLDivElement => {
  const el = document.createElement('div')
  el.className = className
  return el
}

export function mount(host: HTMLElement, opts: PdfOptions): PdfViewer {
  const scroller = div('ql-pdf-scroll')
  const sheet = div('ql-pdf-pages')
  const badge = div('ql-pdf-badge')
  badge.setAttribute('aria-hidden', 'true')
  scroller.append(sheet)
  host.replaceChildren(scroller, badge)
  const off = new AbortController()
  const listen = (target: EventTarget, type: string, fn: (e: never) => void, passive = true) =>
    target.addEventListener(type, fn as EventListener, { signal: off.signal, passive })

  GlobalWorkerOptions.workerSrc = opts.worker
  const ranges = (opts.size ?? 0) > RANGES_FROM
  const task = getDocument({
    url: opts.url,
    disableStream: ranges,
    disableAutoFetch: ranges,
    rangeChunkSize: 1 << 18,
    cMapUrl: `${opts.assets}cmaps/`,
    standardFontDataUrl: `${opts.assets}standard_fonts/`,
    wasmUrl: `${opts.assets}wasm/`,
    iccUrl: `${opts.assets}iccs/`,
  })
  const maxPixels = coarse() ? 5_000_000 : 16_000_000
  let doc: PDFDocumentProxy | null = null
  let pages: Page[] = []
  let first: Box = { w: 612, h: 792 }
  // The zoom the pages are laid out at (printed size = 1), the one they fit the width at, and
  // whether they follow the width as the window changes (until zoomed).
  let zoom = 1
  let fit = 1
  let fitted = true
  let destroyed = false
  let onZoom: ((z: ZoomState) => void) | null = null

  // ---------------------------------------------------------------- layout

  // The pages' places, measured once for each layout (a page sized, the window resized): a scroll
  // asks for them on every frame, and a long PDF has thousands of pages.
  let laidOut: PagePlace[] | null = null

  function size(p: Page): void {
    const box = p.box ?? first
    const scale = cssScale(zoom)
    p.el.style.width = `${Math.floor(box.w * scale)}px`
    p.el.style.height = `${Math.floor(box.h * scale)}px`
    p.el.style.setProperty('--total-scale-factor', String(scale))
    laidOut = null
  }

  /** The pages' places in the scroller's content (the sheet is their offset parent). */
  function places(): PagePlace[] {
    if (laidOut) return laidOut
    const x = sheet.offsetLeft
    const y = sheet.offsetTop
    laidOut = pages.map(({ el }) => ({
      left: x + el.offsetLeft,
      top: y + el.offsetTop,
      width: el.offsetWidth,
      height: el.offsetHeight,
    }))
    return laidOut
  }

  const middleOfView = () => ({ x: scroller.clientWidth / 2, y: scroller.clientHeight / 2 })

  // ---------------------------------------------------------------- zoom

  // A zoom under way: the page point that stays at `at` in the view, and the zoom drawn now.
  let held: { point: PagePoint; at: { x: number; y: number }; v: number } | null = null
  let rest: ReturnType<typeof setTimeout> | undefined
  const spring = new Spring({
    value: 1,
    damping: 1,
    response: 0.32,
    precision: 0.001,
    onUpdate: v => show(v),
    onRest: () => settle(),
  })

  function report(v = held?.v ?? zoom): void {
    if (doc) onZoom?.(pdfZoomState(v, fit))
  }

  /** The point under `at` held, or the one held already. */
  function hold(at: { x: number; y: number }): NonNullable<typeof held> {
    if (held) return held
    const content = { x: scroller.scrollLeft + at.x, y: scroller.scrollTop + at.y }
    held = { point: pointOn(places(), content), at, v: zoom }
    return held
  }

  /** A new gesture at `at`: a zoom under way rests first, where it is. */
  function begin(at: { x: number; y: number }): NonNullable<typeof held> {
    spring.stop()
    spring.velocity = 0
    if (held) settle()
    return hold(at)
  }

  /** The pages drawn at zoom `v` around the held point: scaled as they are, laid out again on settle(). */
  function show(v: number): void {
    if (!held) return
    held.v = v
    const k = v / zoom
    const p = places()[held.point.page]
    if (p) {
      const lx = p.left - sheet.offsetLeft + held.point.x * p.width
      const ly = p.top - sheet.offsetTop + held.point.y * p.height
      const tx = held.at.x + scroller.scrollLeft - sheet.offsetLeft - k * lx
      const ty = held.at.y + scroller.scrollTop - sheet.offsetTop - k * ly
      sheet.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`
    }
    report(v)
  }

  /** The zoom rests: the pages laid out at it, the held point where it was, and drawn sharp. */
  function settle(): void {
    clearTimeout(rest)
    if (!held) return
    const { point, at, v } = held
    held = null
    sheet.style.transform = ''
    zoom = v
    fitted = atFit(zoom, fit)
    for (const p of pages) size(p)
    const to = scrollFor(point, places(), at)
    scroller.scrollLeft = to.left
    scroller.scrollTop = to.top
    report()
    schedule()
  }

  const limits = () => pdfLimits(fit)
  const clampZoom = (v: number) => Math.min(limits().max, Math.max(limits().fit, v))
  const goal = () => (spring.moving ? spring.target : (held?.v ?? zoom))

  /** To zoom `v` on a spring around the middle of the view; one under way turns to it. */
  function zoomTo(v: number): void {
    if (!spring.moving) spring.value = begin(middleOfView()).v
    spring.to(clampZoom(v), { damping: 1, response: 0.32 })
  }

  /** A gesture let go: back inside the limits on a spring, else at rest where it is. */
  function release(): void {
    if (!held) return
    const inside = clampZoom(held.v)
    if (Math.abs(inside - held.v) > 1e-4 && !reducedMotion.matches) {
      spring.value = held.v
      spring.velocity = 0
      spring.to(inside, { damping: 1, response: 0.3 })
    } else {
      held.v = inside
      settle()
    }
  }

  const pointIn = (x: number, y: number) => {
    const r = scroller.getBoundingClientRect()
    return { x: x - r.left, y: y - r.top }
  }

  // Ctrl+wheel and a trackpad's pinch (Chrome, Edge, Firefox send it as one): around the pointer.
  listen(
    scroller,
    'wheel',
    (e: WheelEvent) => {
      if (!doc || !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      // One turn after another holds the same point; a spring under way rests first.
      const h = held && !spring.moving ? held : begin(pointIn(e.clientX, e.clientY))
      show(clampZoom(h.v * wheelZoom(e).factor))
      clearTimeout(rest)
      rest = setTimeout(settle, 160)
    },
    false,
  )

  // Safari's trackpad pinch.
  let gestureFrom = 1
  listen(
    scroller,
    'gesturestart',
    (e: Event & { clientX?: number; clientY?: number }) => {
      if (!doc) return
      e.preventDefault()
      gestureFrom = begin(pointIn(e.clientX ?? 0, e.clientY ?? 0)).v
    },
    false,
  )
  listen(
    scroller,
    'gesturechange',
    (e: Event & { scale?: number }) => {
      if (!held) return
      e.preventDefault()
      const lim = limits()
      show(softScale(gestureFrom * (e.scale ?? 1), lim.fit, lim.max))
    },
    false,
  )
  listen(scroller, 'gestureend', () => release())

  // Two fingers on a phone: the pages follow them, scaled and moved; one finger scrolls (the
  // scroller's own, with its momentum).
  let pinch: { d0: number; v0: number } | null = null
  const twoOf = (e: TouchEvent) => {
    const [a, b] = [e.touches[0], e.touches[1]]
    if (!a || !b) return null
    return {
      mid: pointIn((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2),
      d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    }
  }
  listen(scroller, 'touchstart', (e: TouchEvent) => {
    const two = doc && e.touches.length === 2 ? twoOf(e) : null
    if (!two) return
    pinch = { d0: Math.max(1, two.d), v0: begin(two.mid).v }
  })
  listen(
    scroller,
    'touchmove',
    (e: TouchEvent) => {
      const two = pinch && e.touches.length === 2 ? twoOf(e) : null
      if (!pinch || !two || !held || !e.cancelable) return
      e.preventDefault()
      held.at = two.mid
      const lim = limits()
      show(softScale((pinch.v0 * two.d) / pinch.d0, lim.fit, lim.max))
    },
    false,
  )
  const lift = (e: TouchEvent) => {
    if (!pinch || e.touches.length >= 2) return
    pinch = null
    release()
  }
  listen(scroller, 'touchend', lift)
  listen(scroller, 'touchcancel', lift)

  // The window changed: the pages sit anew (they are centred), and pages that fit the width fit
  // the new one.
  const resize = new ResizeObserver(() => {
    laidOut = null
    if (!doc || !scroller.clientWidth) return
    const next = fitZoom(first, scroller.clientWidth)
    if (Math.abs(next - fit) < 1e-4) return
    fit = next
    if (fitted && !held && !spring.moving) {
      hold({ x: scroller.clientWidth / 2, y: 0 }).v = fit
      settle()
    } else report()
  })

  // ---------------------------------------------------------------- the page on show

  let badgeOff: ReturnType<typeof setTimeout> | undefined
  listen(scroller, 'scroll', () => {
    if (!pages.length) return
    const n = pageAt(places(), scroller.scrollTop, scroller.clientHeight)
    badge.textContent = opts.pageLabel(n, pages.length)
    badge.classList.add('on')
    clearTimeout(badgeOff)
    badgeOff = setTimeout(() => badge.classList.remove('on'), 1100)
    schedule()
  })

  // ---------------------------------------------------------------- drawing

  const near = new Set<number>()
  const seen = new IntersectionObserver(
    entries => {
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.i)
        if (e.isIntersecting) near.add(i)
        else near.delete(i)
      }
      schedule()
    },
    { root: scroller, rootMargin: '100% 0px' },
  )

  let queued = false
  let drawing = false
  let again = false
  function schedule(): void {
    if (destroyed) return
    if (drawing) {
      again = true
      return
    }
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      void drawNear()
    })
  }

  async function drawNear(): Promise<void> {
    if (drawing || held || destroyed || !doc) return
    drawing = true
    again = false
    try {
      const middle = pageAt(places(), scroller.scrollTop, scroller.clientHeight) - 1
      const want = pagesToDraw(near, pages.length, middle)
      for (const i of want) {
        if (destroyed || held) break
        const p = pages[i]
        if (p) await draw(p)
      }
      const keep = new Set(want)
      for (const p of pages) if (!keep.has(p.i) && (p.canvas || p.task)) letGo(p)
    } finally {
      drawing = false
    }
    if (again) schedule()
  }

  async function draw(p: Page): Promise<void> {
    const scale = cssScale(zoom)
    if (p.drawn === scale || !doc) return
    try {
      p.proxy ??= await doc.getPage(p.i + 1)
    } catch {
      return
    }
    if (destroyed) return
    if (!p.box) {
      const own = p.proxy.getViewport({ scale: 1 })
      p.box = { w: own.width, h: own.height }
      if (own.width !== first.w || own.height !== first.h) size(p)
    }
    const viewport = p.proxy.getViewport({ scale })
    const ratio = pixelRatio({ w: viewport.width, h: viewport.height }, globalThis.devicePixelRatio, maxPixels)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
    const render = p.proxy.render({
      canvas,
      viewport,
      ...(ratio !== 1 && { transform: [ratio, 0, 0, ratio, 0, 0] }),
    })
    p.task = render
    try {
      await render.promise
    } catch {
      // Cancelled (the page went out of reach, the viewer closed), or a page that cannot be drawn.
      canvas.width = canvas.height = 0
      return
    } finally {
      if (p.task === render) p.task = null
    }
    if (destroyed || cssScale(zoom) !== scale) {
      canvas.width = canvas.height = 0
      return
    }
    if (p.canvas) {
      p.canvas.replaceWith(canvas)
      p.canvas.width = p.canvas.height = 0
    } else p.el.prepend(canvas)
    p.canvas = canvas
    p.drawn = scale
    if (p.text) p.text.update({ viewport })
    else {
      p.textEl = div('textLayer')
      p.el.append(p.textEl)
      p.text = new TextLayer({ textContentSource: p.proxy.streamTextContent(), container: p.textEl, viewport })
      p.text.render().catch(() => {})
    }
  }

  /** A page out of reach: its pixels and its text go, its place stays. */
  function letGo(p: Page): void {
    p.task?.cancel()
    p.task = null
    if (p.canvas) {
      p.canvas.width = p.canvas.height = 0
      p.canvas.remove()
    }
    p.canvas = null
    p.drawn = 0
    p.text?.cancel()
    p.textEl?.remove()
    p.text = null
    p.textEl = null
    p.proxy?.cleanup()
  }

  // ---------------------------------------------------------------- the document

  task.promise.then(
    async d => {
      if (destroyed) return
      doc = d
      try {
        const one = await d.getPage(1)
        const own = one.getViewport({ scale: 1 })
        first = { w: own.width, h: own.height }
        pages = Array.from({ length: d.numPages }, (_, i) => {
          const el = div('ql-pdf-page')
          el.dataset.i = String(i)
          return { i, el, box: null, proxy: null, drawn: 0, canvas: null, text: null, textEl: null, task: null }
        })
        const top = pages[0]
        if (top) Object.assign(top, { proxy: one, box: first })
      } catch (err) {
        if (!destroyed) opts.onFail?.(failureOf(err), String((err as Error)?.message ?? err))
        return
      }
      if (destroyed) return
      fit = zoom = fitZoom(first, scroller.clientWidth)
      for (const p of pages) size(p)
      sheet.append(...pages.map(p => p.el))
      for (const p of pages) seen.observe(p.el)
      resize.observe(scroller)
      opts.onPages?.(pages.length)
      report()
      schedule()
    },
    err => {
      if (!destroyed) opts.onFail?.(failureOf(err), String((err as Error)?.message ?? err))
    },
  )

  return {
    zoom(onChange) {
      onZoom = onChange
      report()
      const control: ImageZoom = {
        key(e: ZoomKey) {
          if (!doc || e.altKey) return false
          const k = e.key
          if (k === '+' || k === '=') zoomTo(stepScale(goal(), 1, limits()))
          else if (k === '-' || k === '_') zoomTo(stepScale(goal(), -1, limits()))
          else if (k === '0') zoomTo(fit)
          else if (SCROLL_KEYS[k] && !e.ctrlKey && !e.metaKey) {
            const by = SCROLL_KEYS[k](scroller)
            scroller.scrollBy({ ...by, behavior: reducedMotion.matches ? 'auto' : 'smooth' })
          } else return false
          return true
        },
        toggle() {
          if (doc) zoomTo(atFit(goal(), fit) ? zoomInScale(limits()) : fit)
        },
        destroy() {
          if (onZoom === onChange) onZoom = null
        },
      }
      return control
    },
    destroy() {
      destroyed = true
      off.abort()
      seen.disconnect()
      resize.disconnect()
      spring.stop()
      clearTimeout(rest)
      clearTimeout(badgeOff)
      for (const p of pages) letGo(p)
      void task.destroy()
      host.replaceChildren()
    },
  }
}
