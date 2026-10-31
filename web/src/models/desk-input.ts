// What the page's keys, mouse and pasted text are on an agent's display (models/rfb.ts): X keysyms
// and the display's own points and buttons.

/** Keys by the page's name for them (KeyboardEvent.key); a side's own by its code. */
const NAMED: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Pause: 0xff13,
  ScrollLock: 0xff14,
  Escape: 0xff1b,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  PrintScreen: 0xff61,
  Insert: 0xff63,
  ContextMenu: 0xff67,
  NumLock: 0xff7f,
  CapsLock: 0xffe5,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffeb,
  AltGraph: 0xfe03,
  Delete: 0xffff,
}
const RIGHT: Record<string, number> = {
  ShiftRight: 0xffe2,
  ControlRight: 0xffe4,
  AltRight: 0xffea,
  MetaRight: 0xffec,
}

/** A character's keysym: Latin-1 as it is, any other by its code point. */
function charKeysym(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) ? cp : 0x01000000 + cp
}

/** The keysym of a key the page heard, or null for one it cannot say (a dead key, an input method's). */
export function keysymOf(key: string, code: string): number | null {
  if ([...key].length === 1) return charKeysym(key)
  const right = RIGHT[code]
  if (right !== undefined && NAMED[key] !== undefined) return right
  const named = NAMED[key]
  if (named !== undefined) return named
  const f = /^F(\d{1,2})$/.exec(key)
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 24) return 0xffbe + Number(f[1]) - 1
  return null
}

/** Pasted text as the keys that type it: a line's end as Return, a tab as Tab. */
export function textKeysyms(text: string): number[] {
  const out: number[] = []
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    if (ch === '\n') out.push(0xff0d)
    else if (ch === '\t') out.push(0xff09)
    else out.push(charKeysym(ch))
  }
  return out
}

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * The display's point under (clientX, clientY), its picture shown in `box` as large as fits and
 * centred (the canvas's object-fit: contain); null before the display has a size.
 */
export function screenPoint(
  box: Box,
  width: number,
  height: number,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (width <= 0 || height <= 0 || box.width <= 0 || box.height <= 0) return null
  const scale = Math.min(box.width / width, box.height / height)
  const left = box.left + (box.width - width * scale) / 2
  const top = box.top + (box.height - height * scale) / 2
  const within = (n: number, max: number) => Math.max(0, Math.min(max - 1, Math.floor(n)))
  return { x: within((clientX - left) / scale, width), y: within((clientY - top) / scale, height) }
}

/** The page's buttons (left 1, right 2, middle 4) as VNC's (left 1, middle 2, right 4). */
export function buttonMask(buttons: number): number {
  return (buttons & 1) | (buttons & 2 ? 4 : 0) | (buttons & 4 ? 2 : 0)
}

/** The wheel, a step up or down: a button pressed and let go. */
export const WHEEL_UP = 8
export const WHEEL_DOWN = 16
/** The wheel to the side, a step left or right (buttons 6 and 7). */
export const WHEEL_LEFT = 32
export const WHEEL_RIGHT = 64
/** How far a wheel step moves a page in the display's browser (Chrome on X: 53 px). */
export const WHEEL_PX = 53

/** The page's px per display px, its picture shown in `box` as screenPoint has it; 0 before it has a size. */
export function shownScale(box: Box, width: number, height: number): number {
  if (width <= 0 || height <= 0 || box.width <= 0 || box.height <= 0) return 0
  return Math.min(box.width / width, box.height / height)
}

/**
 * The picture zoomed in the board (a pinch), not on the display: `z` times as large, moved by `fx`
 * and `fy` of its own box. Its box on the page (getBoundingClientRect) is the zoomed one, so
 * screenPoint reads a point on it as it reads one on the picture unzoomed.
 */
export interface Zoom {
  z: number
  fx: number
  fy: number
}
export const NO_ZOOM: Zoom = { z: 1, fx: 0, fy: 0 }
export const MAX_ZOOM = 4

/**
 * A pinch going on: the picture `ratio` times as large as it was at `zoom` when it began (its box
 * then `box`), its point that was under `from` (the fingers' middle then) under `to` (their middle
 * now); never smaller than its box nor off it.
 */
export function pinched(
  zoom: Zoom,
  box: Box,
  from: { x: number; y: number },
  to: { x: number; y: number },
  ratio: number,
): Zoom {
  if (box.width <= 0 || box.height <= 0 || !(ratio > 0)) return zoom
  const width = box.width / zoom.z
  const height = box.height / zoom.z
  const left = box.left - zoom.fx * width
  const top = box.top - zoom.fy * height
  const z = Math.max(1, Math.min(MAX_ZOOM, zoom.z * ratio))
  const along = (n: number) => Math.max(1 - z, Math.min(0, n))
  return {
    z,
    fx: along((to.x - left) / width - ((from.x - box.left) / box.width) * z),
    fy: along((to.y - top) / height - ((from.y - box.top) / box.height) * z),
  }
}

/** The zoom as the picture's CSS transform (from its top left corner); '' unzoomed. */
export function zoomTransform(zoom: Zoom): string {
  if (zoom.z <= 1) return ''
  const n = (v: number) => Number(v.toFixed(4))
  return `translate(${n(zoom.fx * 100)}%, ${n(zoom.fy * 100)}%) scale(${n(zoom.z)})`
}

/** Where the display's mouse and keys go (models/rfb.ts RfbClient). */
export interface DeskSink {
  pointer(x: number, y: number, mask: number): void
  key(keysym: number, down: boolean): void
}

type Held = { x: number; y: number; mask: number; steps?: { x: number; y: number } }

/**
 * What goes to the display, a frame at a time: the pointer's moves (a mouse, a pen over the
 * picture, a held finger's drag) wait for the next frame (`frame`), and only the last of them goes;
 * the wheel's steps at a place (a finger's swipe, the wheel) are summed and go then too. A button
 * pressed or let go and a key go at once, after what waits: nothing is held back longer or sent
 * out of its order. A 120 Hz finger or trackpad sends no more moves than the screen shows.
 */
export class InputQueue {
  private held: Held[] = []
  /** The buttons as last given (sent, or waiting). */
  private mask = 0
  private waiting = false

  /** `stepped`: after a flush that sent wheel steps, their sum (down and right positive). */
  constructor(
    private readonly sink: DeskSink,
    private readonly frame: (fn: () => void) => void,
    private readonly stepped: (x: number, y: number) => void = () => {},
  ) {}

  /** The pointer at (x, y) with these buttons: a move waits for the frame; a button changed goes at once. */
  pointer(x: number, y: number, mask: number): void {
    if (mask !== this.mask) {
      this.flush()
      this.mask = mask
      this.sink.pointer(x, y, mask)
      return
    }
    const last = this.held.at(-1)
    if (last && !last.steps) {
      last.x = x
      last.y = y
    } else this.held.push({ x, y, mask })
    this.later()
  }

  /** A wheel step (WHEEL_UP, _DOWN, _LEFT, _RIGHT) at (x, y) with `mask` held: summed with the frame's others there. */
  wheel(x: number, y: number, mask: number, step: number): void {
    if (mask !== this.mask) {
      this.flush()
      this.mask = mask
    }
    let last = this.held.at(-1)
    if (!last?.steps || last.x !== x || last.y !== y) {
      last = { x, y, mask, steps: { x: 0, y: 0 } }
      this.held.push(last)
    }
    const steps = last.steps as { x: number; y: number }
    if (step === WHEEL_UP) steps.y--
    else if (step === WHEEL_DOWN) steps.y++
    else if (step === WHEEL_LEFT) steps.x--
    else if (step === WHEEL_RIGHT) steps.x++
    this.later()
  }

  /** A key down or up: at once, after what waits. */
  key(keysym: number, down: boolean): void {
    this.flush()
    this.sink.key(keysym, down)
  }

  /** What waits, sent now. */
  flush(): void {
    const held = this.held
    this.held = []
    let sx = 0
    let sy = 0
    for (const h of held) {
      if (!h.steps) {
        this.sink.pointer(h.x, h.y, h.mask)
        continue
      }
      const press = (n: number, back: number, on: number) => {
        for (let i = 0; i < Math.abs(n); i++) {
          this.sink.pointer(h.x, h.y, h.mask | (n < 0 ? back : on))
          this.sink.pointer(h.x, h.y, h.mask)
        }
      }
      press(h.steps.y, WHEEL_UP, WHEEL_DOWN)
      press(h.steps.x, WHEEL_LEFT, WHEEL_RIGHT)
      sx += h.steps.x
      sy += h.steps.y
    }
    if (sx || sy) this.stepped(sx, sy)
  }

  private later(): void {
    if (this.waiting) return
    this.waiting = true
    this.frame(() => {
      this.waiting = false
      this.flush()
    })
  }
}
