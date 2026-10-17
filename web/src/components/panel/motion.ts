// One side panel's motion. Everything is a spring from where the panel is on screen, so any
// motion can be caught midway:
// - its edge resizes it 1:1, softly past the limits, and lets go with the pointer's speed;
//   flung below half the smallest size it folds away, like a sidebar; double-click: default size;
// - its head flicks it away along its own edge, as it came; pulled any other way it resists,
//   then comes loose as a window that follows the pointer, and a throw towards an edge docks
//   it there (the pointer's projected rest decides, a preview shows where);
// - a menu in its head picks the place, for keys and for those who would rather not throw.
// Phones (760 px and narrower) keep the full-height sheet: it flicks right, no resizing, no docks.
// React draws the panel (Panel.tsx) with what this reports: shown or not, and its handles.

import {
  clampFloat,
  DOCKS,
  type Dock,
  defaultFloat,
  dockFromThrow,
  dockRect,
  dockSize,
  type Edge,
  flicksAway,
  foldsAway,
  keyFloat,
  keySize,
  MARGIN,
  type Mode,
  outward,
  type PanelLayout,
  type Point,
  type Rect,
  rectFor,
  resizeFloat,
  sizeLimits,
  soft,
} from '../../models/panel-layout.ts'
import {
  AIM_IDLE,
  alongOut,
  CURSOR,
  draggedSize,
  EDGES,
  FAST_THROW,
  floatResizeVelocity,
  foldVelocity,
  growSpeed,
  type HeadDrag,
  headDrag,
  outOffset,
  type PanelChrome,
  type Place,
  panelChrome,
  panelStyle,
  resetLayout,
  resizeVelocity,
  restPlace,
  SAMPLES,
  sizeField,
  TEAR,
  thrownLayout,
  type Velocity,
} from '../../models/panel-motion.ts'
import { type PointerSample, reducedMotion, rubberband, Spring, velocityOf } from '../../models/spring.ts'
import { Store } from '../../state/store.ts'
import type { About, PanelPlace, PlacedPanel } from './place.ts'

/** What React draws from a panel. */
export interface PanelState {
  /** In the page (`open` class, not aria-hidden) from opening until it has left. */
  shown: boolean
  chrome: PanelChrome
}

interface Gesture {
  id: number
  sx: number
  sy: number
  px: number
  py: number
  at: Rect
  samples: PointerSample[]
  before: PanelLayout
}

interface HeadGesture extends Gesture {
  kind: 'head'
  mode: HeadDrag | null
  base: number
  size: number
  /** Where it was grabbed: a share of the width, and px from the top. */
  fx: number
  gy: number
  /** What is left of the catch-up after it came loose. */
  ox: Spring | null
  oy: Spring | null
  idle: ReturnType<typeof setTimeout> | undefined
}

interface ResizeGesture extends Gesture {
  kind: 'resize'
  edge: Edge
  handle: HTMLElement
  moved: boolean
  raw: number
}

interface GoOptions {
  velocity?: Velocity
  damping?: number
  response?: number
}

const sameChrome = (a: PanelChrome, b: PanelChrome): boolean =>
  a.mode === b.mode &&
  a.glyph === b.glyph &&
  a.separator?.orientation === b.separator?.orientation &&
  a.separator?.min === b.separator?.min &&
  a.separator?.max === b.separator?.max &&
  a.separator?.now === b.separator?.now

const sample = (e: PointerEvent): PointerSample => ({ x: e.clientX, y: e.clientY, t: e.timeStamp })
const isEdge = (value: string | undefined): value is Edge => EDGES.some(edge => edge === value)
const closest = (target: EventTarget | null, selector: string): Element | null =>
  target instanceof Element ? target.closest(selector) : null

/** With reduced motion a change of place is a cross-fade, not a slide. */
function fadeIn(el: HTMLElement | null): void {
  if (reducedMotion.matches) el?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' })
}

export class PanelMotion implements PlacedPanel {
  el: HTMLElement | null = null
  isOpen = false
  /** In the page: from opening until its springs rest after closing. */
  shown = false
  /** Mobile, or the dock it is painted for. */
  mode: Mode
  g: HeadGesture | ResizeGesture | null = null
  readonly x: Spring
  readonly y: Spring
  readonly w: Spring
  readonly h: Spring
  /** 1 shown; a floating panel shrinks a little and fades towards 0 as it comes and goes. */
  readonly p: Spring
  readonly state: Store<PanelState>
  /** The owner's: closed by the panel itself (its close button, a flick, folded away, Esc, the board beside it, Back) or by another opening. */
  onClose: () => void = () => {}
  /** What it is about (the session's card): kept in its place on screen while the board makes room. */
  about: About = () => null

  constructor(readonly place: PanelPlace) {
    const spring = (precision: number) =>
      new Spring({
        damping: 1,
        response: 0.4,
        precision,
        onUpdate: () => this.paint(),
        onRest: () => this.settle(),
      })
    this.x = spring(0.3)
    this.y = spring(0.3)
    this.w = spring(0.3)
    this.h = spring(0.3)
    this.p = spring(0.002)
    this.p.value = this.p.target = 1
    this.mode = place.modeNow()
    this.state = new Store<PanelState>({
      shown: false,
      chrome: panelChrome(this.mode, place.layout, place.viewport()),
    })
  }

  /** Takes the panel's element: its gestures, and its place among the panels. */
  attach(el: HTMLElement): () => void {
    this.el = el
    const down = (e: PointerEvent) => this.down(e)
    const move = (e: PointerEvent) => this.move(e)
    const up = (e: PointerEvent) => this.up(e)
    const cancel = (e: PointerEvent) => this.up(e, true)
    const dblclick = (e: MouseEvent) => {
      if (closest(e.target, '.sheet-edge')) this.resetSize()
    }
    const keydown = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.matches('.sheet-edge')) this.key(e)
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
    el.addEventListener('dblclick', dblclick)
    el.addEventListener('keydown', keydown)
    this.place.panels.push(this)
    this.place.changed()
    // Its springs go on: a remount (React's strict mode) takes the element back mid-motion.
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', cancel)
      el.removeEventListener('dblclick', dblclick)
      el.removeEventListener('keydown', keydown)
      const at = this.place.panels.indexOf(this)
      if (at >= 0) this.place.panels.splice(at, 1)
      this.place.changed()
      if (this.g?.kind === 'head') clearTimeout(this.g.idle)
      this.g = null
      if (this.el === el) this.el = null
    }
  }

  private springs(): Spring[] {
    return [this.x, this.y, this.w, this.h, this.p]
  }

  get moving(): boolean {
    return this.springs().some(s => s.moving)
  }

  get gesturing(): boolean {
    return this.g !== null
  }

  /** Where it is on screen now. */
  at(): Rect {
    return { x: this.x.value, y: this.y.value, w: this.w.value, h: this.h.value }
  }

  /** Where it rests in its place, or (`off`) where it comes in from and leaves to. */
  rest(off = false): Place {
    const now = { w: this.w.value, h: this.h.value }
    return restPlace(this.mode, this.place.layout, this.place.viewport(), off, this.el?.offsetWidth ?? 0, now)
  }

  jump(to: Place): void {
    this.x.set(to.x)
    this.y.set(to.y)
    this.w.set(to.w)
    this.h.set(to.h)
    this.p.set(to.p)
  }

  go(to: Place, { velocity = {}, damping = 1, response = 0.4 }: GoOptions = {}): void {
    this.x.to(to.x, { velocity: velocity.x, damping, response })
    this.y.to(to.y, { velocity: velocity.y, damping, response })
    this.w.to(to.w, { velocity: velocity.w, damping, response })
    this.h.to(to.h, { velocity: velocity.h, damping, response })
    this.p.to(to.p, { damping: 1, response: to.p ? 0.3 : 0.24 })
  }

  paint(): void {
    const el = this.el
    if (!el) return
    const g = this.g
    if (this.mode !== 'mobile' && g?.kind === 'head' && g.mode === 'move') {
      // Glued to the pointer where it was grabbed (a share of the width, as the width changes),
      // plus what is left of the catch-up after it came loose.
      this.x.value = this.x.target = g.px - g.fx * this.w.value + (g.ox?.value ?? 0)
      this.y.value = this.y.target = g.py - g.gy + (g.oy?.value ?? 0)
    }
    const style = panelStyle(this.mode, { ...this.at(), p: this.p.value }, devicePixelRatio || 1)
    if (style.width !== undefined) el.style.width = style.width
    if (style.height !== undefined) el.style.height = style.height
    el.style.transform = style.transform
    if (style.opacity !== undefined) el.style.opacity = style.opacity
  }

  settle(): void {
    if (this.isOpen || this.moving) return
    this.setShown(false)
  }

  private setShown(on: boolean): void {
    if (this.shown === on) return
    this.shown = on
    this.state.set({ ...this.state.get(), shown: on })
  }

  setMode(mode: Mode): void {
    this.mode = mode
    if (mode === 'mobile' && this.el) {
      this.el.style.width = ''
      this.el.style.height = ''
      this.el.style.opacity = ''
    }
    this.syncChrome()
  }

  /** The handles and the menu button for the place it is in. */
  syncChrome(): void {
    const chrome = panelChrome(this.mode, this.place.layout, this.place.viewport())
    const now = this.state.get()
    if (!sameChrome(chrome, now.chrome)) this.state.set({ ...now, chrome })
  }

  /** Returns false when it was open already. */
  open(): boolean {
    if (this.isOpen) return false
    this.isOpen = true
    for (const p of this.place.panels) if (p !== this) p.close()
    const mode = this.place.modeNow()
    const fresh = !this.shown || this.mode !== mode
    this.setShown(true)
    this.setMode(mode)
    // A fresh one comes in from its edge; one caught while leaving turns around from where it is.
    if (fresh) this.jump(this.rest(true))
    const float = mode === 'float'
    this.go(this.rest(), float ? { damping: 1, response: 0.32 } : { damping: 0.9, response: 0.4 })
    if (float && fresh) fadeIn(this.el)
    this.place.syncRoom({ about: this.about })
    this.place.changed()
    return true
  }

  /** `velocity` ({ x, y }, px/s): a flick's, carried on its way out. */
  close(velocity: { x?: number; y?: number } = {}): void {
    if (!this.isOpen) return
    this.isOpen = false
    if (this.place.menu.isOpen()) this.place.menu.close()
    this.go(this.rest(true), { velocity, damping: 1, response: 0.3 })
    this.place.syncRoom({ response: 0.3, about: this.about })
    this.onClose()
    this.place.changed()
  }

  /** To another place, from where it is now. */
  setDock(dock: Dock): void {
    if (dock === this.place.layout.dock || !DOCKS.includes(dock)) return
    this.place.setLayout({ ...this.place.layout, dock }, true)
    this.placeIn({ response: 0.42, fade: true })
  }

  /** Back to the default size of its place (a floating one: also the default spot). */
  resetSize(): void {
    if (this.mode === 'mobile') return
    this.place.setLayout(resetLayout(this.place.layout), true)
    this.placeIn({ response: 0.34 })
  }

  /** Into the current layout from wherever it is, the board along. */
  placeIn({ velocity = {}, damping = 1, response = 0.4, fade = false }: GoOptions & { fade?: boolean } = {}): void {
    this.setMode(this.place.modeNow())
    if (!this.isOpen) return
    this.go(this.rest(), { velocity, damping, response })
    if (fade) fadeIn(this.el)
    this.place.syncRoom({ response, about: this.about })
  }

  /** The window changed size: the panel keeps to its place (a spring caught midway keeps going there). */
  reflow(): void {
    if (!this.shown || this.g) return
    const mode = this.place.modeNow()
    if (mode !== this.mode) {
      this.setMode(mode)
      this.jump(this.rest(!this.isOpen))
      return
    }
    const to = this.rest(!this.isOpen)
    if (this.moving) this.go(to)
    else this.jump(to)
    this.syncChrome()
  }

  // -------------------------------------------------------------- gestures
  private halt(): void {
    for (const s of [this.x, this.y, this.w, this.h]) s.stop()
  }

  private down(e: PointerEvent): void {
    if (!this.isOpen || e.button !== 0) return
    const edge = closest(e.target, '.sheet-edge')
    if (edge instanceof HTMLElement) {
      this.resizeStart(e, edge)
      return
    }
    if (e.pointerType === 'touch' && !closest(e.target, '.sheet-grip')) return
    // The session's name renames it on a click: it does not move the panel.
    if (!closest(e.target, '.sheet-head, .sheet-grip') || closest(e.target, 'button, input, textarea, a, #sheet-name'))
      return
    this.halt()
    const at = this.at()
    this.g = {
      kind: 'head',
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      px: e.clientX,
      py: e.clientY,
      at,
      samples: [sample(e)],
      mode: null,
      before: { ...this.place.layout },
      base: 0,
      size: 0,
      fx: 0,
      gy: 0,
      ox: null,
      oy: null,
      idle: undefined,
    }
    this.el?.setPointerCapture(e.pointerId)
  }

  private move(e: PointerEvent): void {
    const g = this.g
    if (!g || e.pointerId !== g.id) return
    g.samples.push(sample(e))
    if (g.samples.length > SAMPLES) g.samples.shift()
    g.px = e.clientX
    g.py = e.clientY
    const dx = e.clientX - g.sx
    const dy = e.clientY - g.sy
    if (g.kind === 'resize') {
      this.resizeMove(g, dx, dy)
      return
    }
    if (!g.mode) {
      const mode = headDrag(this.mode, dx, dy)
      if (!mode) return
      g.mode = mode
      const o = outward(this.mode)
      const rest = this.rest()
      g.base = (g.at.x - rest.x) * o.x + (g.at.y - rest.y) * o.y
      g.size = this.mode === 'mobile' ? (this.el?.offsetWidth ?? 0) : this.mode === 'bottom' ? g.at.h : g.at.w
      getSelection()?.removeAllRanges()
      document.body.classList.add('panel-grabbing')
      if (g.mode === 'move') this.grab(g)
    }
    if (g.mode === 'dismiss') {
      const o = outward(this.mode)
      const rest = this.rest()
      const off = outOffset(g.base + dx * o.x + dy * o.y, g.size)
      this.x.set(rest.x + off * o.x)
      if (this.mode !== 'mobile') this.y.set(rest.y + off * o.y)
    } else if (g.mode === 'pull') {
      this.x.set(g.at.x + rubberband(dx, 300))
      this.y.set(g.at.y + rubberband(dy, 300))
      if (Math.hypot(dx, dy) > TEAR) this.loosen(g)
    } else {
      this.paint()
      this.aim(g)
    }
  }

  /** A floating panel taken by its head: it follows the pointer from where it was grabbed. */
  private grab(g: HeadGesture): void {
    g.fx = (g.sx - g.at.x) / g.at.w
    g.gy = g.sy - g.at.y
  }

  /** Pulled far enough, a docked panel comes loose as a window, sized as the viewer's floating one. */
  private loosen(g: HeadGesture): void {
    const vp = this.place.viewport()
    const now = this.at()
    g.mode = 'move'
    this.grab(g)
    // From the rubber-banded spot to under the pointer: an offset that springs away (additive), so nothing jumps.
    const catchUp = (value: number) => {
      const s = new Spring({ value, damping: 1, response: 0.26, precision: 0.3, onUpdate: () => this.paint() })
      s.to(0)
      return s
    }
    g.ox = catchUp(now.x - (g.px - g.fx * now.w))
    g.oy = catchUp(now.y - (g.py - g.gy))
    const size = clampFloat(this.place.layout.float ?? defaultFloat(vp), vp)
    this.place.setLayout({ ...this.place.layout, dock: 'float' }) // the drop decides what is kept
    this.setMode('float')
    this.w.to(size.w, { damping: 1, response: 0.32 })
    this.h.to(size.h, { damping: 1, response: 0.32 })
    this.place.syncRoom({ response: 0.34, about: this.about })
  }

  /** While a loose panel moves: the dock it would land in now, shown as a preview. */
  private aim(g: HeadGesture): void {
    clearTimeout(g.idle)
    const v = velocityOf(g.samples)
    const preview = this.place.preview
    preview.show(dockFromThrow({ x: g.px, y: g.py }, v, this.place.viewport()), this.at())
    // Held still, the throw is over: aim again without the speed it had.
    g.idle = setTimeout(() => {
      if (this.g === g)
        preview.show(dockFromThrow({ x: g.px, y: g.py }, { x: 0, y: 0 }, this.place.viewport()), this.at())
    }, AIM_IDLE)
  }

  private up(e: PointerEvent, cancelled = false): void {
    const g = this.g
    if (!g || e.pointerId !== g.id) return
    this.g = null
    if (g.kind === 'head') clearTimeout(g.idle)
    document.body.classList.remove('panel-grabbing', 'panel-resizing')
    if (!cancelled) g.samples.push(sample(e))
    const v = cancelled ? { x: 0, y: 0 } : velocityOf(g.samples)
    if (g.kind === 'resize') {
      this.resizeEnd(g, v)
      return
    }
    if (!g.mode) return // a press on the head, not a drag
    if (g.mode === 'dismiss') {
      const o = outward(this.mode)
      const rest = this.rest()
      const off = (this.x.value - rest.x) * o.x + (this.y.value - rest.y) * o.y
      const { along, velocity } = alongOut(this.mode, v)
      if (flicksAway(off, along, g.size)) this.close(velocity)
      else this.go(this.rest(), { velocity, damping: 0.8, response: 0.3 })
      return
    }
    if (g.mode === 'pull') {
      this.go(this.rest(), { velocity: v, damping: 0.8, response: 0.3 })
      return
    }
    // Let go loose: docks where the throw would come to rest near an edge, else floats there.
    this.place.preview.hide()
    g.ox?.stop()
    g.oy?.stop()
    const vp = this.place.viewport()
    const dock = dockFromThrow({ x: g.px, y: g.py }, v, vp)
    const w = this.w.target
    const h = this.h.target
    this.place.setLayout(
      thrownLayout(this.place.layout, dock, { x: g.px - g.fx * w, y: g.py - g.gy, w, h }, v, vp),
      true,
    )
    const fast = Math.hypot(v.x, v.y) > FAST_THROW
    this.placeIn({ velocity: { x: v.x, y: v.y }, damping: fast ? 0.82 : 1, response: 0.42, fade: true })
  }

  private resizeStart(e: PointerEvent, handle: HTMLElement): void {
    const edge = handle.dataset.edge
    if (this.mode === 'mobile' || !isEdge(edge)) return
    e.preventDefault() // no text selection on the way
    this.halt()
    this.g = {
      kind: 'resize',
      edge,
      handle,
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      px: e.clientX,
      py: e.clientY,
      at: this.at(),
      samples: [sample(e)],
      moved: false,
      raw: 0,
      before: { ...this.place.layout },
    }
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('active')
    document.body.style.setProperty('--grab-cursor', CURSOR[edge])
    document.body.classList.add('panel-resizing')
    this.place.holdAnchor(this.about)
    this.place.following = true
  }

  private resizeMove(g: ResizeGesture, dx: number, dy: number): void {
    const vp = this.place.viewport()
    g.moved ||= dx !== 0 || dy !== 0
    const mode = this.mode
    if (mode === 'float') {
      this.jump({ ...resizeFloat(g.at, g.edge, dx, dy, vp), p: 1 })
      return
    }
    if (mode === 'mobile') return
    g.raw = draggedSize(mode, g.at, dx, dy)
    const size = soft(g.raw, sizeLimits(mode, vp))
    this.jump({ ...dockRect(mode, size, vp), p: 1 })
    this.place.room[mode].set(size + MARGIN)
  }

  private resizeEnd(g: ResizeGesture, v: Point): void {
    g.handle.classList.remove('active')
    this.place.following = false
    if (!g.moved) {
      this.place.queueRoom()
      return
    }
    const vp = this.place.viewport()
    const mode = this.mode
    if (mode === 'float') {
      const r = clampFloat(this.at(), vp)
      this.place.setLayout({ ...this.place.layout, float: r }, true)
      this.go({ ...r, p: 1 }, { velocity: floatResizeVelocity(g.edge, v), damping: 0.85, response: 0.32 })
      return
    }
    if (mode === 'mobile') return
    const lim = sizeLimits(mode, vp)
    // How fast it grows (px/s).
    const vs = growSpeed(mode, v)
    if (foldsAway(g.raw, vs, lim.min)) {
      this.close(foldVelocity(mode, vs))
      return
    }
    const size = Math.round(Math.max(lim.min, Math.min(lim.max, mode === 'bottom' ? this.h.value : this.w.value)))
    this.place.setLayout({ ...this.place.layout, [sizeField(mode)]: size }, true)
    this.go(this.rest(), { velocity: resizeVelocity(mode, vs), damping: 0.85, response: 0.32 })
    this.place.syncRoom({ velocity: { [mode]: vs }, response: 0.32, about: this.about })
    this.syncChrome()
  }

  /** Esc while dragging: everything goes back to where it was. */
  cancel(): void {
    const g = this.g
    if (!g) return
    this.g = null
    try {
      ;(g.kind === 'resize' ? g.handle : this.el)?.releasePointerCapture(g.id)
    } catch {}
    if (g.kind === 'resize') g.handle.classList.remove('active')
    this.place.following = false
    document.body.classList.remove('panel-grabbing', 'panel-resizing')
    this.place.preview.hide()
    if (g.kind === 'head') {
      clearTimeout(g.idle)
      g.ox?.stop()
      g.oy?.stop()
    }
    this.place.setLayout(g.before)
    this.placeIn({ damping: 1, response: 0.34, fade: true })
  }

  private key(e: KeyboardEvent): void {
    const mode = this.mode
    if (mode === 'mobile' || e.altKey || e.ctrlKey || e.metaKey) return
    const vp = this.place.viewport()
    const layout = this.place.layout
    if (mode === 'float') {
      const r = keyFloat(rectFor(layout, vp), e.key, e.shiftKey, vp)
      if (!r) return
      e.preventDefault()
      this.place.setLayout({ ...layout, float: r }, true)
    } else {
      const size = keySize(mode, dockSize(layout, mode, vp), e.key, e.shiftKey, sizeLimits(mode, vp))
      if (size == null) return
      e.preventDefault()
      this.place.setLayout({ ...layout, [sizeField(mode)]: size }, true)
    }
    this.placeIn({ response: 0.26 })
  }
}
