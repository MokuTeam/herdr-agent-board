// An agent's display while it is shown (components/sheet/BrowserFold.tsx): a WebSocket to it through
// the board, read by the board's own VNC client (models/rfb.ts), and a canvas of its own that the
// fold or full size puts where it shows. Its picture comes as H.264 video on a second WebSocket
// where the page can decode it (WebCodecs, models/desk-video.ts) and the board can make it
// (ffmpeg): the VNC connection then asks for no picture and carries the input and the pings; where
// not (no WebCodecs, no ffmpeg, a codec the decoder does not take, no frame in VIDEO_WAIT_MS, the
// video ended), the VNC picture as before. A video that stops after it drew starts its decoder
// again from a key frame, then opens its socket again, then (stopped again within REOPEN_MS) goes
// to the VNC picture: never a picture that stands still for good. Shown only while `on`: off, the
// sockets close, with no picture and no traffic, and the agent's browser runs on. Nothing goes to the display but the
// requests for its picture until `controlling`: then the mouse, the keys and pasted text (typed as
// keys) on the canvas go to it, and leave the board's own shortcuts alone; what switches the owner's
// input language (Ctrl+Space, Caps Lock, the Globe key) stays the owner's. A finger's or a pen's
// tap brings up the screen's keyboard (a canvas brings up none): its text goes as keys too; on an
// iPad (an iPhone) a hardware keyboard's too, once a key or a trackpad's click is on the picture. A
// finger as on a tablet's remote desktop: a tap clicks, a swipe scrolls, held still it drags, a
// pinch zooms the picture in the board. Text the display's keyboard has no keys for (an emoji,
// another alphabet than those the board gives it), and long pastes, go by its clipboard
// (models/desk-input.ts DeskTyping); what is copied there, while the owner has it, the view offers
// to copy to the owner's own (`copied`, `copyOut`).
import { useEffect, useRef, useState } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { pageLog } from '../api/client.ts'
import { desktopSocketUrl } from '../api/desktop.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import {
  appleTouch,
  buttonMask,
  DeskTyping,
  InputQueue,
  keyed,
  keysymOf,
  NO_ZOOM,
  pinched,
  screenPoint,
  shownScale,
  switchesInput,
  WHEEL_DOWN,
  WHEEL_LEFT,
  WHEEL_PX,
  WHEEL_RIGHT,
  WHEEL_UP,
  type Zoom,
  zoomTransform,
} from '../models/desk-input.ts'
import { DeskMeter, type MeterVia } from '../models/desk-meter.ts'
import { canvasScreen } from '../models/desk-screen.ts'
import { type Codecs, DeskVideo, webCodecs } from '../models/desk-video.ts'
import { RfbClient, type RfbFailure } from '../models/rfb.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'

export type DeskState = 'off' | 'connecting' | 'live' | 'closed' | 'failed'

export interface DeskView {
  state: DeskState
  /** Why it is not shown (closed, failed), in the board's words; '' otherwise. */
  why: string
  /** The display's picture while on, for the fold or full size to put where it shows. */
  canvas: HTMLCanvasElement | null
  /** The link's round trip, frames a second and what the picture comes by, for the picture's corner (with the canvas). */
  meter: HTMLElement | null
  /** Something was copied in its browser while the owner has it: the view offers to copy it to the owner's own. */
  copied: boolean
  /**
   * What was copied there, onto the owner's clipboard (call it in the tap's own handler: a browser
   * copies only so); the offer goes. Resolves once it is there, rejects with why not.
   */
  copyOut(): Promise<void>
  /** Text into its browser where its cursor is, as if typed (the owner's clipboard, read by a button). */
  type(text: string): void
  /** Connect again after it closed or failed. */
  retry(): void
}

/** Pasted text typed on the display, at most this long. */
const MAX_PASTE = 10_000
/** The wheel's travel (px) that makes one step on the display. */
const WHEEL_STEP = 50
const OPEN = 1

const whyText = (why: RfbFailure, t: Translator): string =>
  t('desk.failed', {
    why: why.code === 'refused' ? why.detail : t(`desk.why.${why.code}`, { what: why.detail }),
  })

export interface DeskInput {
  detach(): void
  /** Text typed or pasted, as the field's (models/desk-input.ts DeskTyping). */
  type(text: string): void
  /** Keys and buttons still down go up on the display (control given back, the canvas left). */
  release(): void
  /** Control given back: what is down goes up, a touch screen's keyboard goes, the picture fits again. */
  stop(): void
}

/**
 * What a touch screen's keyboard types into (the field by the picture): kept at this, so that a
 * Backspace always has something to take and what came or went is read against it.
 */
export const KEYS_AT = '__________'
const BACKSPACE = 0xff08

/** A finger or a pen, not a mouse: the picture brings up no keyboard on screen for it. */
const touching = (e: PointerEvent): boolean => e.pointerType === 'touch' || e.pointerType === 'pen'

/** The next frame the page draws (a moment, where it draws none). */
const nextFrame = (fn: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn())
  else setTimeout(fn, 16)
}

/** A finger held this long (ms) without moving presses the button: what it moves then drags. */
export const HOLD_MS = 500
/** A finger that goes farther than this (px) from where it went down swipes rather than taps. */
const SLOP = 10
/** A tap this soon (ms) and this near (px) after the one before lands where it did: a double click there. */
const AGAIN_MS = 500
const AGAIN_PX = 24
/** A pinch let go of nearer than this to the picture as it fits: as it fits. */
const ZOOM_SNAP = 1.1

type Point = { x: number; y: number }
const apart = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const middleOf = (points: Point[]): Point => ({
  x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
  y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
})

/**
 * What the fingers on the picture do now: `wait` one down, not yet a tap, a swipe or a hold;
 * `two` two down, not yet a swipe or a pinch; `swipe` the wheel; `pinch` the picture zoomed here;
 * `hold` the button down; `over` done, until the fingers are lifted.
 */
type Gesture = 'wait' | 'two' | 'swipe' | 'pinch' | 'hold' | 'over'

/** Copied to the page's clipboard: the clipboard API where the page has it (https, localhost), else a field selected and the copy command. */
export function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function')
    return navigator.clipboard.writeText(text)
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.setAttribute('class', 'desk-keys')
  document.body.appendChild(field)
  field.select?.()
  field.setSelectionRange?.(0, text.length)
  const ok = typeof document.execCommand === 'function' && document.execCommand('copy')
  document.body.removeChild(field)
  return ok ? Promise.resolve() : Promise.reject(new Error('copy'))
}

/**
 * The canvas's mouse, wheel, keys and pastes to the display, while `controlling()`. A tap (a
 * finger or a pen) puts the keys in a field of their own by the picture instead (`label`: its
 * name), which brings up the screen's keyboard: what it types comes as text, its other keys as on
 * the canvas. A finger, as a remote desktop on a tablet has it: a tap clicks, a swipe of one or
 * two scrolls the display's page (its wheel), held still a moment it presses the button and drags,
 * a pinch zooms the picture in the board. A mouse goes as it always did; on an iPad (an iPhone) its
 * keys, and those of a key pressed on the picture, go to the field from then on (its input language
 * switches there, not on a picture). What switches the owner's input language is never the display's.
 */
export function attachInput(
  canvas: HTMLElement,
  rfb: RfbClient,
  controlling: () => boolean,
  label: () => string = () => '',
  /** Its typing, for the display's requests for the clipboard text it announced. */
  withTyping: (typing: { wanted(): void }) => void = () => {},
): DeskInput {
  // moves and wheel steps a frame at a time; buttons and keys at once (models/desk-input.ts)
  const out = new InputQueue(rfb, nextFrame)
  // text as keys, or what no key types by the display's clipboard; keys and the pointer after a
  // paste in flight, in their order (at once with none)
  const typing = new DeskTyping({
    key: (keysym, down) => out.key(keysym, down),
    get clipboard() {
      return rfb.clipboard
    },
    announce: has => rfb.announce(has),
    provide: text => rfb.provide(text),
    settled: fn => rfb.settled(fn),
  })
  withTyping(typing)
  const send = {
    pointer: (x: number, y: number, mask: number) => typing.later(() => out.pointer(x, y, mask)),
    wheel: (x: number, y: number, mask: number, step: number) => typing.later(() => out.wheel(x, y, mask, step)),
    key: (keysym: number, down: boolean) => typing.later(() => out.key(keysym, down)),
    flush: () => typing.later(() => out.flush()),
  }
  const keys = new Map<string, number>()
  let mask = 0
  let last = { x: 0, y: 0 }
  let wheel = 0
  let touched = false
  let field: HTMLTextAreaElement | null = null
  // An iPad's (an iPhone's) keys are typed in the field, a keyboard of its own too: there its input
  // language switches (the Globe key, Ctrl+Space), on a picture it does not.
  const keysInField = typeof navigator !== 'undefined' && appleTouch(navigator)
  const at = (e: { clientX: number; clientY: number }) =>
    screenPoint(canvas.getBoundingClientRect(), rfb.width, rfb.height, e.clientX, e.clientY)
  const atPoint = (p: Point) => at({ clientX: p.x, clientY: p.y })
  const point = (e: PointerEvent) => {
    const p = at(e)
    if (!p) return
    last = p
    mask = buttonMask(e.buttons)
    send.pointer(p.x, p.y, mask)
  }
  const release = () => {
    for (const keysym of keys.values()) send.key(keysym, false)
    keys.clear()
    if (mask) send.pointer(last.x, last.y, 0)
    mask = 0
  }
  const press = (keysyms: number[]) => {
    for (const keysym of keysyms) {
      send.key(keysym, true)
      send.key(keysym, false)
    }
  }
  const keyDown = (e: Event) => {
    const k = e as KeyboardEvent
    // The board's own keys (its shortcuts, Esc closing the panel) stay out of it.
    e.stopPropagation()
    // What switches the owner's input language (Ctrl+Space, Caps Lock, the Globe key) is the owner's
    // system's: not held back, not sent.
    if (switchesInput(k)) return
    // A paste: its text comes as keys (paste, below), not as Ctrl+V on the display; the field takes
    // it (a picture is no place a browser pastes into: Safari fires no paste there).
    if ((k.ctrlKey || k.metaKey) && k.key?.toLowerCase() === 'v') return catchPaste()
    // A character the display's keyboard has no key for (an emoji, another alphabet): as text.
    const ch = k.key ?? ''
    if (rfb.clipboard && [...ch].length === 1 && !keyed(ch) && !k.metaKey && (!k.ctrlKey || k.altKey)) {
      e.preventDefault()
      typing.text(ch)
      return
    }
    const keysym = keysymOf(k.key ?? '', k.code ?? '')
    if (keysym === null) return
    e.preventDefault()
    keys.set(k.code || k.key, keysym)
    send.key(keysym, true)
  }
  const keyUp = (e: Event) => {
    const k = e as KeyboardEvent
    e.stopPropagation()
    const id = k.code || k.key
    const keysym = keys.get(id)
    if (keysym === undefined) return
    e.preventDefault()
    keys.delete(id)
    send.key(keysym, false)
  }
  const paste = (e: Event) => {
    e.preventDefault()
    const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''
    // The Ctrl held for the paste goes up first, so the text types as text.
    release()
    typing.text(text.slice(0, MAX_PASTE))
  }

  // ------------------------------------------------ a touch screen's keyboard
  const keepField = () => {
    if (!field) return
    field.value = KEYS_AT
    field.setSelectionRange?.(KEYS_AT.length, KEYS_AT.length)
  }
  // What the field has now against what it was kept at: Backspaces for what went, then what came.
  const typed = () => {
    if (!field) return
    const now = field.value
    if (controlling()) {
      let same = 0
      while (same < KEYS_AT.length && now[same] === KEYS_AT[same]) same++
      press(new Array<number>(KEYS_AT.length - same).fill(BACKSPACE))
      typing.text(now.slice(same, same + MAX_PASTE))
    }
    keepField()
  }
  const fieldHandlers: Record<string, (e: Event) => void> = {
    keydown(e) {
      if (!controlling()) return
      const k = e as KeyboardEvent
      // A character comes as text (input, below), however the keyboard made it: its own keys, an
      // input method's word, a suggestion; the rest (Return, Backspace, arrows, Ctrl and the like)
      // as on the canvas.
      if (k.isComposing || ([...(k.key ?? '')].length === 1 && !k.ctrlKey && !k.metaKey && !k.altKey)) {
        e.stopPropagation()
        return
      }
      keyDown(e)
    },
    keyup(e) {
      if (controlling()) keyUp(e)
    },
    input(e) {
      if (!(e as InputEvent).isComposing) typed()
    },
    compositionend: typed,
    paste(e) {
      if (controlling()) paste(e)
      // a paste the picture's Ctrl/Cmd+V sent here: the picture has the keys again
      if (pasted) back()
    },
    blur: release,
  }
  /** The field by the picture (wherever it shows now). */
  const fieldHere = (): HTMLTextAreaElement => {
    if (!field) {
      field = document.createElement('textarea')
      field.setAttribute('class', 'desk-keys')
      field.setAttribute('aria-label', label())
      // What it types goes as it is: no capitals, corrections or suggestions of the keyboard's own,
      // and no language of its own (not the board's, which the screen's keyboard may then keep to):
      // the keyboard the owner picks (its globe key) stays.
      const plain = { autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', lang: '' }
      for (const [name, value] of Object.entries({ ...plain, tabindex: '-1', rows: '1' }))
        field.setAttribute(name, value)
      for (const [type, fn] of Object.entries(fieldHandlers)) field.addEventListener(type, fn)
    }
    if (field.parentNode !== canvas.parentNode) canvas.parentNode?.insertBefore(field, canvas.nextSibling)
    return field
  }
  /** The field by the picture, with the keys in it: the screen's keyboard comes up. */
  const keyboard = () => {
    const f = fieldHere()
    if (document.activeElement === f) return
    keepField()
    f.focus({ preventScroll: true })
  }
  // Ctrl/Cmd+V on the picture: the field has the keys for the paste, then the picture again (at the
  // paste, or a moment later where none came: nothing on the clipboard).
  let pasted = false
  let backing: ReturnType<typeof setTimeout> | undefined
  const back = () => {
    clearTimeout(backing)
    if (!pasted) return
    pasted = false
    if (document.activeElement === field) canvas.focus()
  }
  const catchPaste = () => {
    const f = fieldHere()
    if (document.activeElement === f) return
    keepField()
    f.focus({ preventScroll: true })
    pasted = true
    clearTimeout(backing)
    backing = setTimeout(back, 1000)
  }

  // ------------------------------------------------ a finger's (or a pen's) gestures
  /** The fingers on the picture now, where each is (the page's px). */
  const fingers = new Map<number, Point>()
  let gesture: Gesture = 'over'
  /** Where the gesture began (the two fingers' middle once two are down): where it clicks or scrolls. */
  let start: Point = { x: 0, y: 0 }
  /**
   * A swipe: the fingers' middle when it was last reckoned, what it went (display px) that no wheel
   * step has gone yet, and the way it keeps to.
   */
  let was: Point = start
  let swept: Point = { x: 0, y: 0 }
  let keepTo: 'x' | 'y' | 'xy' | null = null
  let holding: ReturnType<typeof setTimeout> | undefined
  let holder = -1
  let zoom = NO_ZOOM
  /** Two fingers down: where each was then, the picture's zoom and box then. */
  let two = { a: start, b: start, zoom, box: { left: 0, top: 0, width: 0, height: 0 } }
  let tapped = { at: Number.NEGATIVE_INFINITY, client: start, point: start }
  const pair = () => [...fingers.values()].slice(0, 2)
  const middle = () => middleOf([...fingers.values()])
  const unhold = () => {
    clearTimeout(holding)
    holding = undefined
  }
  const zoomTo = (to: Zoom) => {
    zoom = to
    canvas.style.transform = zoomTransform(to)
    canvas.style.transformOrigin = to.z > 1 ? '0 0' : ''
  }
  // Held still a moment: the button goes down where the finger is, and stays down while it moves.
  const held = () => {
    holding = undefined
    const p = gesture === 'wait' && controlling() ? atPoint(start) : null
    if (!p) return
    gesture = 'hold'
    canvas.setAttribute('data-held', '')
    last = p
    mask = 1
    send.pointer(p.x, p.y, mask)
  }
  // A tap: a click where the finger went down; one soon after and near the one before, where that
  // one clicked (a finger is not so exact: the display sees a double click).
  const tap = (when: number) => {
    const p = atPoint(start)
    if (!p) return
    const again = when - tapped.at < AGAIN_MS && apart(start, tapped.client) < AGAIN_PX
    const q = again ? tapped.point : p
    tapped = { at: when, client: start, point: q }
    last = q
    mask = 0
    send.pointer(q.x, q.y, 1)
    send.pointer(q.x, q.y, 0)
  }
  // What the fingers' middle went, in the display's px at the picture's scale as it shows now
  // (zoomed by a pinch or not), as the wheel's steps where the swipe began: the page follows the
  // finger one to one (one going up shows what is under: the wheel down); what a step has not gone
  // yet is kept for the next, so a slow swipe goes as far as a quick one.
  const swipe = () => {
    const now = middle()
    const scale = shownScale(canvas.getBoundingClientRect(), rfb.width, rfb.height)
    const p = atPoint(start)
    if (!scale || !p) return
    swept = { x: swept.x + (now.x - was.x) / scale, y: swept.y + (now.y - was.y) / scale }
    was = now
    // Begun mostly up or down (or to the side): that way only, as a tablet's own page scrolls.
    const [x, y] = [Math.abs(swept.x), Math.abs(swept.y)]
    keepTo ??= y >= 2 * x ? 'y' : x >= 2 * y ? 'x' : 'xy'
    if (keepTo === 'y') swept.x = 0
    if (keepTo === 'x') swept.y = 0
    // Past half a step, a step (more than half: just half, the step would leave just half the other
    // way, and back and forth without end).
    const steps = (along: 'x' | 'y', back: number, on: number) => {
      while (Math.abs(swept[along]) > WHEEL_PX / 2) {
        const bit = swept[along] > 0 ? back : on
        send.wheel(p.x, p.y, mask, bit)
        swept[along] -= Math.sign(swept[along]) * WHEEL_PX
      }
    }
    steps('y', WHEEL_UP, WHEEL_DOWN)
    steps('x', WHEEL_LEFT, WHEEL_RIGHT)
  }
  const pinch = () => {
    const [a, b] = pair()
    if (!a || !b) return
    const from = apart(two.a, two.b)
    zoomTo(pinched(two.zoom, two.box, middleOf([two.a, two.b]), middleOf([a, b]), from > 0 ? apart(a, b) / from : 1))
  }
  const fingerDown = (e: PointerEvent) => {
    canvas.setPointerCapture?.(e.pointerId)
    const p = { x: e.clientX, y: e.clientY }
    fingers.set(e.pointerId, p)
    if (fingers.size === 1) {
      gesture = 'wait'
      start = { ...p }
      was = { ...p }
      swept = { x: 0, y: 0 }
      keepTo = null
      holder = e.pointerId
      unhold()
      holding = setTimeout(held, HOLD_MS)
      return
    }
    // Two fingers or more: no keyboard; two before the first did anything: a swipe or a pinch.
    touched = false
    if (gesture === 'wait') {
      unhold()
      gesture = 'two'
      const [a = p, b = p] = pair()
      two = { a: { ...a }, b: { ...b }, zoom, box: canvas.getBoundingClientRect() }
      start = middleOf([a, b])
    }
    was = middle()
  }
  const fingerMove = (e: PointerEvent) => {
    const finger = fingers.get(e.pointerId)
    if (!finger) {
      // A pen over the picture, not on it: the pointer goes there, as it did.
      if (!fingers.size && !e.buttons) point(e)
      return
    }
    finger.x = e.clientX
    finger.y = e.clientY
    if (gesture === 'hold') {
      const p = e.pointerId === holder ? at(e) : null
      if (!p) return
      last = p
      send.pointer(p.x, p.y, mask)
      return
    }
    if (gesture === 'wait' && apart(finger, start) > SLOP) {
      unhold()
      gesture = 'swipe'
      touched = false
    } else if (gesture === 'two') {
      // Each finger's own way: one alone gone some way, or both, says which. (One may be heard
      // before the other in the same moment: alone, a swipe's first finger looks like a pinch.)
      const [a = finger, b = finger] = pair()
      const [ma, mb] = [apart(a, two.a), apart(b, two.b)]
      if ((ma > 0 && mb > 0 && Math.max(ma, mb) > SLOP) || Math.max(ma, mb) > 3 * SLOP) {
        const moved = apart(middleOf([a, b]), middleOf([two.a, two.b]))
        const spread = Math.abs(apart(a, b) - apart(two.a, two.b))
        gesture = spread > moved ? 'pinch' : 'swipe'
      }
    }
    if (gesture === 'swipe') swipe()
    else if (gesture === 'pinch') pinch()
  }
  const fingerUp = (e: PointerEvent, cancelled: boolean) => {
    if (!fingers.delete(e.pointerId)) return
    if (gesture === 'wait') {
      unhold()
      gesture = 'over'
      if (cancelled) return
      tap(e.timeStamp)
      keyboard()
    } else if (gesture === 'hold' && e.pointerId === holder) {
      const p = (cancelled ? null : at(e)) ?? last
      last = p
      mask = 0
      send.pointer(p.x, p.y, 0)
      canvas.removeAttribute('data-held')
      gesture = 'over'
      if (!cancelled) keyboard()
    } else if (gesture === 'two' || gesture === 'pinch') {
      if (zoom.z < ZOOM_SNAP) zoomTo(NO_ZOOM)
      gesture = 'over'
    } else if (fingers.size) was = middle()
    // all lifted: a swipe's last steps go now, not a frame later
    if (!fingers.size) send.flush()
  }
  /** The fingers forgotten, the button up and the picture as it fits (control given back, the canvas gone). */
  const unfinger = () => {
    unhold()
    fingers.clear()
    gesture = 'over'
    canvas.removeAttribute('data-held')
    zoomTo(NO_ZOOM)
  }

  const handlers: Record<string, (e: Event) => void> = {
    pointerdown(e) {
      if (!controlling()) return
      e.preventDefault()
      // A mouse's keys come to the picture; a finger's from the keyboard its tap brings up (below).
      touched = touching(e as PointerEvent)
      if (touched) return fingerDown(e as PointerEvent)
      // an iPad's trackpad: its keys to the field
      if (keysInField) keyboard()
      else canvas.focus()
      canvas.setPointerCapture?.((e as PointerEvent).pointerId)
      point(e as PointerEvent)
    },
    pointermove(e) {
      if (!controlling()) return
      if (touching(e as PointerEvent)) fingerMove(e as PointerEvent)
      else point(e as PointerEvent)
    },
    pointerup(e) {
      if (!controlling()) return
      if (touching(e as PointerEvent)) fingerUp(e as PointerEvent, false)
      else point(e as PointerEvent)
    },
    pointercancel(e) {
      if (touching(e as PointerEvent)) fingerUp(e as PointerEvent, true)
    },
    // Safari's own pinch (its page zoom) stays off the picture while the fingers are the display's.
    gesturestart(e) {
      if (controlling()) e.preventDefault()
    },
    // The click a tap makes, should the keyboard not have come up at its let go.
    click() {
      if (touched && controlling()) keyboard()
    },
    wheel(e) {
      if (!controlling()) return
      e.preventDefault()
      const w = e as WheelEvent
      const p = at(w)
      if (!p) return
      wheel += w.deltaMode === 0 ? w.deltaY : w.deltaY * 40
      while (Math.abs(wheel) >= WHEEL_STEP) {
        send.wheel(p.x, p.y, mask, wheel < 0 ? WHEEL_UP : WHEEL_DOWN)
        wheel -= Math.sign(wheel) * WHEEL_STEP
      }
    },
    contextmenu(e) {
      if (controlling()) e.preventDefault()
    },
    keydown(e) {
      if (!controlling()) return
      // A key on an iPad's picture: a keyboard of its own is there, the field has its keys from now
      // on; this one goes as on the picture.
      if (keysInField) keyboard()
      keyDown(e)
    },
    keyup(e) {
      if (controlling()) keyUp(e)
    },
    paste(e) {
      if (controlling()) paste(e)
    },
    blur: release,
  }
  for (const [type, fn] of Object.entries(handlers))
    canvas.addEventListener(type, fn, type === 'wheel' ? { passive: false } : undefined)
  return {
    detach() {
      unhold()
      clearTimeout(backing)
      typing.stop()
      for (const [type, fn] of Object.entries(handlers)) canvas.removeEventListener(type, fn)
      if (!field) return
      for (const [type, fn] of Object.entries(fieldHandlers)) field.removeEventListener(type, fn)
      field.parentNode?.removeChild(field)
      field = null
    },
    type(text) {
      if (!controlling()) return
      release()
      typing.text(text.slice(0, MAX_PASTE))
    },
    release,
    stop() {
      // what waits behind a paste goes, and the display's clipboard is emptied; then what is down goes up
      typing.stop()
      release()
      unfinger()
      touched = false
      clearTimeout(backing)
      pasted = false
      field?.blur()
    },
  }
}

const OFF = { state: 'off' as DeskState, why: '', canvas: null, meter: null }
type Shown = Pick<DeskView, 'state' | 'why' | 'canvas' | 'meter'>
/** A ping every this many seconds, and the board's log a line every this many. */
const PING_S = 2
const LOG_S = 60
/** No video frame this long after the view opened: the VNC picture instead. */
export const VIDEO_WAIT_MS = 5000
/** The video's socket opened again for want of frames: again within this long, the VNC picture instead. */
export const REOPEN_MS = 60_000

export function useDesktop(key: string, on: boolean, controlling: boolean): DeskView {
  const t = useLatest(useT())
  const control = useLatest(controlling)
  const token = useBoardContext().data?.fsToken ?? ''
  const [view, setView] = useState<Shown>(OFF)
  const [attempt, setAttempt] = useState(0)
  const input = useRef<DeskInput | null>(null)
  const display = useRef<RfbClient | null>(null)
  // what was copied there (never shown, never logged): offered until taken, control given back or the view gone
  const clip = useRef('')
  const [copied, setCopied] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: another attempt is when to connect again
  useEffect(() => {
    if (!on) return
    const canvas = document.createElement('canvas')
    canvas.setAttribute('class', 'desk-screen')
    canvas.setAttribute('tabindex', '0')
    const meter = document.createElement('span')
    meter.setAttribute('class', 'desk-meter')
    meter.setAttribute('aria-hidden', 'true')
    meter.setAttribute('title', t.current('desk.meter'))
    const link = new DeskMeter()
    const socket = new WebSocket(desktopSocketUrl(key, token))
    socket.binaryType = 'arraybuffer'
    const codecs = webCodecs()
    /** What the picture comes by: video first where the page can decode it, VNC's where not or once the video fails. */
    let via: 'pending' | 'h264' | 'vnc' = codecs ? 'pending' : 'vnc'
    const shown = (): MeterVia => (via === 'pending' ? null : via)
    let live = false
    const show = () => {
      if (live) meter.textContent = link.text(shown(), rfb.jpegQuality)
    }
    // once live, each second: the corner; a ping every PING_S, the board's log a line every LOG_S
    let seconds = 0
    let ticking: ReturnType<typeof setInterval> | undefined
    const tick = () => {
      seconds++
      link.second()
      show()
      if (seconds % PING_S === 0) rfb.ping()
      if (seconds % LOG_S) return
      const line = link.minute({ key, via: shown(), quality: rfb.jpegQuality, mbps: rfb.linkMbps })
      if (line) pageLog(line)
    }
    const screen = canvasScreen(canvas)
    const rfb = new RfbClient(
      bytes => {
        if (socket.readyState === OPEN) socket.send(bytes)
      },
      // the video's frames are the display's size already: the canvas is not cleared under them
      { ...screen, size: (width, height) => via !== 'h264' && screen.size(width, height) },
      {
        live() {
          live = true
          show()
          ticking = setInterval(tick, 1000)
          setView({ state: 'live', why: '', canvas, meter })
        },
        failed(why) {
          setView({ state: 'failed', why: whyText(why, t.current), canvas, meter })
          socket.close()
        },
        updated: () => via === 'vnc' && link.frame(),
        pong: ms => link.pong(ms),
        copied(text) {
          if (!control.current || !text) return
          clip.current = text
          setCopied(true)
        },
        clipboardWanted: () => typing.wanted(),
      },
      { pictures: via === 'vnc' },
    )
    // what is copied there is asked for only while the owner has it
    rfb.copies = control.current
    display.current = rfb
    let typing: { wanted(): void } = { wanted() {} }
    // ------------------------------------------------ the video, where the page can decode it
    let video: DeskVideo | null = null
    let videoSocket: WebSocket | null = null
    let waiting: ReturnType<typeof setTimeout> | undefined
    /** Each second while the video is on: has its decoder stopped (DeskVideo.check)? */
    let watching: ReturnType<typeof setInterval> | undefined
    /** When the video's socket was last opened again for want of frames. */
    let reopened: number | null = null
    const endVideo = () => {
      clearTimeout(waiting)
      clearInterval(watching)
      video?.close()
      video = null
      if (!videoSocket) return
      videoSocket.onmessage = null
      videoSocket.onclose = null
      videoSocket.close()
      videoSocket = null
    }
    /** The video given up (or never there): VNC's picture from now on. */
    const toVnc = (why: string) => {
      if (via === 'vnc') return
      via = 'vnc'
      endVideo()
      rfb.watch()
      show()
      pageLog(`browser view ${key}: VNC picture (${why})`)
    }
    const ctx = codecs && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
    /** The video's socket and decoder: a frame within VIDEO_WAIT_MS, or VNC's picture. */
    const startVideo = (codecs: Codecs) => {
      const vs = new WebSocket(desktopSocketUrl(key, token, location, 'video'))
      vs.binaryType = 'arraybuffer'
      videoSocket = vs
      let drawn = false
      const vd = new DeskVideo(
        codecs,
        text => {
          if (vs.readyState === OPEN) vs.send(text)
        },
        {
          draw(frame) {
            if (via === 'vnc') return
            if (!drawn) {
              drawn = true
              clearTimeout(waiting)
            }
            if (via === 'pending') {
              via = 'h264'
              show()
            }
            const { displayWidth: width, displayHeight: height } = frame
            if (canvas.width !== width || canvas.height !== height) {
              canvas.width = width
              canvas.height = height
            }
            ctx?.drawImage(frame, 0, 0, width, height)
            link.frame()
          },
          failed: why => toVnc(why),
          ready: codec => pageLog(`browser view ${key}: h264 ${codec}`),
          restarted: why => pageLog(`browser view ${key}: h264 started again (${why})`),
          stalled(why) {
            const at = Date.now()
            if (reopened !== null && at - reopened < REOPEN_MS) return toVnc(why)
            reopened = at
            pageLog(`browser view ${key}: h264 opened again (${why})`)
            endVideo()
            startVideo(codecs)
          },
        },
      )
      video = vd
      watching = setInterval(() => vd.check(), 1000)
      vs.onmessage = e => {
        if (!(e.data instanceof ArrayBuffer)) return
        link.bytes(e.data.byteLength)
        video?.receive(new Uint8Array(e.data))
      }
      vs.onclose = e => toVnc(`its video closed${e?.code ? ` (${e.code}${e.reason ? ` ${e.reason}` : ''})` : ''}`)
      waiting = setTimeout(() => !drawn && toVnc(`no video frame in ${VIDEO_WAIT_MS / 1000} s`), VIDEO_WAIT_MS)
    }
    // A page out of sight draws nothing: its video goes while it is hidden (the board's encoder with
    // it, when no one else watches) and comes back with it, while its VNC connection is there (it
    // stays meanwhile, with control).
    const visibility = () => {
      if (!codecs || via === 'vnc') return
      if (document.hidden) endVideo()
      else if (!videoSocket && socket.readyState <= OPEN) startVideo(codecs)
    }
    if (codecs && !document.hidden) startVideo(codecs)
    document.addEventListener('visibilitychange', visibility)
    socket.onmessage = e => {
      if (e.data instanceof ArrayBuffer) rfb.receive(new Uint8Array(e.data))
    }
    socket.onclose = () => {
      clearInterval(ticking)
      // the display gone (or the board): its video with it
      endVideo()
      setView(was =>
        was.state === 'failed'
          ? was
          : {
              state: live ? 'closed' : 'failed',
              why: t.current(live ? 'desk.closed' : 'desk.unreachable'),
              canvas,
              meter,
            },
      )
    }
    const keys = attachInput(
      canvas,
      rfb,
      () => control.current,
      () => t.current('desk.title'),
      paste => {
        typing = paste
      },
    )
    input.current = keys
    setView({ state: 'connecting', why: '', canvas, meter })
    return () => {
      clearInterval(ticking)
      document.removeEventListener('visibilitychange', visibility)
      endVideo()
      meter.parentNode?.removeChild(meter)
      keys.detach()
      input.current = null
      display.current = null
      clip.current = ''
      setCopied(false)
      socket.onmessage = null
      socket.onclose = null
      socket.close()
      canvas.parentNode?.removeChild(canvas)
      setView(OFF)
    }
  }, [key, on, token, attempt])

  // Control given back: what is still down goes up on the display, and the screen's keyboard goes;
  // what it copies is no longer asked for, and what it copied is offered no more.
  useEffect(() => {
    if (display.current) display.current.copies = controlling
    if (controlling) return
    input.current?.stop()
    clip.current = ''
    setCopied(false)
  }, [controlling])

  return {
    ...view,
    copied,
    copyOut() {
      const text = clip.current
      clip.current = ''
      setCopied(false)
      return text ? copyText(text) : Promise.reject(new Error('nothing copied'))
    },
    type: text => input.current?.type(text),
    retry: () => setAttempt(n => n + 1),
  }
}
