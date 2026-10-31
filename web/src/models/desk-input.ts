// What the page's keys, mouse and pasted text are on an agent's display (models/rfb.ts): X keysyms
// and the display's own points and buttons.
import { DESK_KEYED } from '../../../src/core/desktop.ts'

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

/** The Globe key's names (KeyboardEvent.key or .code), where a browser gives it one. */
const GLOBE = new Set(['Fn', 'FnLock'])

/**
 * A key the owner's own system switches its input language with: Ctrl+Space (with Shift, or with
 * Option: macOS's next source), Caps Lock (iPadOS and macOS can switch with it), the Globe (Fn)
 * key. It is the owner's, never the display's: held back there or sent, the iPad does not switch.
 * The display's Caps Lock is not missed: Xvnc puts each letter it is sent in its case itself.
 */
export function switchesInput(e: { key?: string; code?: string; ctrlKey?: boolean; metaKey?: boolean }): boolean {
  const key = e.key ?? ''
  if (key === 'CapsLock' || GLOBE.has(key) || GLOBE.has(e.code ?? '')) return true
  return !!e.ctrlKey && !e.metaKey && (key === ' ' || e.code === 'Space')
}

/**
 * An iPad or an iPhone: its keys are typed in a field (its own keyboard, its input language and the
 * Globe key are a field's, not a picture's). An iPad's Safari says it is a Mac's, but a Mac has no
 * touch screen.
 */
export function appleTouch(nav: { userAgent?: string; maxTouchPoints?: number }): boolean {
  const ua = nav.userAgent ?? ''
  return /\b(iPad|iPhone|iPod)\b/.test(ua) || (/\bMacintosh\b/.test(ua) && (nav.maxTouchPoints ?? 0) > 1)
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
/**
 * How far a wheel step moves a page in the display's browser, in the display's px: 120 (measured on
 * an Xvnc of its own with the board's Chromium 156 and its flags, smooth scrolling off: up, down and
 * to either side, a whole page or a small box in it, the browser zoomed or not). It is 120 at the
 * browser's own scale, which on the board's displays is 1 (at a scale of 2 it would be 240).
 */
export const WHEEL_PX = 120

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

  constructor(
    private readonly sink: DeskSink,
    private readonly frame: (fn: () => void) => void,
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
    }
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

/** What typing needs of the display: its keys and, where it has one, its clipboard (models/rfb.ts). */
export interface TypingSink {
  key(keysym: number, down: boolean): void
  /** The display takes clipboard text as UTF-8 (the extended clipboard). */
  readonly clipboard: boolean
  announce(has: boolean): void
  provide(text: string): void
  /** `fn` once the server has done what went to it before. */
  settled(fn: () => void): void
}

/** Text longer than this (characters) goes by the display's clipboard even where every key of it is there. */
export const LONG_TEXT = 200
/** A paste the display does not ask for in this long (ms) did not happen there (nothing took it): what waits goes on. */
export const PASTE_WAIT_MS = 2000
/**
 * The server has a paste's text: this long (ms) more before the clipboard changes again. Chrome
 * there drops a paste whose clipboard changes while it is still at it: about one in ten at 100 to
 * 250 ms, none at 600 (measured on the board's Chromium with characters pasted a key apart).
 */
export const PASTE_SETTLE_MS = 600
/** The display's clipboard is emptied this long (ms) after the last paste. */
export const CLEAR_MS = 1500
const CONTROL_L = 0xffe3
const KEY_V = 0x76

const KEYED = new Set(DESK_KEYED)
/**
 * A character the display's keyboard has, typed as its key: US ASCII, a line's end, a tab, and the
 * letters and marks the board gives it (core/desktop.ts deskKeymap: Cyrillic, accented Latin, «»—…).
 */
export const keyed = (ch: string): boolean => ch === '\n' || ch === '\t' || (ch >= ' ' && ch <= '~') || KEYED.has(ch)

/**
 * Text to the display. What its keyboard has goes as keys (`keyed`: passwords too, which so never
 * reach its clipboard); the rest (an emoji, another alphabet: a key Xvnc would have to add, and it
 * has room for only a few, then drops them) goes by its clipboard: the text announced,
 * Ctrl+V, the text when the server asks for it, and the next change only once the server's turn
 * came and the program there read it; text longer than LONG_TEXT goes so whole. Its clipboard is emptied CLEAR_MS after the last paste, so what was typed or pasted
 * does not stay there. Keys and the pointer (`later`) wait behind a paste in flight, in their order;
 * with nothing in flight they go at once. A display without the extended clipboard gets keys only,
 * as before.
 */
export class DeskTyping {
  private queue: (string | (() => void))[] = []
  private pasting: { text: string; asked: boolean; waiting: ReturnType<typeof setTimeout> } | null = null
  private clearing: ReturnType<typeof setTimeout> | undefined
  /** The display's clipboard has text of the page's (not emptied yet). */
  private holds = false

  constructor(private readonly sink: TypingSink) {}

  /** Text as typed or pasted, after what waits. */
  text(text: string): void {
    if (!text) return
    this.queue.push(text)
    this.run()
  }

  /** Anything else for the display (a key, the pointer): at once, or after the paste in flight and what waits. */
  later(fn: () => void): void {
    if (!this.pasting && !this.queue.length) fn()
    else this.queue.push(fn)
  }

  /** The server asks for the text announced (a program there pastes): it goes, and what waits after the server's turn. */
  wanted(): void {
    const p = this.pasting
    if (!p || p.asked) return
    p.asked = true
    clearTimeout(p.waiting)
    this.sink.provide(p.text)
    this.sink.settled(() => {
      p.waiting = setTimeout(() => this.done(p), PASTE_SETTLE_MS)
    })
  }

  /** What waits dropped and the display's clipboard emptied (control given back, the view gone). */
  stop(): void {
    this.queue = []
    if (this.pasting) clearTimeout(this.pasting.waiting)
    this.pasting = null
    this.clear()
  }

  private run(): void {
    while (!this.pasting && this.queue.length) {
      const next = this.queue.shift() as string | (() => void)
      if (typeof next === 'function') {
        next()
        continue
      }
      let text = next
      while (typeof this.queue[0] === 'string') text += this.queue.shift()
      this.type(text)
    }
  }

  private type(text: string): void {
    const chars = [...text]
    const first = chars.findIndex(ch => !keyed(ch))
    if (this.sink.clipboard && chars.length > LONG_TEXT) {
      this.paste(text)
      return
    }
    if (!this.sink.clipboard || first < 0) {
      this.press(text)
      return
    }
    // up to the first that no key types as keys; from it to the last such before a line's end, one paste; then the rest
    let last = first
    for (let i = first + 1; i < chars.length && chars[i] !== '\n' && chars[i] !== '\t'; i++)
      if (!keyed(chars[i] as string)) last = i
    this.press(chars.slice(0, first).join(''))
    const rest = chars.slice(last + 1).join('')
    if (rest) this.queue.unshift(rest)
    this.paste(chars.slice(first, last + 1).join(''))
  }

  private press(text: string): void {
    for (const keysym of textKeysyms(text)) {
      this.sink.key(keysym, true)
      this.sink.key(keysym, false)
    }
  }

  private paste(text: string): void {
    clearTimeout(this.clearing)
    const p = { text, asked: false, waiting: setTimeout(() => this.done(p), PASTE_WAIT_MS) }
    this.pasting = p
    this.holds = true
    this.sink.announce(true)
    this.sink.key(CONTROL_L, true)
    this.sink.key(KEY_V, true)
    this.sink.key(KEY_V, false)
    this.sink.key(CONTROL_L, false)
  }

  private done(p: NonNullable<DeskTyping['pasting']>): void {
    if (this.pasting !== p) return
    clearTimeout(p.waiting)
    this.pasting = null
    this.run()
    if (!this.pasting && this.holds) {
      clearTimeout(this.clearing)
      this.clearing = setTimeout(() => this.clear(), CLEAR_MS)
    }
  }

  private clear(): void {
    clearTimeout(this.clearing)
    if (!this.holds || this.pasting) return
    this.holds = false
    this.sink.announce(false)
  }
}
