// The setup note's state: whether the toolbar shows it (models/setup.ts), the list it opens and
// its motion, the checks read again on every opening and "Check again" (only the newest answer
// counts), "Hide until something changes", the copy buttons. The page closes it on a press
// outside, on Escape (the focus back to the note) and on Back (useDialogHistory).
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import {
  isSetupReply,
  isSetupSummary,
  noteShown,
  SETUP_HIDDEN_KEY,
  type SetupCheck,
  type SetupSummary,
  setupPopPlace,
} from '../models/setup.ts'
import { reducedMotion } from '../models/spring.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { storage } from '../state/storage.ts'
import { useLatest } from './useLatest.ts'
import { useSpring } from './useSpring.ts'

export interface SetupNoteState {
  /** The list is open (or opening). */
  open: boolean
  /** It was opened at least once: until then it holds no list. */
  opened: boolean
  /** The toolbar shows the note. */
  shown: boolean
  /** The list is closed and done moving. */
  hidden: boolean
  /** The last checks the server answered with; null before the first answer. */
  checks: SetupCheck[] | null
  loadFailed: boolean
  /** A check is on its way: "Check again" waits. */
  loading: boolean
  /** It was asked for: "Check again" says "Checking…". */
  busy: boolean
  summary: SetupSummary | null
  /** The copy buttons that just copied (by their place in the list). */
  copied: ReadonlySet<number>
  noteRef: RefObject<HTMLButtonElement | null>
  popRef: RefObject<HTMLDivElement | null>
  toggle(): void
  close(refocus?: boolean): void
  recheck(): void
  hide(): void
  copy(index: number, text: string): void
}

/** Under the note when there is room, its right edge on the note's, grown out of its corner. */
function place(pop: HTMLElement, note: HTMLElement): void {
  const r = note.getBoundingClientRect()
  const at = setupPopPlace(
    { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width },
    { width: pop.offsetWidth, height: pop.offsetHeight },
    { width: innerWidth, height: innerHeight },
  )
  pop.style.left = `${at.left}px`
  pop.style.top = `${at.top}px`
  pop.style.transformOrigin = at.origin
}

export function useSetupNote(): SetupNoteState {
  const t = useT()
  const { data } = useBoardContext()
  // The payload's guard (api/client.ts) leaves `setup` to this one: a summary it cannot read is none.
  const fromBoard = isSetupSummary(data?.setup) ? data.setup : null
  const [summary, setSummary] = useState<SetupSummary | null>(fromBoard)
  const [open, setOpen] = useState(false)
  const [opened, setOpened] = useState(false)
  const [hidden, setHidden] = useState(true)
  const [checks, setChecks] = useState<SetupCheck[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hiddenSig, setHiddenSig] = useState(() => storage.get(SETUP_HIDDEN_KEY, ''))
  const [copied, setCopied] = useState<ReadonlySet<number>>(new Set())
  const noteRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const latest = useLatest({ open, summary, hiddenSig, t })
  const asked = useRef(0)
  const loadedLang = useRef('')

  // Out of the note and back into it: scale and fade from the note's corner, critically damped.
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

  // Each opening and "Check again" asks the server to check again; only the newest answer counts.
  const load = useCallback(
    async (asking: boolean) => {
      const mine = ++asked.current
      setLoading(true)
      if (asking) setBusy(true)
      try {
        const r = await api.get('/api/setup', isSetupReply, { cache: 'no-store' })
        if (mine !== asked.current) return
        setChecks(r.checks)
        setLoadFailed(false)
        loadedLang.current = latest.current.t.lang
        setSummary({ todo: r.todo, sig: r.sig })
      } catch {
        if (mine === asked.current) setLoadFailed(true)
      } finally {
        if (mine === asked.current) {
          setLoading(false)
          setBusy(false)
        }
      }
    },
    [latest],
  )

  // The board sent its summary: the note follows it, and an open list is read again when it
  // changed (or the language did since it was read).
  const boardSig = fromBoard?.sig ?? ''
  const boardTodo = fromBoard?.todo
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new summary or language is when to follow, the rest is read as it is
  useEffect(() => {
    const now = latest.current
    const changed = boardSig !== (now.summary?.sig ?? '')
    setSummary(boardTodo === undefined ? null : { todo: boardTodo, sig: boardSig })
    if (now.open && (changed || loadedLang.current !== t.lang)) void load(false)
  }, [boardSig, boardTodo, t.lang])

  const show = useCallback(() => {
    if (latest.current.open) return
    setOpen(true)
    setOpened(true)
    setHidden(false)
    motion.to(1)
    void load(true)
  }, [latest, motion, load])

  const closeWith = useCallback(
    (refocus: boolean, hiddenNow: string) => {
      const now = latest.current
      if (!now.open) return
      setOpen(false)
      motion.to(0)
      if (reducedMotion.matches) setHidden(true)
      if (!refocus) return
      const target = noteShown(false, now.summary, hiddenNow) ? noteRef.current : document.getElementById('search')
      target?.focus({ preventScroll: true })
    },
    [latest, motion],
  )
  const close = useCallback((refocus = false) => closeWith(refocus, latest.current.hiddenSig), [closeWith, latest])

  const hide = useCallback(() => {
    const sig = latest.current.summary?.sig
    if (sig) {
      storage.set(SETUP_HIDDEN_KEY, sig)
      setHiddenSig(sig)
    }
    closeWith(true, sig || latest.current.hiddenSig)
  }, [closeWith, latest])

  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  const copy = useCallback(async (index: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(now => new Set(now).add(index))
      const timer = setTimeout(() => {
        timers.current.delete(timer)
        setCopied(now => {
          const next = new Set(now)
          next.delete(index)
          return next
        })
      }, 1500)
      timers.current.add(timer)
    } catch {}
  }, [])
  // A list drawn again has its copy buttons as they start.
  // biome-ignore lint/correctness/useExhaustiveDependencies: new checks are when to start over
  useEffect(() => setCopied(new Set()), [checks])

  // Placed whenever it is drawn while open (its text changes its size), and on a resize.
  useLayoutEffect(() => {
    if (open && popRef.current && noteRef.current) place(popRef.current, noteRef.current)
  })
  useLayoutEffect(() => {
    if (open) popRef.current?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPress = (e: PointerEvent): void => {
      const target = e.target instanceof Element ? e.target : null
      if (!target?.closest('#setup-pop, #setup-note')) close(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      close(true)
    }
    const onResize = (): void => {
      if (popRef.current && noteRef.current) place(popRef.current, noteRef.current)
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
    open,
    opened,
    shown: noteShown(open, summary, hiddenSig),
    hidden,
    checks,
    loadFailed,
    loading,
    busy,
    summary,
    copied,
    noteRef,
    popRef,
    toggle: () => (open ? close() : show()),
    close,
    recheck: () => void load(true),
    hide,
    copy: (index, text) => void copy(index, text),
  }
}
