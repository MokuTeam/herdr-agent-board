// The one place the side panels share: the viewer's layout (this browser's: docked right, left or
// at the bottom, or floating), the room the board makes for a docked panel, the dock preview and
// the place menu, and the window around them. One panel is open at a time, in this place.
//
// The board's margins (--room-left/right/bottom on <html>) are springs. While they move, the card
// the panel is about keeps its place on screen, and stays clear of a panel at the bottom. A side
// panel that lies over the board (no room for it) still keeps the toolbar's controls clear of it:
// --over-left/right, on springs as well.

import {
  type Dock,
  type Mode,
  type Over,
  overlays,
  type PanelLayout,
  restoreLayout,
  type Side,
  serializeLayout,
  type Viewport,
} from '../../models/panel-layout.ts'
import {
  anchorScroll,
  keepsAnchor,
  OVER_SIDES,
  overWanted,
  PHONE_QUERY,
  roomValue,
  roomWanted,
  SIDES,
} from '../../models/panel-motion.ts'
import { Spring } from '../../models/spring.ts'
import { storage } from '../../state/storage.ts'
import { Store } from '../../state/store.ts'
import { DockPreviewMotion } from './dock-preview.ts'
import { LayoutMenuMotion, type MenuView } from './layout-menu.ts'

/** The viewer's layout in localStorage (format: panel-layout.ts serializeLayout). */
export const LAYOUT_KEY = 'board.panel'

/** What the place needs of a panel. */
export interface PlacedPanel {
  readonly isOpen: boolean
  /** A gesture is in progress. */
  readonly gesturing: boolean
  close(velocity?: { x?: number; y?: number }): void
  /** The window changed size. */
  reflow(): void
  /** Esc during a gesture: everything back to where it was. */
  cancel(): void
  setDock(dock: Dock): void
  resetSize(): void
  /** It lies over the board (a deeper shadow, a drawer over the cards rather than beside them). */
  setOver(on: boolean): void
}

/** The element a panel is about (the session's card), kept in its place on screen while the board makes room. */
export type About = () => Element | null

/** What React draws from the place. */
export interface PlaceState {
  layout: PanelLayout
  menu: MenuView
  /** A panel is open. */
  open: boolean
}

export interface RoomOptions {
  jump?: boolean
  velocity?: Partial<Record<Side, number>>
  response?: number
  /** What the panel making the room is about. */
  about?: About
}

const nothing: About = () => null

const html = (): HTMLElement => document.documentElement

/** The window's size, without its scrollbar. */
function windowSize(): Viewport {
  return typeof document === 'undefined' ? { w: 0, h: 0 } : { w: html().clientWidth, h: html().clientHeight }
}

export class PanelPlace {
  layout: PanelLayout
  readonly panels: PlacedPanel[] = []
  readonly room: Record<Side, Spring>
  readonly over: Record<keyof Over, Spring>
  readonly preview: DockPreviewMotion
  readonly menu: LayoutMenuMotion
  /** A gesture sets the room 1:1. */
  following = false
  /** Where the board's visible part starts (the page says: the toolbar's bottom). */
  boardTop: () => number = () => 0
  private anchor: { el: Element; y: number } | null = null
  private queued = false
  private phone: MediaQueryList | null = null
  private last: Viewport = { w: 0, h: 0 }
  readonly state: Store<PlaceState>

  constructor(readonly viewport: () => Viewport = windowSize) {
    this.layout = restoreLayout(storage.get(LAYOUT_KEY, ''))
    this.state = new Store<PlaceState>({ layout: this.layout, menu: { expanded: null, checked: null }, open: false })
    const spring = () =>
      new Spring({
        damping: 1,
        response: 0.4,
        precision: 0.3,
        onUpdate: () => this.queueRoom(),
        onRest: () => this.queueRoom(),
      })
    this.room = { left: spring(), right: spring(), bottom: spring() }
    const overSpring = () => new Spring({ damping: 1, response: 0.4, precision: 0.3, onUpdate: () => this.queueRoom() })
    this.over = { left: overSpring(), right: overSpring() }
    this.preview = new DockPreviewMotion(
      () => this.layout,
      () => this.viewport(),
    )
    this.menu = new LayoutMenuMotion(
      () => this.layout,
      () => this.viewport(),
      menu => this.state.set({ ...this.state.get(), menu }),
    )
  }

  private phoneQuery(): MediaQueryList | null {
    if (!this.phone && typeof matchMedia === 'function') this.phone = matchMedia(PHONE_QUERY)
    return this.phone
  }

  /** On a phone (760 px and narrower) a panel is the full-height sheet. */
  isPhone(): boolean {
    return this.phoneQuery()?.matches ?? false
  }

  modeNow(): Mode {
    return this.isPhone() ? 'mobile' : this.layout.dock
  }

  /** The viewer's place changed; `save` keeps it for the next visit. */
  setLayout(layout: PanelLayout, save = false): void {
    this.layout = layout
    if (save) storage.set(LAYOUT_KEY, serializeLayout(layout))
    this.state.set({ ...this.state.get(), layout })
  }

  /** A panel opened or closed. */
  changed(): void {
    const open = !!this.openPanel()
    if (open !== this.state.get().open) this.state.set({ ...this.state.get(), open })
  }

  openPanel(): PlacedPanel | undefined {
    return this.panels.find(p => p.isOpen)
  }

  /** Settings picked a place: the open panel moves there, and the others open there next. */
  placePanels(dock: Dock): void {
    ;(this.openPanel() ?? this.panels[0])?.setDock(dock)
  }

  /** Settings asked for the default size of the panels' place. */
  resetPanelSize(): void {
    ;(this.openPanel() ?? this.panels[0])?.resetSize()
  }

  /** The room a panel at the bottom takes now: where the board's visible part ends. */
  roomBelow(): number {
    return this.room.bottom.value
  }

  // ---------------------------------------------------------------- the board makes room
  queueRoom(): void {
    if (this.queued) return
    this.queued = true
    // All three springs step in one frame; the page lays out once, after them.
    queueMicrotask(() => this.applyRoom())
  }

  private applyRoom(): void {
    this.queued = false
    for (const side of SIDES) html().style.setProperty(`--room-${side}`, roomValue(this.room[side].value))
    for (const side of OVER_SIDES) html().style.setProperty(`--over-${side}`, roomValue(this.over[side].value))
    if (this.anchor?.el.isConnected) {
      const r = this.anchor.el.getBoundingClientRect()
      const by = anchorScroll(this.anchor.y, r, this.boardTop(), this.viewport().h, this.room.bottom.value)
      if (by) scrollBy(0, by)
    }
    // Once the room is still (and no edge is held), the browser's own scroll anchoring is back.
    if (!this.following && !SIDES.some(side => this.room[side].moving)) this.dropAnchor()
  }

  /** Keeps what the panel is about where it is on screen while the board makes room. */
  holdAnchor(about: About = nothing): void {
    const el = about()
    const r = el?.isConnected ? el.getBoundingClientRect() : null
    this.anchor =
      el && r && keepsAnchor(r, this.boardTop(), this.viewport().h, this.room.bottom.value) ? { el, y: r.top } : null
    // Our own anchoring, not the browser's, while the board reflows around the card.
    html().style.overflowAnchor = this.anchor ? 'none' : ''
  }

  private dropAnchor(): void {
    this.anchor = null
    html().style.overflowAnchor = ''
  }

  /** The board's room for the open panel (none on a phone, or for a floating one). */
  syncRoom({ jump = false, velocity = {}, response = 0.4, about = nothing }: RoomOptions = {}): void {
    const open = this.openPanel()
    const vp = this.viewport()
    const phone = this.isPhone()
    const want = roomWanted(!!open, phone, this.layout, vp)
    const wantOver = overWanted(!!open, phone, this.layout, vp)
    // Over the board it casts a deeper shadow, a drawer over the cards rather than beside them.
    open?.setOver(!phone && overlays(this.layout, vp))
    if (jump) {
      for (const side of OVER_SIDES) this.over[side].set(wantOver[side])
      for (const side of SIDES) this.room[side].set(want[side])
      return
    }
    this.holdAnchor(about)
    for (const side of SIDES)
      if (this.room[side].target !== want[side] || velocity[side])
        this.room[side].to(want[side], { velocity: velocity[side], response })
    for (const side of OVER_SIDES)
      if (this.over[side].target !== wantOver[side]) this.over[side].to(wantOver[side], { response })
    this.queueRoom()
  }

  // ---------------------------------------------------------------- the window around them
  private relayout(): void {
    const vp = this.viewport()
    if (vp.w === this.last.w && vp.h === this.last.h) return
    this.last = vp
    for (const p of this.panels) p.reflow()
    this.syncRoom({ jump: true })
  }

  /** Listens to the window: its size, the phone breakpoint, and Esc during a gesture. */
  attach(): () => void {
    this.last = this.viewport()
    const relayout = () => this.relayout()
    const phoneChange = () => {
      this.last = { w: -1, h: -1 }
      this.relayout()
    }
    // Esc during a drag puts it back; before the page's own Esc, which would close the panel.
    const escapeDrag = (e: KeyboardEvent) => {
      const p = e.key === 'Escape' && this.panels.find(panel => panel.gesturing)
      if (!p) return
      e.preventDefault()
      e.stopImmediatePropagation()
      p.cancel()
    }
    addEventListener('resize', relayout)
    // The page's width also changes when its scrollbar comes or goes.
    const observer = new ResizeObserver(relayout)
    observer.observe(html())
    const phone = this.phoneQuery()
    phone?.addEventListener('change', phoneChange)
    addEventListener('keydown', escapeDrag, true)
    return () => {
      removeEventListener('resize', relayout)
      observer.disconnect()
      phone?.removeEventListener('change', phoneChange)
      removeEventListener('keydown', escapeDrag, true)
      for (const side of SIDES) this.room[side].stop()
      for (const side of OVER_SIDES) this.over[side].stop()
    }
  }
}
