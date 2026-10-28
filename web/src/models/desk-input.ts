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
