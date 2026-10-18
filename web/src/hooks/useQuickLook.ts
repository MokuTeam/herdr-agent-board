// The quick look over the board (the old page's files.js look, close, back and its keys): it
// grows out of the chip or button it was opened from and shrinks back into it, on a spring that
// can be caught midway; it dims the board and takes the focus (hooks/useModalFocus.ts), Esc
// closes it, Backspace or Alt+← walks back; an image on show zooms (components/files/zoom.ts), by
// its keys too. What it shows step by step is models/quick-look.ts; components/files/QuickLook.tsx
// draws it.
import { createRef, type RefObject, useEffect, useState } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { type FilesApi, filesApi } from '../api/files.ts'
import { type ImageZoom, zoomImage } from '../components/files/zoom.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { NO_ZOOM, type ZoomFoot, zoomFootAfter, zoomShown } from '../models/files.ts'
import { paintWindow } from '../models/grow.ts'
import type { FocusScope } from '../models/modal-focus.ts'
import {
  type FileLook,
  type LookMode,
  type LookTarget,
  type LookView,
  type QuickLookNav,
  quickLookNav,
} from '../models/quick-look.ts'
import { reducedMotion, Spring } from '../models/spring.ts'
import type { ZoomState } from '../models/zoom.ts'
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
  /**
   * The zoom of the image on show, for the footer, and the one it showed last: drawn again only
   * when what the bar shows changes.
   */
  zoom: Store<ZoomFoot>
  /**
   * The image of `data` loaded: it zooms (when it has a size); its own size, for the footer, when
   * it has one.
   */
  imageLoaded(img: HTMLImageElement, data: FileLook): { width: number; height: number } | null
  /** The image is no longer drawn: its zoom goes. */
  imageGone(img: HTMLImageElement): void
  /** The footer's button: in to 100% from fit, else back to fit. */
  toggleZoom(): void
  /** A key, before the page's own: Esc closes it, Backspace or Alt+← walks back, + − 0 and the arrows zoom. */
  keydown(e: LookKey): void
  /** The spring stops (the page goes). */
  stop(): void
}

/** What the quick look reads of a key press. */
export interface LookKey {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
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

  // An image zooms (components/files/zoom.ts); the footer shows the scale and a button in to 100%
  // or back to fit. A step, another look and the close drop it, as each opening starts fitted.
  let zoom: { img: HTMLImageElement; control: ImageZoom } | null = null
  const zoomNow = new Store<ZoomFoot>(NO_ZOOM)
  let shownZoom = ''
  function zoomBar(z: ZoomState | null): void {
    // Called on every frame of a zoom: the bar is only drawn again when a whole percent changes.
    const shown = zoomShown(z)
    if (shown === shownZoom) return
    shownZoom = shown
    zoomNow.set(zoomFootAfter(zoomNow.get(), z))
  }
  function dropZoom(): void {
    zoom?.control.destroy()
    zoom = null
    zoomBar(null)
  }

  function paint(p: number): void {
    const win = refs.win.current
    const scrim = refs.scrim.current
    if (win && scrim) paintWindow(win, scrim, p, from)
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
      dropZoom()
      nav.closed()
      deps.focus().close()
    },
  })

  const isOpen = () => openNow.get()

  function lookAt(target: LookTarget, el: Element | null | undefined): void {
    dropZoom()
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
    if (nav.view().depth < 2) return close()
    dropZoom()
    nav.back()
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
    go(path) {
      dropZoom()
      nav.push({ kind: 'file', path, line: null })
    },
    setMode(mode) {
      dropZoom()
      nav.setMode(mode)
    },
    act(how) {
      const { data, top } = nav.view()
      const path = data ? data.path : top?.kind === 'file' ? top.path : undefined
      if (how !== 'copy') return void system(path, how)
      const line = data && 'line' in data ? data.line : null
      void copy(line ? `${path}:${line}` : String(path))
    },
    upgrade: (root, cwd) => deps.upgrade(root, cwd),
    zoom: zoomNow,
    imageLoaded(img, data) {
      // Walked away before it loaded: the footer is someone else's by now.
      if (!img.isConnected) return null
      const own = img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : null
      // An SVG without a size of its own zooms from the size it was fitted at.
      const size =
        img.naturalWidth && img.naturalHeight
          ? { w: img.naturalWidth, h: img.naturalHeight }
          : { w: img.offsetWidth, h: img.offsetHeight }
      const stage = img.parentElement
      if (data.kind === 'image' && size.w && size.h && stage) {
        dropZoom()
        const vector = /\.svg$/i.test(data.path ?? '')
        zoom = { img, control: zoomImage(stage, img, { size, vector, onChange: zoomBar }) }
      }
      return own
    },
    imageGone(img) {
      if (zoom?.img === img) dropZoom()
    },
    toggleZoom: () => zoom?.control.toggle(),
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
      } else if (zoom && !typing && zoom.control.key(e)) {
        // + − 0 with or without Ctrl: the image zooms, not the page.
        e.preventDefault()
        e.stopImmediatePropagation()
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
