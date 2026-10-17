// The quick look over the board (the old page's files.js look, close, back and its keys): it
// grows out of the chip or button it was opened from and shrinks back into it, on a spring that
// can be caught midway; it dims the board and takes the focus (hooks/useModalFocus.ts), Esc
// closes it, Backspace or Alt+← walks back. What it shows step by step is models/quick-look.ts;
// components/files/QuickLook.tsx draws it.
import { createRef, type RefObject, useEffect, useState } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { type FilesApi, filesApi } from '../api/files.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import type { FocusScope } from '../models/modal-focus.ts'
import { type LookMode, type LookTarget, type LookView, type QuickLookNav, quickLookNav } from '../models/quick-look.ts'
import { reducedMotion, Spring } from '../models/spring.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { Store, useStore } from '../state/store.ts'
import { useLatest } from './useLatest.ts'
import { useModalFocus } from './useModalFocus.ts'

export interface LookRefs {
  /** The layer: a direct child of <body> (useModalFocus makes the rest of the page inert). */
  layer: RefObject<HTMLDivElement | null>
  win: RefObject<HTMLElement | null>
  scrim: RefObject<HTMLDivElement | null>
  body: RefObject<HTMLDivElement | null>
}

/** What <QuickLook> draws and wires. */
export interface QuickLookEngine {
  view: Store<LookView>
  /** Open and not shrinking away. */
  openNow: Store<boolean>
  refs: LookRefs
  nav: QuickLookNav
  /** After a draw: one that just opened grows out of where it came from. */
  grow(): void
  back(): void
  close(): void
  /** A step to a file or folder. */
  go(path: string): void
  setMode(mode: LookMode): void
  /** Open with the system, show in its folder, or copy the path, of what is on show. */
  act(how: 'open' | 'reveal' | 'copy'): void
  /** Paths in what it shows become chips (hooks/useFileChips.ts). */
  upgrade(root: HTMLElement, cwd: string): void
  /** A key, before the page's own: Esc closes it, Backspace or Alt+← walks back. */
  keydown(e: LookKey): void
  /** The spring stops (the page goes). */
  stop(): void
}

/** What the quick look reads of a key press. */
export interface LookKey {
  key: string
  altKey: boolean
  preventDefault(): void
  stopImmediatePropagation(): void
}

const TYPING = /^(INPUT|TEXTAREA)$/

export interface QuickLook {
  /** It is open (not shrinking away): for the Back button's layers. */
  open: boolean
  isOpen(): boolean
  /** A file or folder at `line`, grown from `from`. */
  look(target: { path: string; line?: number | null | undefined }, from?: Element | null): void
  /** The checkout changes of a session's folder. */
  lookChanges(key: string, from?: Element | null): void
  /** The past sessions of a session's project. */
  lookHistory(key: string, cwd: string, from?: Element | null): void
  /** A step back; from the first one, it closes. */
  back(): void
  close(): void
  engine: QuickLookEngine
}

interface EngineDeps {
  refs: LookRefs
  focus(): FocusScope
  api: FilesApi
  t(): Translator
  canEdit(): boolean
  toast(text: string, error?: boolean): void
  upgrade(root: HTMLElement, cwd: string): void
}

interface From {
  dx: number
  dy: number
  s: number
}

/** Where the window starts from: the chip's centre and width, or a small drop when it is gone. */
export function measureFrom(win: HTMLElement, el: Element | null): From {
  const saved = win.style.transform
  win.style.transform = 'none'
  const w = win.getBoundingClientRect()
  win.style.transform = saved
  const r = el?.isConnected ? el.getBoundingClientRect() : null
  if (!r?.width || r.bottom < 0 || r.top > innerHeight) return { dx: 0, dy: 24, s: 0.94 }
  return {
    dx: r.left + r.width / 2 - (w.left + w.width / 2),
    dy: r.top + r.height / 2 - (w.top + w.height / 2),
    s: Math.max(0.06, Math.min(0.5, r.width / w.width)),
  }
}

export function quickLookEngine(deps: EngineDeps): QuickLook {
  const { refs, api } = deps
  const nav = quickLookNav({
    t: deps.t,
    preview: path => api.preview(path),
    changes: key => api.changes(key),
    history: (key, query) => api.history(key, query),
    changed(next) {
      view.set(next)
      openNow.set(!next.hidden && !next.closing)
    },
  })
  const view = new Store(nav.view())
  const openNow = new Store(false)
  let origin: Element | null = null
  let growing = false
  let from: From = { dx: 0, dy: 0, s: 0.2 }

  function paint(p: number): void {
    const win = refs.win.current
    const scrim = refs.scrim.current
    if (!win || !scrim) return
    const q = Math.max(0, p)
    if (reducedMotion.matches) {
      win.style.transform = ''
      win.style.opacity = String(Math.min(1, q))
    } else {
      const s = from.s + (1 - from.s) * q
      win.style.transform = `translate(${from.dx * (1 - q)}px, ${from.dy * (1 - q)}px) scale(${s})`
      win.style.opacity = String(Math.min(1, q * 1.8))
    }
    scrim.style.opacity = String(Math.min(1, q))
  }

  // p: 0 = folded into what it came from, 1 = open. Interruptible: a close while opening turns
  // around from wherever the window is.
  const motion: Spring = new Spring({
    value: 0,
    damping: 1,
    response: 0.34,
    precision: 0.002,
    onUpdate: v => paint(v),
    onRest: v => {
      if (v !== 0) return
      nav.closed()
      deps.focus().close()
    },
  })

  const isOpen = () => openNow.get()

  function lookAt(target: LookTarget, el: Element | null | undefined): void {
    if (isOpen()) {
      nav.push(target)
      return
    }
    origin = el ?? null
    growing = true
    // Drawn first (components/files/QuickLook.tsx), then it grows: grow().
    nav.open(target)
  }

  function close(): void {
    const v = nav.view()
    const win = refs.win.current
    if (v.hidden || v.closing || !win) return
    from = measureFrom(win, origin)
    nav.closing()
    motion.to(0, { damping: 1, response: 0.26 })
    if (reducedMotion.matches) motion.set(0)
  }

  const back = () => {
    if (!nav.back()) close()
  }

  async function system(path: string | undefined, how: 'open' | 'reveal'): Promise<void> {
    const t = deps.t()
    if (!deps.canEdit()) return deps.toast(t('mobile.readOnly'), true)
    const error = await api.open(path ?? '', how)
    if (error) deps.toast(error, true)
  }

  async function copy(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path)
      deps.toast(deps.t()('ql.copied'))
    } catch (err) {
      deps.toast(err instanceof Error ? err.message : String(err), true)
    }
  }

  const engine: QuickLookEngine = {
    view,
    openNow,
    refs,
    nav,
    grow() {
      const win = refs.win.current
      if (!growing || !win || nav.view().hidden) return
      growing = false
      from = measureFrom(win, origin)
      if (motion.value <= 0.001) paint(0)
      motion.to(1, { damping: 1, response: 0.34 })
      deps.focus().open(origin ?? document.activeElement)
    },
    back,
    close,
    go: path => nav.push({ kind: 'file', path, line: null }),
    setMode: mode => nav.setMode(mode),
    act(how) {
      const { data, top } = nav.view()
      const path = data ? data.path : top?.kind === 'file' ? top.path : undefined
      if (how !== 'copy') return void system(path, how)
      const line = data && 'line' in data ? data.line : null
      void copy(line ? `${path}:${line}` : String(path))
    },
    upgrade: (root, cwd) => deps.upgrade(root, cwd),
    keydown(e) {
      // Taken before the page's own keys: Esc here must not close the session sheet as well.
      if (!isOpen() || !deps.focus().isTop()) return
      const typing = TYPING.test(document.activeElement?.tagName ?? '')
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      } else if ((e.key === 'Backspace' && !typing) || (e.key === 'ArrowLeft' && e.altKey)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        back()
      }
    },
    stop: () => void motion.stop(),
  }

  return {
    open: false,
    isOpen,
    look(target, el) {
      if (target.path) lookAt({ kind: 'file', path: target.path, line: target.line ?? null }, el)
    },
    lookChanges(key, el) {
      if (key) lookAt({ kind: 'changes', key }, el)
    },
    lookHistory(key, cwd, el) {
      if (key) lookAt({ kind: 'history', key, cwd }, el)
    },
    back,
    close,
    engine,
  }
}

/** The page's quick look; `upgrade` makes chips of the paths it shows. */
export function useQuickLook(upgrade: (root: HTMLElement, cwd: string) => void): QuickLook {
  const t = useT()
  const board = useBoardContext()
  const latest = useLatest({ t, board, upgrade })
  const [refs] = useState<LookRefs>(() => ({
    layer: createRef(),
    win: createRef(),
    scrim: createRef(),
    body: createRef(),
  }))
  const focus = useModalFocus(refs.layer, refs.win)
  const focusRef = useLatest(focus)
  const [look] = useState(() =>
    quickLookEngine({
      refs,
      focus: () => focusRef.current,
      api: filesApi(() => latest.current.t),
      t: () => latest.current.t,
      // The files are the board's own: they need only the board, not fresh herdr data.
      canEdit: () => latest.current.board.canEdit,
      toast: (text, error) => latest.current.board.toast(text, error),
      upgrade: (root, cwd) => latest.current.upgrade(root, cwd),
    }),
  )
  useEffect(() => () => look.engine.stop(), [look])

  // Before the page's own keys (capture on the window).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => look.engine.keydown(e)
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [look])

  // The page draws again only when it opens or closes; what it shows is <QuickLook>'s to draw.
  const open = useStore(look.engine.openNow)
  return { ...look, open }
}
