// The chat beside an agent's browser shown full size (components/sheet/BrowserFold.tsx; the place
// and its sizes: models/desk-chat.ts): whether "Chat" is offered and has it there, where it sits,
// its size as the viewer left it, and its edge, which a pointer drags and the keys move. Offered
// full size only, where the panel hands its conversation over, and not on a phone (760 px and
// narrower), which has no room beside the picture; it goes with full size, and comes back only when
// asked. Where it sits and its sizes are kept for the next time.
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  CHAT_KEY,
  type ChatDock,
  type ChatPlace,
  chatDock,
  chatField,
  chatKeySize,
  chatLimits,
  draggedChatSize,
  restoreChat,
  serializeChat,
} from '../models/desk-chat.ts'
import type { SizeLimits } from '../models/panel-layout.ts'
import { PHONE_QUERY } from '../models/panel-motion.ts'
import { PanelContext } from '../state/PanelProvider.tsx'
import { storage } from '../state/storage.ts'
import { useLatest } from './useLatest.ts'
import { useMediaQuery } from './useMediaQuery.ts'

export interface ChatEdge {
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void
  onPointerMove(e: ReactPointerEvent<HTMLElement>): void
  onPointerUp(e: ReactPointerEvent<HTMLElement>): void
  onPointerCancel(e: ReactPointerEvent<HTMLElement>): void
  onDoubleClick(): void
  onKeyDown(e: ReactKeyboardEvent<HTMLElement>): void
}

/** Its size as drawn and its limits, for screen readers (the edge is a separator). */
export interface ChatSize {
  now: number
  min: number
  max: number
}

export interface DeskChat {
  /** "Chat" is offered: full size, the panel hands its conversation over, not a phone. */
  can: boolean
  /** The chat is beside the picture. */
  on: boolean
  dock: ChatDock
  /** Its size there as the viewer left it (px); null: the stylesheet's default. */
  size: number | null
  /** The chat's pane (.desk-chat). */
  pane: RefObject<HTMLDivElement | null>
  /** The picture's view beside it (.desk-view), whose room it shares. */
  view: RefObject<HTMLDivElement | null>
  toggle(): void
  /** To the other place: the bottom from the right, the right from the bottom. */
  flip(): void
  edge: ChatEdge
  /** As last drawn. */
  drawn: ChatSize
}

interface Drag {
  id: number
  x: number
  y: number
  start: number
  limits: SizeLimits
}

export function useDeskChat(full: boolean, offered: boolean): DeskChat {
  const phone = useMediaQuery(PHONE_QUERY)
  const panel = useContext(PanelContext)
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<ChatPlace>(() => restoreChat(storage.read(CHAT_KEY)))
  const latest = useLatest(place)
  const pane = useRef<HTMLDivElement>(null)
  const view = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const can = full && offered && !phone
  const on = can && open
  const dock = chatDock(place, panel?.layout.dock ?? 'right')
  const field = chatField(dock)
  const size = place[field]

  // Full size gone: the chat goes with it.
  useEffect(() => {
    if (!full) setOpen(false)
  }, [full])
  // What screen readers hear of its edge: its size as drawn, after every draw while it shows.
  const [drawn, setDrawn] = useState<ChatSize>({ now: 0, min: 0, max: 0 })
  useLayoutEffect(() => {
    if (!on) return
    const m = measure()
    if (!m) return
    const next = { now: Math.round(m.now), min: m.limits.min, max: Math.round(m.limits.max) }
    setDrawn(was => (was.now === next.now && was.min === next.min && was.max === next.max ? was : next))
  })

  const keep = (next: ChatPlace) => {
    setPlace(next)
    storage.set(CHAT_KEY, serializeChat(next))
  }
  /** The chat's size now and its limits, from the page as drawn: what it and the picture share. */
  const measure = (): { now: number; limits: SizeLimits } | null => {
    const el = pane.current
    const beside = view.current
    if (!el || !beside) return null
    const a = el.getBoundingClientRect()
    const b = beside.getBoundingClientRect()
    const now = dock === 'bottom' ? a.height : a.width
    return { now, limits: chatLimits(dock, dock === 'bottom' ? a.height + b.height : a.width + b.width) }
  }
  const dragged = (d: Drag, e: ReactPointerEvent<HTMLElement>) =>
    draggedChatSize(dock, d.start, e.clientX - d.x, e.clientY - d.y, d.limits)
  const letGo = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    drag.current = null
    keep({ ...latest.current, [field]: dragged(d, e) })
  }

  return {
    can,
    on,
    dock,
    size,
    pane,
    view,
    toggle: () => setOpen(was => !was),
    flip: () => keep({ ...place, dock: dock === 'right' ? 'bottom' : 'right' }),
    edge: {
      onPointerDown(e) {
        if (e.button !== 0) return
        const m = measure()
        if (!m) return
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: m.now, limits: m.limits }
      },
      onPointerMove(e) {
        const d = drag.current
        if (!d || e.pointerId !== d.id) return
        setPlace(was => ({ ...was, [field]: dragged(d, e) }))
      },
      onPointerUp: letGo,
      onPointerCancel: letGo,
      // Double-click: the default size.
      onDoubleClick: () => keep({ ...place, [field]: null }),
      onKeyDown(e) {
        const m = measure()
        if (!m) return
        const next = chatKeySize(dock, m.now, e.key, e.shiftKey, m.limits)
        if (next === null) return
        e.preventDefault()
        keep({ ...place, [field]: next })
      },
    },
    drawn,
  }
}
