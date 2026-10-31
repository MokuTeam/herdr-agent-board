// An agent's display while it is shown (components/sheet/BrowserFold.tsx): a WebSocket to it through
// the board, read by the board's own VNC client (models/rfb.ts) into a canvas of its own that the
// fold or full size puts where it shows. Shown only while `on`: off, the socket closes, with no
// picture and no traffic, and the agent's browser runs on. Nothing goes to the display but the
// requests for its picture until `controlling`: then the mouse, the keys and pasted text (typed as
// keys) on the canvas go to it, and leave the board's own shortcuts alone. A finger's or a pen's
// tap brings up the screen's keyboard (a canvas brings up none): its text goes as keys too.
import { useEffect, useRef, useState } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { desktopSocketUrl } from '../api/desktop.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { buttonMask, keysymOf, screenPoint, textKeysyms, WHEEL_DOWN, WHEEL_UP } from '../models/desk-input.ts'
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
  /** Control given back: what is down goes up, and a touch screen's keyboard goes away. */
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

/**
 * The canvas's mouse, wheel, keys and pastes to the display, while `controlling()`. A tap (a
 * finger or a pen) puts the keys in a field of their own by the picture instead (`label`: its
 * name), which brings up the screen's keyboard: what it types comes as text, its other keys as on
 * the canvas. A mouse goes as it always did.
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

  const handlers: Record<string, (e: Event) => void> = {
    pointerdown(e) {
      if (!controlling()) return
      e.preventDefault()
      // A mouse's keys come to the picture; a finger's from the keyboard its tap brings up (below).
      touched = touching(e as PointerEvent)
      if (!touched) canvas.focus()
      canvas.setPointerCapture?.((e as PointerEvent).pointerId)
      point(e as PointerEvent)
    },
    pointermove(e) {
      if (controlling()) point(e as PointerEvent)
    },
    pointerup(e) {
      if (!controlling()) return
      point(e as PointerEvent)
      if (touching(e as PointerEvent)) keyboard()
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
      for (const [type, fn] of Object.entries(handlers)) canvas.removeEventListener(type, fn)
      if (!field) return
      for (const [type, fn] of Object.entries(fieldHandlers)) field.removeEventListener(type, fn)
      field.parentNode?.removeChild(field)
      field = null
    },
    release,
    stop() {
      release()
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
