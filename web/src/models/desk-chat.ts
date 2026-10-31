// The session's conversation beside its browser shown full size (components/sheet/BrowserFold.tsx):
// the session panel's own thread and composer, moved there while it shows (Sheet.tsx), on the right
// of the picture or under it, its edge dragged for its width or its height. Where it sits and how
// big is this browser's (localStorage board.deskChat), a sibling of the session panel's place:
// until the viewer picks one, it sits as the panel docks (at the bottom with a panel at the
// bottom, else on the right). The keys go where the focus is: in the chat's fields they are the
// chat's, Esc too (the board's first Esc leaves the field); on the picture they go to the browser.
import { type Dock, keySize, type SizeLimits } from './panel-layout.ts'

export type ChatDock = 'right' | 'bottom'

/** The viewer's place for the chat (null: as the session panel docks; the default size). */
export interface ChatPlace {
  dock: ChatDock | null
  side: number | null
  bottom: number | null
}

/** The viewer's place in localStorage (format: serializeChat). */
export const CHAT_KEY = 'board.deskChat'
/** Its least width on the right, height at the bottom. */
export const CHAT_MIN = { side: 300, bottom: 180 }
/** What the picture keeps beside it, or above it, at least. */
export const PICTURE_MIN = { w: 320, h: 160 }

const NO_PLACE: ChatPlace = { dock: null, side: null, bottom: null }
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The viewer's place from storage; whatever cannot be read is the default, field by field. */
export function restoreChat(raw: string | null): ChatPlace {
  let v: unknown = null
  try {
    v = JSON.parse(String(raw))
  } catch {}
  if (typeof v !== 'object' || v === null) return NO_PLACE
  const r = v as Record<string, unknown>
  const size = (n: unknown): number | null =>
    typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : null
  return {
    dock: r.dock === 'right' || r.dock === 'bottom' ? r.dock : null,
    side: size(r.side),
    bottom: size(r.bottom),
  }
}

export function serializeChat(place: ChatPlace): string {
  return JSON.stringify({ v: 1, dock: place.dock, side: place.side, bottom: place.bottom })
}

/** Where it sits: the viewer's pick, else as the session panel docks (`panel`). */
export function chatDock(place: ChatPlace, panel: Dock): ChatDock {
  return place.dock ?? (panel === 'bottom' ? 'bottom' : 'right')
}

/** The field its size at `dock` is kept in. */
export const chatField = (dock: ChatDock): 'side' | 'bottom' => (dock === 'bottom' ? 'bottom' : 'side')

/**
 * Its least and largest size at `dock`, where it and the picture share `room` px (their widths on
 * the right, their heights at the bottom): the picture keeps its least.
 */
export function chatLimits(dock: ChatDock, room: number): SizeLimits {
  const min = dock === 'bottom' ? CHAT_MIN.bottom : CHAT_MIN.side
  const picture = dock === 'bottom' ? PICTURE_MIN.h : PICTURE_MIN.w
  return { min, max: Math.max(min, room - picture) }
}

/** Its edge dragged (dx, dy) from where it was `start` px: towards the picture it grows, within `limits`. */
export function draggedChatSize(dock: ChatDock, start: number, dx: number, dy: number, limits: SizeLimits): number {
  return Math.round(clamp(dock === 'bottom' ? start - dy : start - dx, limits.min, limits.max))
}

/** Keys on its edge, as on a docked panel's: arrows towards the picture grow it, Shift in bigger steps, Home and End its least and largest. */
export function chatKeySize(
  dock: ChatDock,
  size: number,
  key: string,
  shift: boolean,
  limits: SizeLimits,
): number | null {
  return keySize(dock, size, key, shift, limits)
}

/** A field that takes typing. */
function typesText(el: Element): boolean {
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName === 'INPUT')
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file'].includes(
      (el.getAttribute('type') ?? 'text').toLowerCase(),
    )
  return el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === ''
}

/**
 * Does Esc at `target` leave full size? Not in a field of the chat (`chat`) that takes typing:
 * there it is the field's, and the board's first Esc leaves the field. Anywhere else (the
 * picture, the touch keyboard's field by it, the bar, the chat's buttons) it does, as it always did.
 */
export function escLeavesFull(target: EventTarget | null, chat: Element | null): boolean {
  if (!chat || !target || typeof (target as Element).tagName !== 'string') return true
  const el = target as Element
  return !(chat.contains(el) && typesText(el))
}
