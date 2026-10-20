// A fork of a session from the board (services/launch/fork.ts): the small window that names the
// fork and takes its first message, grown out of the button or the card it was asked from, and
// what its Fork button does. The server starts the fork as a launch, so its card shows at once and
// says how it goes; this session stays as it is.
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LaunchView } from '../../../src/core/types.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import type { MenuOrigin } from '../models/board-menus.ts'
import { setupPopPlace } from '../models/setup.ts'
import { reducedMotion } from '../models/spring.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'
import { useSessionActions } from './useSessionActions.ts'
import { useSpring } from './useSpring.ts'

/** What the window starts from: a retry's name and first message. */
export interface ForkDraft {
  name?: string
  message?: string
}

/** The window for one session; `id` is new with every opening, for a new form. */
export interface ForkView {
  id: number
  key: string
  draft: ForkDraft
}

export interface Forker {
  /** What the window shows; it stays while the window folds away. */
  view: ForkView | null
  open: boolean
  hidden: boolean
  busy: boolean
  /** Why the server did not start it, and the field at fault ('' for none). */
  error: { text: string; field: string } | null
  popRef: RefObject<HTMLDivElement | null>
  /** The window for the session `key`, grown out of `from`; again on the same one closes it. */
  show(key: string, from: MenuOrigin | null, draft?: ForkDraft): void
  close(refocus?: boolean): void
  submit(name: string, message: string): Promise<void>
  isOpen(): boolean
}

const isLaunchView = (v: unknown): v is LaunchView =>
  typeof v === 'object' && v !== null && 'id' in v && 'state' in v && 'name' in v

/** The window by its anchor: under it when there is room, else over it, grown out of it. */
function place(pop: HTMLElement, from: MenuOrigin | null): void {
  const r = from instanceof Element ? from.getBoundingClientRect() : from
  const box = r ?? { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 3, bottom: innerHeight / 3 }
  const at = setupPopPlace(
    { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.right - box.left },
    { width: pop.offsetWidth, height: pop.offsetHeight },
    { width: innerWidth, height: innerHeight },
  )
  pop.style.left = `${at.left}px`
  pop.style.top = `${at.top}px`
  pop.style.transformOrigin = at.origin
}

export function useFork(): Forker {
  const t = useT()
  const { dispatch, toast, data } = useBoardContext()
  const actions = useSessionActions()
  const [view, setView] = useState<ForkView | null>(null)
  const [open, setOpen] = useState(false)
  const [hidden, setHidden] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Forker['error']>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const anchor = useRef<MenuOrigin | null>(null)
  const latest = useLatest({ open, view, busy, t, data, actions })

  // Out of its anchor and back into it: scale and fade, critically damped (no momentum to carry).
  const motion = useSpring({
    value: 0,
    damping: 1,
    response: 0.28,
    precision: 0.002,
    onUpdate: v => {
      const pop = popRef.current
      if (!pop) return
      pop.style.opacity = String(v)
      pop.style.transform = reducedMotion.matches ? 'none' : `scale(${0.94 + 0.06 * v})`
    },
    onRest: v => {
      if (v === 0 && !latest.current.open) setHidden(true)
    },
  })

  const close = useCallback(
    (refocus = false) => {
      if (!latest.current.open) return
      setOpen(false)
      motion.to(0)
      if (reducedMotion.matches) setHidden(true)
      const from = anchor.current
      if (refocus && from instanceof HTMLElement && from.isConnected) from.focus({ preventScroll: true })
    },
    [latest, motion],
  )

  const show = useCallback(
    (key: string, from: MenuOrigin | null, draft: ForkDraft = {}) => {
      const now = latest.current
      if (now.open && now.view?.key === key && !draft.name) return close(true)
      anchor.current = from
      setView({ id: (now.view?.id ?? 0) + 1, key, draft })
      setError(null)
      setOpen(true)
      setHidden(false)
      motion.to(1)
    },
    [latest, motion, close],
  )

  const submit = useCallback(
    async (name: string, message: string) => {
      const now = latest.current
      const key = now.view?.key
      if (!key || now.busy) return
      setBusy(true)
      setError(null)
      const r = await now.actions.act(key, 'fork', { name: name.trim(), message: message.trim() })
      setBusy(false)
      if (!r.ok) return setError({ text: r.error, field: typeof r.field === 'string' ? r.field : '' })
      // Its card on its way, at once; the server's next board has it too.
      if (isLaunchView(r.launch)) dispatch({ type: 'launched', launch: r.launch })
      const source = now.data?.items.find(i => i.key === key)?.name ?? ''
      toast(latest.current.t('fork.started', { name: source, fork: String(r.name ?? name) }))
      close(false)
    },
    [latest, dispatch, toast, close],
  )

  // Placed whenever it is drawn while open (an error line changes its size), and on a resize.
  useLayoutEffect(() => {
    if (open && popRef.current) place(popRef.current, anchor.current)
  })

  useEffect(() => {
    if (!open) return
    const onPress = (e: PointerEvent): void => {
      const target = e.target instanceof Node ? e.target : null
      const from = anchor.current
      if (popRef.current?.contains(target) || (from instanceof Element && from.contains(target))) return
      close(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      close(true)
    }
    const onResize = (): void => {
      if (popRef.current) place(popRef.current, anchor.current)
    }
    addEventListener('pointerdown', onPress, true)
    addEventListener('keydown', onKey, true)
    addEventListener('resize', onResize)
    return () => {
      removeEventListener('pointerdown', onPress, true)
      removeEventListener('keydown', onKey, true)
      removeEventListener('resize', onResize)
    }
  }, [open, close])

  return {
    view,
    open,
    hidden,
    busy,
    error,
    popRef,
    show,
    close,
    submit,
    isOpen: () => latest.current.open,
  }
}
