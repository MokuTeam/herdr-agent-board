// An agent's display while it is shown (components/sheet/BrowserFold.tsx): a WebSocket to it through
// the board, read by the board's own VNC client (models/rfb.ts) into a canvas of its own that the
// fold or full size puts where it shows. Shown only while `on`: off, the socket closes, with no
// picture and no traffic, and the agent's browser runs on. Nothing goes to the display but the
// requests for its picture until `controlling`: then the mouse, the keys and pasted text (typed as
// keys) on the canvas go to it, and leave the board's own shortcuts alone. A finger's or a pen's
// tap brings up the screen's keyboard (a canvas brings up none): its text goes as keys too. A
// finger as on a tablet's remote desktop: a tap clicks, a swipe scrolls, held still it drags, a
// pinch zooms the picture in the board.
import { useEffect, useRef, useState } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { desktopSocketUrl } from '../api/desktop.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import {
  buttonMask,
  keysymOf,
  NO_ZOOM,
  pinched,
  screenPoint,
  shownScale,
  textKeysyms,
  WHEEL_DOWN,
  WHEEL_LEFT,
  WHEEL_PX,
  WHEEL_RIGHT,
  WHEEL_UP,
  type Zoom,
  zoomTransform,
} from '../models/desk-input.ts'
import { RfbClient, type RfbFailure, type RfbScreen } from '../models/rfb.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'

export type DeskState = 'off' | 'connecting' | 'live' | 'closed' | 'failed'

export interface DeskView {
  state: DeskState
  /** Why it is not shown (closed, failed), in the board's words; '' otherwise. */
  why: string
  /** The display's picture while on, for the fold or full size to put where it shows. */
  canvas: HTMLCanvasElement | null
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

/** The display drawn into a canvas (none drawn where the page has no 2D context). */
function canvasScreen(canvas: HTMLCanvasElement): RfbScreen {
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
  return {
    size(width, height) {
      canvas.width = width
      canvas.height = height
    },
    put(x, y, width, height, rgba) {
      ctx?.putImageData(new ImageData(rgba, width, height), x, y)
    },
    copy(sx, sy, x, y, width, height) {
      ctx?.drawImage(canvas, sx, sy, width, height, x, y, width, height)
    },
  }
}

export interface DeskInput {
  detach(): void
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

/**
 * The canvas's mouse, wheel, keys and pastes to the display, while `controlling()`. A tap (a
 * finger or a pen) puts the keys in a field of their own by the picture instead (`label`: its
 * name), which brings up the screen's keyboard: what it types comes as text, its other keys as on
 * the canvas. A finger, as a remote desktop on a tablet has it: a tap clicks, a swipe of one or
 * two scrolls the display's page (its wheel), held still a moment it presses the button and drags,
 * a pinch zooms the picture in the board. A mouse goes as it always did.
 */
export function attachInput(
  canvas: HTMLElement,
  rfb: RfbClient,
  controlling: () => boolean,
  label: () => string = () => '',
): DeskInput {
  const keys = new Map<string, number>()
  let mask = 0
  let last = { x: 0, y: 0 }
  let wheel = 0
  let touched = false
  let field: HTMLTextAreaElement | null = null
  const at = (e: { clientX: number; clientY: number }) =>
    screenPoint(canvas.getBoundingClientRect(), rfb.width, rfb.height, e.clientX, e.clientY)
  const atPoint = (p: Point) => at({ clientX: p.x, clientY: p.y })
  const point = (e: PointerEvent) => {
    const p = at(e)
    if (!p) return
    last = p
    mask = buttonMask(e.buttons)
    rfb.pointer(p.x, p.y, mask)
  }
  const release = () => {
    for (const keysym of keys.values()) rfb.key(keysym, false)
    keys.clear()
    if (mask) rfb.pointer(last.x, last.y, 0)
    mask = 0
  }
  const press = (keysyms: number[]) => {
    for (const keysym of keysyms) {
      rfb.key(keysym, true)
      rfb.key(keysym, false)
    }
  }
  const keyDown = (e: Event) => {
    const k = e as KeyboardEvent
    // The board's own keys (its shortcuts, Esc closing the panel) stay out of it.
    e.stopPropagation()
    // A paste: its text comes as keys (paste, below), not as Ctrl+V on the display.
    if ((k.ctrlKey || k.metaKey) && k.key?.toLowerCase() === 'v') return
    const keysym = keysymOf(k.key ?? '', k.code ?? '')
    if (keysym === null) return
    e.preventDefault()
    keys.set(k.code || k.key, keysym)
    rfb.key(keysym, true)
  }
  const keyUp = (e: Event) => {
    const k = e as KeyboardEvent
    e.stopPropagation()
    const id = k.code || k.key
    const keysym = keys.get(id)
    if (keysym === undefined) return
    e.preventDefault()
    keys.delete(id)
    rfb.key(keysym, false)
  }
  const paste = (e: Event) => {
    e.preventDefault()
    const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''
    // The Ctrl held for the paste goes up first, so the text types as text.
    release()
    press(textKeysyms(text.slice(0, MAX_PASTE)))
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
      press(textKeysyms(now.slice(same, same + MAX_PASTE)))
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
    },
    blur: release,
  }
  /** The field by the picture (wherever it shows now), with the keys in it: the screen's keyboard comes up. */
  const keyboard = () => {
    if (!field) {
      field = document.createElement('textarea')
      field.setAttribute('class', 'desk-keys')
      field.setAttribute('aria-label', label())
      // What it types goes as it is: no capitals, corrections or suggestions of the keyboard's own.
      const plain = { autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false' }
      for (const [name, value] of Object.entries({ ...plain, tabindex: '-1', rows: '1' }))
        field.setAttribute(name, value)
      for (const [type, fn] of Object.entries(fieldHandlers)) field.addEventListener(type, fn)
    }
    if (field.parentNode !== canvas.parentNode) canvas.parentNode?.insertBefore(field, canvas.nextSibling)
    if (document.activeElement === field) return
    keepField()
    field.focus({ preventScroll: true })
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
    rfb.pointer(p.x, p.y, mask)
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
    rfb.pointer(q.x, q.y, 1)
    rfb.pointer(q.x, q.y, 0)
  }
  // What the fingers' middle went, at the picture's scale, as the wheel's steps where the swipe
  // began: the page follows the finger (one going up shows what is under: the wheel down).
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
    const steps = (along: 'x' | 'y', back: number, on: number) => {
      while (Math.abs(swept[along]) >= WHEEL_PX / 2) {
        const bit = swept[along] > 0 ? back : on
        rfb.pointer(p.x, p.y, mask | bit)
        rfb.pointer(p.x, p.y, mask)
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
      rfb.pointer(p.x, p.y, mask)
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
      rfb.pointer(p.x, p.y, 0)
      canvas.removeAttribute('data-held')
      gesture = 'over'
      if (!cancelled) keyboard()
    } else if (gesture === 'two' || gesture === 'pinch') {
      if (zoom.z < ZOOM_SNAP) zoomTo(NO_ZOOM)
      gesture = 'over'
    } else if (fingers.size) was = middle()
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
      canvas.focus()
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
        rfb.pointer(p.x, p.y, mask | (wheel < 0 ? WHEEL_UP : WHEEL_DOWN))
        rfb.pointer(p.x, p.y, mask)
        wheel -= Math.sign(wheel) * WHEEL_STEP
      }
    },
    contextmenu(e) {
      if (controlling()) e.preventDefault()
    },
    keydown(e) {
      if (controlling()) keyDown(e)
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
      for (const [type, fn] of Object.entries(handlers)) canvas.removeEventListener(type, fn)
      if (!field) return
      for (const [type, fn] of Object.entries(fieldHandlers)) field.removeEventListener(type, fn)
      field.parentNode?.removeChild(field)
      field = null
    },
    release,
    stop() {
      release()
      unfinger()
      touched = false
      field?.blur()
    },
  }
}

const OFF = { state: 'off' as DeskState, why: '', canvas: null }

export function useDesktop(key: string, on: boolean, controlling: boolean): DeskView {
  const t = useLatest(useT())
  const control = useLatest(controlling)
  const token = useBoardContext().data?.fsToken ?? ''
  const [view, setView] = useState<Omit<DeskView, 'retry'>>(OFF)
  const [attempt, setAttempt] = useState(0)
  const input = useRef<DeskInput | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: another attempt is when to connect again
  useEffect(() => {
    if (!on) return
    const canvas = document.createElement('canvas')
    canvas.setAttribute('class', 'desk-screen')
    canvas.setAttribute('tabindex', '0')
    const socket = new WebSocket(desktopSocketUrl(key, token))
    socket.binaryType = 'arraybuffer'
    let live = false
    const rfb = new RfbClient(
      bytes => {
        if (socket.readyState === OPEN) socket.send(bytes)
      },
      canvasScreen(canvas),
      {
        live() {
          live = true
          setView({ state: 'live', why: '', canvas })
        },
        failed(why) {
          setView({ state: 'failed', why: whyText(why, t.current), canvas })
          socket.close()
        },
      },
    )
    socket.onmessage = e => {
      if (e.data instanceof ArrayBuffer) rfb.receive(new Uint8Array(e.data))
    }
    socket.onclose = () =>
      setView(was =>
        was.state === 'failed'
          ? was
          : { state: live ? 'closed' : 'failed', why: t.current(live ? 'desk.closed' : 'desk.unreachable'), canvas },
      )
    const keys = attachInput(
      canvas,
      rfb,
      () => control.current,
      () => t.current('desk.title'),
    )
    input.current = keys
    setView({ state: 'connecting', why: '', canvas })
    return () => {
      keys.detach()
      input.current = null
      socket.onmessage = null
      socket.onclose = null
      socket.close()
      canvas.parentNode?.removeChild(canvas)
      setView(OFF)
    }
  }, [key, on, token, attempt])

  // Control given back: what is still down goes up on the display, and the screen's keyboard goes.
  useEffect(() => {
    if (!controlling) input.current?.stop()
  }, [controlling])

  return { ...view, retry: () => setAttempt(n => n + 1) }
}
