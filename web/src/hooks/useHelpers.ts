// A session's helpers in a window over the dimmed board (the old page's helpers.js initHelpers),
// grown out of the row or the line it was opened from and shrunk back into it, like the quick
// look: every subagent, fork, workflow agent and teammate of the session, and one helper's own
// conversation, read again every second and a half while the helper works. Esc closes it;
// Backspace (or Alt+←, or the back button) goes from a helper to the list. What it shows is
// components/helpers/HelpersWindow.tsx's to draw; the list comes from the open sheet's detail.
import { createRef, type RefObject, useEffect, useState } from 'react'
import type { Item, Translator } from '../../../src/core/types.ts'
import type { SessionDetail } from '../api/client.ts'
import { type HelperRead, type HelperReply, readHelper } from '../api/helpers.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { paintWindow } from '../models/grow.ts'
import type { FocusScope } from '../models/modal-focus.ts'
import { reducedMotion, Spring } from '../models/spring.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { Store, useStore } from '../state/store.ts'
import { useGoToSession } from './useGoToSession.ts'
import { useLatest } from './useLatest.ts'
import { useModalFocus } from './useModalFocus.ts'
import { measureFrom } from './useQuickLook.ts'

/** One helper's conversation ({ id }), or the list ({ list, run }: scrolled to that workflow run once). */
export type HelperRef = { id: string } | { list: true; run: string | null }

export interface HelpersView {
  hidden: boolean
  /** Shrinking away: no longer open. */
  closing: boolean
  /** The session whose helpers it shows. */
  key: string | null
  /** What it shows, the top last; Back steps down. */
  stack: readonly HelperRef[]
  /** Moves on with every new thing on show: an answer for an older one is dropped. */
  seq: number
  /** The helper on show as last read. */
  data: HelperReply | null
  /** The first answer since it came on show: the conversation goes to its end. */
  first: boolean
  /** Why it could not be read, while nothing was read yet. */
  error: string
}

/** The open sheet's session and its detail: the list and the helpers' heads come from it. */
export interface SheetSide {
  key: string | null
  data: SessionDetail | null
}

export interface HelpersRefs {
  /** The layer: a direct child of <body> (useModalFocus makes the rest of the page inert). */
  layer: RefObject<HTMLDivElement | null>
  win: RefObject<HTMLElement | null>
  scrim: RefObject<HTMLDivElement | null>
  body: RefObject<HTMLDivElement | null>
}

/** What a key press is to the window. */
export interface HelpersKey {
  key: string
  altKey: boolean
  preventDefault(): void
  stopImmediatePropagation(): void
}

export interface HelpersEngine {
  view: Store<HelpersView>
  sheet: Store<SheetSide>
  openNow: Store<boolean>
  refs: HelpersRefs
  isOpen(): boolean
  /** The helpers of session `key`, grown from `el`. */
  open(key: string, ref: HelperRef, el?: Element | null): void
  close(): void
  /** From a helper to what was before it; from the first, it closes. */
  back(): void
  /** A helper of the session, over what is on show (a row, a name in its conversation). */
  pushHelper(id: string): void
  /** The list at a workflow run's agents. */
  pushRun(id: string): void
  /** Another session: the window closes, that session opens. */
  session(key: string): void
  /** The open sheet's detail changed. */
  feed(side: SheetSide): void
  /** After a draw: one that just opened grows out of where it came from. */
  grow(): void
  /** The body scrolled: at its end it keeps to its end as the helper writes on. */
  scrolled(): void
  pinned(): boolean
  /** A key, before the page's own. */
  keydown(e: HelpersKey): void
  stop(): void
}

interface EngineDeps {
  refs: HelpersRefs
  focus(): FocusScope
  t(): Translator
  item(key: string): Item | undefined
  read(key: string, id: string): Promise<HelperRead>
  openSession(key: string): void
  /** The page is out of sight: a poll waits. */
  hidden(): boolean
}

const CLOSED: HelpersView = {
  hidden: true,
  closing: false,
  key: null,
  stack: [],
  seq: 0,
  data: null,
  first: false,
  error: '',
}
const TYPING = /^(INPUT|TEXTAREA)$/

export function helpersEngine(deps: EngineDeps): HelpersEngine {
  const { refs } = deps
  const view = new Store<HelpersView>(CLOSED)
  const openNow = new Store(false)
  const sheet = new Store<SheetSide>({ key: null, data: null })
  let origin: Element | null = null
  let growing = false
  let from = { dx: 0, dy: 24, s: 0.94 }
  let timer: ReturnType<typeof setTimeout> | undefined
  let pinned = true

  const set = (patch: Partial<HelpersView>) => {
    const next = { ...view.get(), ...patch }
    view.set(next)
    openNow.set(!next.hidden && !next.closing)
  }
  const top = () => view.get().stack.at(-1)

  function paint(p: number): void {
    const win = refs.win.current
    const scrim = refs.scrim.current
    if (win && scrim) paintWindow(win, scrim, p, from)
  }

  // 0 = folded into what it came from, 1 = open; a close while opening turns around.
  const motion: Spring = new Spring({
    value: 0,
    damping: 1,
    response: 0.34,
    precision: 0.002,
    onUpdate: v => paint(v),
    onRest: v => {
      if (v === 0) finishClose()
    },
  })

  const isOpen = () => openNow.get()

  function stopPolling(): void {
    clearTimeout(timer)
    timer = undefined
  }

  // While it works, read it again; a hidden page reads nothing until it is back.
  function poll(seq: number, ms: number): void {
    stopPolling()
    timer = setTimeout(() => {
      if (seq !== view.get().seq || !isOpen()) return
      if (deps.hidden()) return poll(seq, ms)
      void load(seq)
    }, ms)
  }

  async function load(seq: number, first = false): Promise<void> {
    const v = view.get()
    const ref = top()
    if (!v.key || !ref || !('id' in ref)) return
    const r = await deps.read(v.key, ref.id)
    const now = view.get()
    if (seq !== now.seq || now.hidden) return
    if (!r.ok) {
      if (!now.data) set({ error: r.error })
      // Not there (another session now, its files gone): asking again will not change that.
      if (!r.gone) poll(seq, 4000)
      return
    }
    set({ data: r.data, first, error: '' })
    if (r.data.helper.status === 'running') poll(seq, 1500)
  }

  /** What is on show anew: what the sheet knows shows at once, a helper's conversation follows. */
  function show(stack: readonly HelperRef[], patch: Partial<HelpersView> = {}): void {
    stopPolling()
    pinned = true
    const seq = view.get().seq + 1
    set({ ...patch, stack, seq, data: null, first: false, error: '' })
    const ref = stack.at(-1)
    if (ref && 'id' in ref) void load(seq, true)
  }

  function open(key: string, ref: HelperRef, el?: Element | null): void {
    if (!deps.item(key)) return
    const v = view.get()
    if (isOpen() && v.key === key) {
      show([...v.stack, ref])
      return
    }
    origin = el ?? null
    growing = true
    show(['id' in ref ? ref : { list: true, run: ref.run ?? null }], { key, hidden: false, closing: false })
  }

  function close(): void {
    const v = view.get()
    const win = refs.win.current
    if (v.hidden || v.closing) return
    stopPolling()
    if (win) from = measureFrom(win, origin)
    set({ closing: true })
    motion.to(0, { damping: 1, response: 0.26 })
    if (reducedMotion.matches) motion.set(0)
  }

  function finishClose(): void {
    set({ ...CLOSED, seq: view.get().seq })
    deps.focus().close()
    // The row it came from may have been drawn anew meanwhile: the same row takes the focus back.
    const el = origin instanceof HTMLElement ? origin : null
    if (el && !el.isConnected && document.activeElement === document.body) {
      const helper = el.dataset.helper
      const run = el.dataset.runOpen
      const sel = helper
        ? `[data-helper="${CSS.escape(helper)}"]`
        : run
          ? `[data-run-open="${CSS.escape(run)}"]`
          : el.matches('[data-helpers-all]')
            ? '[data-helpers-all]'
            : ''
      if (sel) document.querySelector<HTMLElement>(`#sheet ${sel}`)?.focus({ preventScroll: true })
    }
  }

  function back(): void {
    const v = view.get()
    if (v.stack.length < 2) close()
    else show(v.stack.slice(0, -1))
  }

  return {
    view,
    sheet,
    openNow,
    refs,
    isOpen,
    open,
    close,
    back,
    pushHelper(id) {
      const v = view.get()
      const d = sheet.get()
      if (d.key === v.key && (d.data?.helpers ?? []).some(h => h.id === id)) show([...v.stack, { id }])
    },
    pushRun: id => show([...view.get().stack, { list: true, run: id }]),
    session(key) {
      if (!deps.item(key)) return
      close()
      deps.openSession(key)
    },
    feed(side) {
      const was = sheet.get()
      if (was.key !== side.key || was.data !== side.data) sheet.set(side)
    },
    grow() {
      const win = refs.win.current
      if (!growing || !win || view.get().hidden) return
      growing = false
      from = measureFrom(win, origin)
      if (motion.value <= 0.001) paint(0)
      motion.to(1, { damping: 1, response: 0.34 })
      deps.focus().open(origin ?? document.activeElement)
    },
    scrolled() {
      const body = refs.body.current
      if (body) pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 40
    },
    pinned: () => pinned,
    keydown(e) {
      // Before the page's own keys: Esc here must not close the session sheet as well.
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
    stop() {
      stopPolling()
      motion.stop()
    },
  }
}

export interface HelpersUi {
  /** It is open (not shrinking away): for the Back button's layers. */
  open: boolean
  isOpen(): boolean
  /** A helper of the session in the sheet ({ id }) or the list of them ({ list, run }), grown from `el`. */
  show(ref: HelperRef, el?: Element | null): void
  back(): void
  close(): void
  engine: HelpersEngine
}

/** The page's helpers window, for the session open in the sheet. */
export function useHelpers(): HelpersUi {
  const t = useT()
  const board = useBoardContext()
  const openSession = useGoToSession()
  const latest = useLatest({ t, board, openSession })
  const [refs] = useState<HelpersRefs>(() => ({
    layer: createRef(),
    win: createRef(),
    scrim: createRef(),
    body: createRef(),
  }))
  const focus = useModalFocus(refs.layer, refs.win)
  const focusRef = useLatest(focus)
  const [engine] = useState(() =>
    helpersEngine({
      refs,
      focus: () => focusRef.current,
      t: () => latest.current.t,
      item: key => latest.current.board.data?.items.find(i => i.key === key),
      read: (key, id) => readHelper(key, id, latest.current.t),
      openSession: key => latest.current.openSession(key),
      hidden: () => document.hidden,
    }),
  )
  useEffect(() => () => engine.stop(), [engine])

  // Before the page's own keys (capture on the window).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => engine.keydown(e)
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [engine])

  const open = useStore(engine.openNow)
  return {
    open,
    isOpen: engine.isOpen,
    show(ref, el) {
      const key = latest.current.board.ui.open
      if (key) engine.open(key, ref, el)
    },
    back: engine.back,
    close: engine.close,
    engine,
  }
}
