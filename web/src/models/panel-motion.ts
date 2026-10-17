// The side panel's gesture rules, handles and inline style, without the DOM: what the old
// web/panel.js computed inline, so the React panel (components/panel) and the tests share it.
// Geometry (docks, sizes, limits, throws) is in panel-layout.ts.
import {
  type Dock,
  dockSize,
  type Edge,
  floatLanding,
  type Mode,
  offRect,
  outward,
  type PanelLayout,
  type Point,
  type Rect,
  type Room,
  rectFor,
  roomFor,
  type Side,
  sizeLimits,
  snap,
  type Viewport,
} from './panel-layout.ts'
import { rubberband } from './spring.ts'

export const SIDES: readonly Side[] = ['left', 'right', 'bottom']
export const EDGES: readonly Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
export const CURSOR: Record<Edge, string> = {
  n: 'row-resize',
  s: 'row-resize',
  e: 'col-resize',
  w: 'col-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
}
/** Phones (760 px and narrower) keep the full-height sheet: it flicks right, no resizing, no docks. */
export const PHONE_QUERY = '(max-width: 760px)'
/** Pulled this far (px) any way but out, a docked panel comes loose. */
export const TEAR = 56
/** A press on the head becomes a drag once the pointer has moved this far (px). */
export const DRAG_START = 6
/** Pointer samples kept for the release velocity. */
export const SAMPLES = 12
/** A loose panel thrown faster than this (px/s) lands with a little bounce. */
export const FAST_THROW = 600
/** Held still this long (ms), a loose panel aims again without the speed it had. */
export const AIM_IDLE = 120

/** A place on screen, with how shown it is (1 shown; a floating panel fades towards 0). */
export interface Place extends Rect {
  p: number
}
export type Velocity = Partial<Rect>

/** What a press on the head becomes once it moves: a floating panel moves, a docked one is flicked out or pulled loose. */
export type HeadDrag = 'move' | 'dismiss' | 'pull'

/** The edge that resizes a panel painted for `mode`: towards the board when docked, a floating one's corner, none on a phone. */
export function primaryEdge(mode: Mode): Edge | null {
  if (mode === 'right') return 'w'
  if (mode === 'left') return 'e'
  if (mode === 'bottom') return 'n'
  if (mode === 'float') return 'se'
  return null
}

/** Intent from the first move past 6 px: out along its edge flicks it away; any other way pulls it loose. */
export function headDrag(mode: Mode, dx: number, dy: number): HeadDrag | null {
  if (Math.hypot(dx, dy) < DRAG_START) return null
  if (mode === 'float') return 'move'
  const o = outward(mode)
  const along = dx * o.x + dy * o.y
  return mode === 'mobile' || (along > 0 && along >= Math.abs(dx * o.y - dy * o.x)) ? 'dismiss' : 'pull'
}

/** How far out a flicked panel is with the pointer `along` px out: 1:1, but pushed back past its place it resists. */
export function outOffset(along: number, size: number): number {
  return along >= 0 ? along : rubberband(along, size)
}

/** The pointer's speed out along the panel's way out, and as a velocity that carries it there. */
export function alongOut(mode: Mode, v: Point): { along: number; velocity: Point } {
  const o = outward(mode)
  const along = v.x * o.x + v.y * o.y
  return { along, velocity: { x: along * o.x, y: along * o.y } }
}

/** The size a docked panel's edge asks for, dragged (dx, dy) from `at`. */
export function draggedSize(mode: Side, at: Rect, dx: number, dy: number): number {
  if (mode === 'right') return at.w - dx
  if (mode === 'left') return at.w + dx
  return at.h - dy
}

/** How fast a docked panel grows (px/s) with the pointer moving at `v`. */
export function growSpeed(mode: Side, v: Point): number {
  if (mode === 'right') return -v.x
  if (mode === 'left') return v.x
  return -v.y
}

/** The springs' speeds when a docked panel's edge is let go growing at `vs`. */
export function resizeVelocity(mode: Side, vs: number): Velocity {
  if (mode === 'right') return { x: -vs, w: vs }
  if (mode === 'left') return { w: vs }
  return { y: -vs, h: vs }
}

/** Folded away, it leaves out its own side at the speed it was flung. */
export function foldVelocity(mode: Side, vs: number): Point {
  const o = outward(mode)
  return { x: Math.abs(vs) * o.x, y: Math.abs(vs) * o.y }
}

/** A floating panel's edge let go: the release speed goes to the sides that moved. */
export function floatResizeVelocity(edge: Edge, v: Point): Rect {
  return {
    x: edge.includes('w') ? v.x : 0,
    y: edge.includes('n') ? v.y : 0,
    w: edge.includes('e') ? v.x : edge.includes('w') ? -v.x : 0,
    h: edge.includes('s') ? v.y : edge.includes('n') ? -v.y : 0,
  }
}

/** The layout field a docked size is kept in. */
export const sizeField = (dock: Dock): 'side' | 'bottom' => (dock === 'bottom' ? 'bottom' : 'side')

/** Back to the default size of its place (a floating one: also the default spot). */
export function resetLayout(layout: PanelLayout): PanelLayout {
  return layout.dock === 'float' ? { ...layout, float: null } : { ...layout, [sizeField(layout.dock)]: null }
}

/** Let go loose at `at`: docked where the throw comes to rest near an edge, else floating where it glides to. */
export function thrownLayout(layout: PanelLayout, dock: Side | null, at: Rect, v: Point, vp: Viewport): PanelLayout {
  if (dock) return { ...layout, dock }
  return { ...layout, dock: 'float', float: floatLanding(at, v, vp) }
}

/**
 * Where a panel rests in its place, or (`off`) where it comes in from and leaves to. A phone's sheet
 * slides across by its own width (`sheetWidth`), keeping its size (`now`).
 */
export function restPlace(
  mode: Mode,
  layout: PanelLayout,
  vp: Viewport,
  off: boolean,
  sheetWidth: number,
  now: { w: number; h: number },
): Place {
  if (mode === 'mobile') return { x: off ? sheetWidth + 32 : 0, y: 0, w: now.w, h: now.h, p: 1 }
  const r = rectFor(layout, vp)
  return off ? { ...offRect(layout.dock, r), p: layout.dock === 'float' ? 0 : 1 } : { ...r, p: 1 }
}

export interface PanelStyle {
  width?: string
  height?: string
  transform: string
  opacity?: string
}

/** The panel's inline style at `at`: on whole device pixels; a floating one shrinks a little and fades as it comes and goes. */
export function panelStyle(mode: Mode, at: Place, dpr: number): PanelStyle {
  if (mode === 'mobile') return { transform: `translate3d(${snap(at.x, dpr)}px, 0, 0)` }
  const p = at.p
  const scale = p < 1 ? ` scale(${0.94 + 0.06 * Math.max(0, p)})` : ''
  return {
    width: `${snap(at.w, dpr)}px`,
    height: `${snap(at.h, dpr)}px`,
    transform: `translate3d(${snap(at.x, dpr)}px, ${snap(at.y, dpr)}px, 0)${scale}`,
    opacity: p < 1 ? String(Math.max(0, Math.min(1, p * 1.6))) : '',
  }
}

export interface Separator {
  orientation: 'horizontal' | 'vertical'
  min: number
  max: number
  now: number
}

/** The handles and the place button as last drawn for a place (the old syncChrome). */
export interface PanelChrome {
  mode: Mode
  /** The viewer's dock, which the place button shows. */
  glyph: Dock
  /** The resizing edge of a docked panel, for screen readers. */
  separator: Separator | null
}

export function panelChrome(mode: Mode, layout: PanelLayout, vp: Viewport): PanelChrome {
  if (mode === 'mobile' || mode === 'float') return { mode, glyph: layout.dock, separator: null }
  const { min, max } = sizeLimits(mode, vp)
  return {
    mode,
    glyph: layout.dock,
    separator: {
      orientation: mode === 'bottom' ? 'horizontal' : 'vertical',
      min,
      max: Math.round(max),
      now: Math.round(dockSize(layout, mode, vp)),
    },
  }
}

/** One edge handle: the resizing one is focusable and named, and a separator when docked. */
export function edgeChrome(edge: Edge, chrome: PanelChrome): { on: boolean; separator: Separator | null } {
  const on = edge === primaryEdge(chrome.mode)
  return { on, separator: on ? chrome.separator : null }
}

export interface RectLike {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

/** The place menu under its button (above it when there is no room below), inside the window; it grows out of the button. */
export function menuPlacement(
  button: RectLike,
  menu: { width: number; height: number },
  vp: Viewport,
): { left: number; top: number; origin: string } {
  const left = Math.max(8, Math.min(button.right - menu.width, vp.w - 8 - menu.width))
  const below = button.bottom + 6 + menu.height <= vp.h - 8
  const top = below ? button.bottom + 6 : Math.max(8, button.top - 6 - menu.height)
  return { left, top, origin: `${button.left + button.width / 2 - left}px ${below ? 0 : menu.height}px` }
}

/** The item a key moves to among `count` from item `at` (-1: none focused); null for other keys. */
export function menuStep(key: string, at: number, count: number): number | null {
  const steps: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: count - 1 }
  const go = steps[key]
  return go === undefined ? null : (go + count) % count
}

/** The room the board leaves the open panel (none on a phone, or for a floating one). */
export function roomWanted(open: boolean, phone: boolean, layout: PanelLayout, vp: Viewport): Room {
  return open && !phone ? roomFor(layout, vp) : { left: 0, right: 0, bottom: 0 }
}

/** A room margin as written to the page's --room-* property. */
export const roomValue = (v: number): string => `${Math.round(v * 10) / 10}px`

type Box = Pick<RectLike, 'top' | 'bottom' | 'height'>

/** The card the panel is about can be kept in sight: it shows between the toolbar (`top`) and a panel at the bottom. */
export function keepsAnchor(r: Box, top: number, viewH: number, roomBelow: number): boolean {
  return !!r.height && r.bottom > top && r.top < viewH - roomBelow
}

/** How far to scroll so the card kept at `y` stays there, clear of a panel at the bottom and below the toolbar; 0 when it is. */
export function anchorScroll(y: number, r: Box, top: number, viewH: number, roomBelow: number): number {
  const lowest = viewH - roomBelow - r.height - 16
  const want = Math.max(top + 8, Math.min(y, lowest))
  return Math.abs(r.top - want) > 0.5 ? r.top - want : 0
}
