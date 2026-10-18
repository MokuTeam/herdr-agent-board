// Zoom for an image in the quick look, as in Preview and Photos: Ctrl+wheel or a trackpad pinch,
// two fingers on a phone, a click (a double-tap) into the spot and a double-click back to fit,
// + − 0 and the arrows from the keyboard. A zoomed image follows the mouse or the finger 1:1,
// glides on after a flick and resists past its edges; a plain wheel moves it. Every motion is a
// spring from where the image is now, so a new gesture takes it over midway. Reduced motion: no
// glide and no soft edges, every change at once. The geometry is models/zoom.ts.
import { type PointerSample, reducedMotion, Spring, velocityOf } from '../../models/spring.ts'
import {
  atFit,
  clampView,
  clickZoom,
  EDGE_RESPONSE,
  fitView,
  fixedPoint,
  type Glide,
  glide,
  hardView,
  type ImageBox,
  isDoubleTap,
  panBounds,
  pinchView,
  pixelated,
  softScale,
  softView,
  stepScale,
  type Tap,
  toggleView,
  unsoftScale,
  wheelPan,
  wheelZoom,
  type ZoomPoint,
  type ZoomStage,
  type ZoomState,
  type ZoomView,
  zoomAt,
  zoomInScale,
  zoomLimits,
  zoomTo,
} from '../../models/zoom.ts'

/** What the zoom reads of a key press. */
export interface ZoomKey {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export interface ImageZoom {
  /** The zoom keys; true when the key was one of them. */
  key(e: ZoomKey): boolean
  /** The footer's button: in from fit around the middle, else back to fit. */
  toggle(): void
  destroy(): void
}

export interface ZoomOptions {
  /** The image's own size in pixels. */
  size: ImageBox
  /** Keeps it smooth at any zoom (an SVG). */
  vector?: boolean
  onChange?: (state: ZoomState) => void
}

/** Safari's gesture events: a trackpad pinch's scale, where it is. */
interface GestureLike extends Event {
  scale?: number
  clientX?: number
  clientY?: number
}

type Axis = 'x' | 'y'
const AXES: Axis[] = ['x', 'y']

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const mid = (a: ZoomPoint, b: ZoomPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const dist = (a: ZoomPoint, b: ZoomPoint) => Math.hypot(a.x - b.x, a.y - b.y)

interface Press {
  type: string
  x: number
  y: number
  t: number
  moved: boolean
  pinched: boolean
}

type Gesture =
  | { pinch: true; start: ZoomView; raw: number; c0: ZoomPoint; d0: number; at?: ZoomPoint }
  | { pinch: false; start: ZoomView; p0: ZoomPoint }

/**
 * Make `img` zoomable inside `stage` (its positioned box, whose padding is the fitted margin);
 * `size` is the image's own size in pixels, `vector` keeps it smooth at any zoom. `onChange`
 * hears { s, fit, to } on every change: the scale shown, whether it is headed for fit, and
 * where a zoom in from fit goes.
 */
export function zoomImage(
  stage: HTMLElement,
  img: HTMLImageElement,
  { size, vector = false, onChange = () => {} }: ZoomOptions,
): ImageZoom {
  const measure = (): ZoomStage => ({
    w: stage.clientWidth,
    h: stage.clientHeight,
    pad: Number.parseFloat(getComputedStyle(stage).paddingLeft) || 0,
  })
  const soft = () => !reducedMotion.matches
  let room = measure()
  let view = fitView(size, room)
  // Where the image is headed: the view itself at rest or under a finger, else the animation's
  // end, which wheel notches and keys add up from.
  let goal = view
  const limits = () => zoomLimits(size, room)

  stage.classList.add('zoomable')
  img.draggable = false

  function paint(): void {
    const dpr = devicePixelRatio || 1
    const px = (v: number) => Math.round(v * dpr) / dpr
    img.style.width = `${size.w * view.s}px`
    img.style.height = `${size.h * view.s}px`
    img.style.transform = `translate(${px(view.x)}px, ${px(view.y)}px)`
    img.classList.toggle('pixelated', !vector && pixelated(view.s, dpr))
    const lim = limits()
    const fit = atFit(goal.s, lim.fit)
    if (stage.dataset.zoom !== (fit ? 'fit' : 'in')) stage.dataset.zoom = fit ? 'fit' : 'in'
    onChange({ s: view.s, fit, to: zoomInScale(lim) })
  }

  // A zoom moves the scale on one spring, in log scale, around the point that takes the image
  // from where it is to where it goes; a pan or a glide moves each axis on its own spring, and a
  // glide that meets an edge turns there into a bounce.
  let zoomFrom = view
  let anchor: ZoomPoint = { x: 0, y: 0 }
  const zs = new Spring({
    precision: 0.0005,
    onUpdate: z => {
      view = zoomAt(zoomFrom, Math.exp(z), anchor)
      paint()
    },
  })
  const edges: Record<Axis, { at: number; side: number } | null> = { x: null, y: null }
  const axis = (name: Axis) =>
    new Spring({
      precision: 0.05,
      onUpdate: v => {
        view = { ...view, [name]: v }
        const edge = edges[name]
        if (edge && (v - edge.at) * edge.side > 0) {
          edges[name] = null
          springs[name].to(edge.at, { damping: 1, response: EDGE_RESPONSE })
        }
        paint()
      },
    })
  const springs: Record<Axis, Spring> = { x: axis('x'), y: axis('y') }

  // Where the wheel's own notches are headed, while they animate.
  let notchGoal: ZoomView | null = null
  function stop(): void {
    zs.stop()
    springs.x.stop()
    springs.y.stop()
    edges.x = edges.y = null
    goal = view
    notchGoal = null
  }

  /** Head for `target` (within the limits) from wherever the image is now. */
  function animate(target: ZoomView, response = 0.4): void {
    edges.x = edges.y = null
    goal = target
    notchGoal = null
    const p = fixedPoint(view, target)
    if (!p) {
      zs.stop()
      for (const name of AXES) {
        const s = springs[name]
        if (!s.moving) {
          s.value = view[name]
          s.velocity = 0
        }
        s.to(target[name], { damping: 1, response })
      }
      return
    }
    springs.x.stop()
    springs.y.stop()
    if (!zs.moving) {
      zs.value = Math.log(view.s)
      zs.velocity = 0
    }
    zoomFrom = view
    anchor = p
    zs.to(Math.log(target.s), { damping: 1, response })
  }

  /** Let go at velocity `v`: back within the limits, or a glide on from the flick. */
  function settle(v: ZoomPoint, center: ZoomPoint | null): void {
    const lim = limits()
    if (view.s < lim.fit * 0.999 || view.s > lim.max * 1.001) {
      animate(zoomTo(view, view.s, center ?? { x: room.w / 2, y: room.h / 2 }, size, room), EDGE_RESPONSE)
      return
    }
    if (!soft()) v = { x: 0, y: 0 }
    const b = panBounds(view.s, size, room)
    zs.stop()
    const plan: Record<Axis, Glide> = { x: glide(view.x, v.x, b.minX, b.maxX), y: glide(view.y, v.y, b.minY, b.maxY) }
    goal = { s: view.s, x: clamp(plan.x.to, b.minX, b.maxX), y: clamp(plan.y.to, b.minY, b.maxY) }
    for (const name of AXES) {
      const g = plan[name]
      edges[name] = g.edge === null ? null : { at: g.edge, side: g.to > g.edge ? 1 : -1 }
      springs[name].value = view[name]
      springs[name].to(g.to, { velocity: v[name], damping: 1, response: g.response })
    }
  }

  // ------------------------------------------------------------ pointers
  const pointers = new Map<number, ZoomPoint>()
  let gesture: Gesture | null = null
  let samples: PointerSample[] = []
  let press: Press | null = null
  let lastTap: Tap | null = null

  /** A point in the stage's own pixels (the quick look may still be growing as it opens). */
  function local(e: { clientX: number; clientY: number }): ZoomPoint {
    const r = stage.getBoundingClientRect()
    const k = r.width / stage.offsetWidth || 1
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }

  /** Start or restart the gesture from the fingers down now and the view as it is. */
  function begin(): Gesture {
    const pts = [...pointers.values()]
    const start = soft() ? hardView(view, size, room) : view
    samples = []
    stage.classList.add('dragging')
    const [a, b] = pts
    if (a && b) {
      const lim = limits()
      if (press) press.pinched = true
      gesture = {
        pinch: true,
        start,
        raw: soft() ? unsoftScale(view.s, lim.fit, lim.max) : view.s,
        c0: mid(a, b),
        d0: dist(a, b),
      }
    } else gesture = { pinch: false, start, p0: a ?? { x: 0, y: 0 } }
    return gesture
  }

  function follow(g: Gesture, t: number): void {
    const [a = { x: 0, y: 0 }, b = a] = [...pointers.values()]
    let next: ZoomView
    let at: ZoomPoint
    if (g.pinch) {
      const lim = limits()
      at = mid(a, b)
      const raw = g.raw * (g.d0 > 0 ? dist(a, b) / g.d0 : 1)
      g.at = at
      next = pinchView(g.start, soft() ? softScale(raw, lim.fit, lim.max) : clamp(raw, lim.fit, lim.max), g.c0, at)
    } else {
      at = a
      next = { s: g.start.s, x: g.start.x + at.x - g.p0.x, y: g.start.y + at.y - g.p0.y }
    }
    samples.push({ ...at, t })
    if (samples.length > 12) samples.shift()
    view = goal = soft() ? softView(next, size, room) : clampView(next, size, room)
    paint()
  }

  // A finger catches a moving image as it lands. The mouse catches a glide too, but a zoom only
  // once it drags, so the second press of a double-click does not stop the zoom the first began.
  function down(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    stage.setPointerCapture(e.pointerId)
    const p = local(e)
    if (!pointers.size) press = { type: e.pointerType, x: p.x, y: p.y, t: e.timeStamp, moved: false, pinched: false }
    pointers.set(e.pointerId, p)
    if (e.pointerType !== 'mouse') {
      stop()
      begin()
    } else if (springs.x.moving || springs.y.moving) stop()
  }
  function move(e: PointerEvent): void {
    if (!pointers.has(e.pointerId) || !press) return
    const p = local(e)
    pointers.set(e.pointerId, p)
    if (!press.moved && Math.hypot(p.x - press.x, p.y - press.y) > (press.type === 'mouse' ? 3 : 10)) {
      press.moved = true
      if (!gesture) {
        stop()
        const g = begin()
        // Counted from where the button went down: the point grabbed stays under the mouse.
        if (!g.pinch) g.p0 = { x: press.x, y: press.y }
      }
    }
    if (gesture) follow(gesture, e.timeStamp)
  }
  function end(e: PointerEvent): void {
    const p = pointers.get(e.pointerId)
    if (!p) return
    pointers.delete(e.pointerId)
    // A finger left a pinch: the one still down goes on moving the image.
    if (pointers.size) return void begin()
    const g = gesture
    gesture = null
    stage.classList.remove('dragging')
    // A mouse press that never dragged is a click (below), and leaves any motion running.
    if (!g || !press) return
    const at = g.pinch ? (g.at ?? g.c0) : p
    if (e.type !== 'pointerup') {
      settle({ x: 0, y: 0 }, at)
      return
    }
    // Held still before letting go: no glide.
    samples.push({ ...(g.pinch ? at : local(e)), t: e.timeStamp })
    if (press.type !== 'mouse' && !press.moved && !press.pinched && e.timeStamp - press.t < 400) {
      const tap = { x: p.x, y: p.y, t: e.timeStamp }
      if (isDoubleTap(lastTap, tap)) {
        lastTap = null
        animate(toggleView(goal, p, size, room), 0.42)
        return
      }
      lastTap = tap
    }
    // A tap's wobble is not a flick.
    settle(press.moved || press.pinched ? velocityOf(samples) : { x: 0, y: 0 }, at)
  }
  stage.addEventListener('pointerdown', down)
  stage.addEventListener('pointermove', move)
  stage.addEventListener('pointerup', end)
  stage.addEventListener('pointercancel', end)
  stage.addEventListener('lostpointercapture', end)

  // The mouse: a click zooms in from fit, a double-click goes back (the second click of the one
  // that zoomed in does nothing more). A drag is not a click.
  let clickedIn = false
  stage.addEventListener('click', e => {
    if (press?.type !== 'mouse' || press.moved) return
    const act = clickZoom(e.detail, atFit(goal.s, limits().fit), clickedIn)
    if (e.detail <= 1) clickedIn = act === 'in'
    if (act === 'in') animate(toggleView(goal, local(e), size, room), 0.42)
    else if (act === 'fit') animate(fitView(size, room), 0.42)
  })

  stage.addEventListener(
    'wheel',
    e => {
      e.preventDefault()
      if (gesture || (!e.deltaX && !e.deltaY)) return
      const p = local(e)
      // A notch animates on from where the motion was headed. A trackpad's small steps follow at
      // once, from where the notches were headed if they still run, so a mix loses nothing.
      const step = (notch: boolean, next: (v: ZoomView) => ZoomView) => {
        if (notch) {
          animate(next(goal), 0.28)
          notchGoal = goal
          return
        }
        const base = notchGoal && (zs.moving || springs.x.moving || springs.y.moving) ? notchGoal : view
        stop()
        view = goal = next(base)
        paint()
      }
      if (e.ctrlKey) {
        const { factor, notch } = wheelZoom(e)
        return step(notch, v => zoomTo(v, v.s * factor, p, size, room))
      }
      if (atFit(goal.s, limits().fit)) return
      const { dx, dy, notch } = wheelPan(e, room.h * 0.9)
      step(notch, v => clampView({ ...v, x: v.x - dx, y: v.y - dy }, size, room))
    },
    { passive: false },
  )

  // Safari on a Mac sends a trackpad pinch as gesture events, not as a Ctrl+wheel. On an iPhone
  // the fingers are pointers already: there the events are only kept from zooming the page.
  let pinchStart: { view: ZoomView; at: ZoomPoint } | null = null
  function onGesture(e: GestureLike): void {
    e.preventDefault()
    if (pointers.size) return
    if (e.type === 'gesturestart') {
      stop()
      pinchStart = { view, at: local({ clientX: e.clientX ?? 0, clientY: e.clientY ?? 0 }) }
    } else if (e.type === 'gesturechange' && pinchStart) {
      view = goal = zoomTo(pinchStart.view, pinchStart.view.s * (e.scale ?? 1), pinchStart.at, size, room)
      paint()
    } else pinchStart = null
  }
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) stage.addEventListener(type, onGesture)

  // A new window size keeps a fitted image fitted, and a zoomed one on the same spot.
  const resize = new ResizeObserver(() => {
    const was = room
    const next = measure()
    if (!next.w || !next.h || (next.w === was.w && next.h === was.h && next.pad === was.pad)) return
    const fitted = atFit(goal.s, zoomLimits(size, was).fit)
    stop()
    room = next
    if (fitted) view = fitView(size, room)
    else {
      const lim = limits()
      const kept = zoomAt(view, clamp(view.s, lim.fit, lim.max), { x: was.w / 2, y: was.h / 2 })
      view = clampView({ s: kept.s, x: kept.x + (room.w - was.w) / 2, y: kept.y + (room.h - was.h) / 2 }, size, room)
    }
    goal = view
    paint()
  })
  resize.observe(stage)
  paint()

  const middle = () => ({ x: room.w / 2, y: room.h / 2 })
  return {
    key(e) {
      if (!stage.isConnected || e.altKey || gesture) return false
      const lim = limits()
      const k = e.key
      if (k === '+' || k === '=') animate(zoomTo(goal, stepScale(goal.s, 1, lim), middle(), size, room), 0.3)
      else if (k === '-' || k === '_') animate(zoomTo(goal, stepScale(goal.s, -1, lim), middle(), size, room), 0.3)
      else if (k === '0') animate(fitView(size, room), 0.4)
      else if (/^Arrow/.test(k) && !e.ctrlKey && !e.metaKey && !e.shiftKey && !atFit(goal.s, lim.fit)) {
        const dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0
        const dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0
        animate(clampView({ ...goal, x: goal.x - dx * room.w * 0.2, y: goal.y - dy * room.h * 0.2 }, size, room), 0.3)
      } else return false
      return true
    },
    toggle: () => animate(toggleView(goal, middle(), size, room), 0.42),
    destroy() {
      stop()
      resize.disconnect()
    },
  }
}
