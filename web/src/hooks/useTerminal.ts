// The board's terminal (the old page's terminal.js): a window over the dimmed board, grown out of
// the button it was opened from, like the quick look. It shows one of two terminals of a session, live:
//   Shell   a shell the board opens in the session's folder (a herdr tab of its own), to run
//           something there: a login, an unlock, the tests.
//   Agent   the session's own pane, to answer its terminal where the board has no form for it
//           (/login, /mcp, a menu).
// Keys go to the terminal while its screen has the focus: a click or a tap gives it, Ctrl+]
// takes it back (then Esc closes the window), and the screen's ring says which it is. The
// session's own terminal starts without it, so an Esc meant for the window never stops a turn.
// Typed text and keys go to the server in order, one request at a time; the screen comes back
// as line diffs over Server-Sent Events (src/services/terminals.ts).
//
// The screen's rows are drawn here, by hand, as the diffs come (a row per line, kept while it
// stays the same); components/terminal/Terminal.tsx draws the rest of the window from `view`.
import { createRef, type RefObject, useEffect, useState } from 'react'
import { keyStep, mergeSteps, type TermStep, textSteps } from '../../../src/core/terminal/term-keys.ts'
import { applyDiff, caretSpot, fitFont, type LineDiff } from '../../../src/core/terminal/term-model.ts'
import type { Item, Translator, Vars } from '../../../src/core/types.ts'
import { STREAM_CLOSED, type TerminalApi, type TermStream, terminalApi } from '../api/terminal.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { paintWindow } from '../models/grow.ts'
import type { FocusScope } from '../models/modal-focus.ts'
import { reducedMotion, Spring } from '../models/spring.ts'
import {
  batchSize,
  INPUT_TIMEOUT,
  lineHtml,
  MAX_PASTE,
  MAX_PENDING,
  type PendingPaste,
  pasteOf,
  TARGET_KEY,
  type TermStatus,
  type TermTarget,
  targetFor,
} from '../models/terminal.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { storage } from '../state/storage.ts'
import { Store, useStore } from '../state/store.ts'
import { useLatest } from './useLatest.ts'
import { useModalFocus } from './useModalFocus.ts'
import { measureFrom } from './useQuickLook.ts'
import { useSessionActions } from './useSessionActions.ts'

export interface TermRefs {
  /** The layer: a direct child of <body> (useModalFocus makes the rest of the page inert). */
  layer: RefObject<HTMLDivElement | null>
  win: RefObject<HTMLElement | null>
  scrim: RefObject<HTMLDivElement | null>
  screen: RefObject<HTMLDivElement | null>
  scroller: RefObject<HTMLDivElement | null>
  /** The rows: drawn here, never by React. */
  lines: RefObject<HTMLDivElement | null>
  /** The field the keys arrive in. */
  input: RefObject<HTMLTextAreaElement | null>
}

/** What the window draws besides the rows. */
export interface TermView {
  hidden: boolean
  /** The session on show. */
  key: string | null
  /** Its name and agent as the head says them: read when the window opened on it. */
  label: { name: string; agent?: string | undefined } | null
  target: TermTarget
  status: TermStatus
  error: string
  /** Gone because the session is off the board for now. */
  missing: boolean
  /** The screen has the keys. */
  typing: boolean
  /** A request herdr takes long over. */
  waitingSend: boolean
  /** Keys were dropped: herdr was too slow. */
  slowNote: boolean
  /** "Close the shell" was clicked once: the next click closes it. */
  armed: boolean
  /** Rows are on the screen. */
  hasLines: boolean
  /** A paste of several lines waiting for its yes. */
  paste: Omit<PendingPaste, 'text'> | null
}

export interface TerminalDeps {
  refs: TermRefs
  focus(): FocusScope
  api: TerminalApi
  t(): Translator
  toast(text: string, error?: boolean): void
  /** Fresh herdr data: typing and opening a shell need it; looking does not. */
  canMutate(): boolean
  item(key: string): Item | undefined
  /** The per-run token for the stream (the board payload's fsToken). */
  token(): string | null
  /** The sessions the board has a shell open for. */
  shells(): readonly string[]
  wake(key: string): Promise<void>
  focusAgent(key: string): void
  openUrl(href: string): void
  storage: { get(key: string, fallback: string): string; set(key: string, value: string): void }
  /** The pointer is a finger. */
  coarse(): boolean
}

export interface TerminalEngine {
  view: Store<TermView>
  /** Open and not shrinking away: for the Back button's layers. */
  openNow: Store<boolean>
  refs: TermRefs
  /** The terminal of session `key` grown from `el`; `target` agent or shell (else the last used). */
  open(key: string, el?: Element | null, target?: TermTarget): void
  close(): void
  isOpen(): boolean
  /** After a draw: one that just opened grows out of where it came from. */
  grow(): void
  /** The listeners on the window's elements, the page and the window; returns what takes them away. */
  mount(): () => void
  /** The board changed: fresh data or not, the session still there, a shell opened or closed. */
  boardChanged(): void
  /** The head's switch between the session's own terminal and the shell. */
  pickTarget(target: TermTarget): void
  /** "Open in herdr". */
  toHerdr(): Promise<void>
  /** "Close the shell": the first click arms it, the second closes (what runs in it stops). */
  closeShell(): Promise<void>
  /** The dimmed board or the close button. */
  clickClose(): void
  /** A click on the screen gives it the keys, unless it made a selection or hit a link. */
  clickScreen(e: { target: unknown; preventDefault(): void }): void
  /** The state panel's button: open the shell, connect again, wake the session. */
  stateDo(what: 'start' | 'retry' | 'wake'): void
  settlePaste(yes: boolean): void
  /** A key of the phone's row. */
  sendKey(key: string): void
  stop(): void
}

interface Closest {
  closest(selector: string): unknown
}
const hasClosest = (x: unknown): x is Closest =>
  typeof x === 'object' && x !== null && 'closest' in x && typeof x.closest === 'function'
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A frame as the server sends it, as far as the window reads it. */
function frameOf(m: Record<string, unknown>): LineDiff & { cols: number | null } {
  return {
    drop: typeof m.drop === 'number' ? m.drop : 0,
    keep: typeof m.keep === 'number' ? m.keep : 0,
    lines: Array.isArray(m.lines) ? m.lines.map(String) : [],
    cols: typeof m.cols === 'number' ? m.cols : null,
  }
}

export function terminalEngine(deps: TerminalDeps): TerminalEngine {
  const { refs, api } = deps
  const tr = (key: string, vars?: Vars) => deps.t()(key, vars)

  const s = {
    key: null as string | null,
    target: 'shell' as TermTarget,
    es: null as TermStream | null,
    lines: [] as string[],
    nodes: [] as HTMLElement[],
    cols: null as number | null,
    status: 'idle' as TermStatus,
    error: '',
    missing: false, // gone because the session is off the board for now
    typing: false,
    pending: [] as TermStep[],
    sending: false,
    seq: 0,
    paste: null as PendingPaste | null,
    closeArmed: 0,
    waitingSend: false, // a request herdr takes long over
    slowNote: false, // keys were dropped: herdr was too slow
    paused: false, // the page is hidden: no reading meanwhile
  }
  let hidden = true
  // Opened, drawn, and not grown yet (grow() runs after the draw).
  let growing = false
  let label: TermView['label'] = null

  const view = new Store<TermView>(snapshot())
  const openNow = new Store(false)
  function snapshot(): TermView {
    return {
      hidden,
      key: s.key,
      label,
      target: s.target,
      status: s.status,
      error: s.error,
      missing: s.missing,
      typing: s.typing,
      waitingSend: s.waitingSend,
      slowNote: s.slowNote,
      armed: Date.now() - s.closeArmed < 3000,
      hasLines: s.nodes.length > 0,
      paste: s.paste && { n: s.paste.n, shown: s.paste.shown },
    }
  }
  /** The window draws again: the footer, the switch, the buttons, from the state as it is now. */
  function changed(): void {
    view.set(snapshot())
    openNow.set(isOpen())
  }

  // ------------------------------------------------------------ the window's motion
  // 0 = folded into the button it came from, 1 = open; a close while opening turns around.
  const motion: Spring = new Spring({
    value: 0,
    damping: 1,
    response: 0.34,
    precision: 0.002,
    onUpdate: v => paint(v),
    onRest: v => v === 0 && finishClose(),
  })
  // Where it grows from: the button's centre and width, or a small drop when it is gone.
  let from = { dx: 0, dy: 24, s: 0.94 }
  let origin: Element | null = null
  let openedAt = 0
  function paint(p: number): void {
    const win = refs.win.current
    const scrim = refs.scrim.current
    if (win && scrim) paintWindow(win, scrim, p, from)
  }

  const isOpen = () => !hidden && (growing || motion.target === 1)
  // The click a tap leaves behind (a menu item picked on a phone) lands on what just opened.
  const fresh = () => performance.now() - openedAt < 450
  const it = () => (s.key ? deps.item(s.key) : undefined)
  const hasShell = (key: string | null) => !!key && (deps.shells() ?? []).includes(key)

  function open(key: string, el?: Element | null, target?: TermTarget): void {
    const x = deps.item(key)
    if (!x) return
    const want = target ?? deps.storage.get(TARGET_KEY, 'shell')
    const switching = !hidden && s.key !== key
    s.key = key
    s.target = targetFor(want, x)
    if (hidden || (!growing && motion.target === 0)) {
      openedAt = performance.now()
      origin = el ?? null
      hidden = false
      label = { name: x.name, agent: x.agent }
      // Drawn first (components/terminal/Terminal.tsx), then it grows: grow().
      growing = true
    } else if (switching) label = { name: x.name, agent: x.agent }
    void connect({ focusScreen: s.target === 'shell' })
    changed()
  }

  function grow(): void {
    const win = refs.win.current
    if (!growing || hidden || !win) return
    growing = false
    from = measureFrom(win, origin)
    if (motion.value <= 0.001) paint(0)
    motion.to(1, { damping: 1, response: 0.34 })
    deps.focus().open(origin ?? document.activeElement)
    changed()
  }

  function close(): void {
    if (hidden || (!growing && motion.target === 0)) return
    disconnect()
    if (growing) {
      // Closed before it was drawn: there is nothing to shrink.
      growing = false
      finishClose()
      return
    }
    const win = refs.win.current
    if (win) from = measureFrom(win, origin)
    motion.to(0, { damping: 1, response: 0.26 })
    if (reducedMotion.matches) motion.set(0)
    changed()
  }
  function finishClose(): void {
    hidden = true
    if (refs.lines.current) refs.lines.current.textContent = ''
    s.nodes = []
    s.lines = []
    s.key = null
    deps.focus().close()
    changed()
  }

  // ------------------------------------------------------------ the stream
  function disconnect(): void {
    s.es?.close()
    s.es = null
    s.seq++
    s.pending = []
    s.waitingSend = false
    s.slowNote = false
    s.paused = false
    s.paste = null
    if (s.typing) refs.input.current?.blur()
    changed()
  }

  /** Start showing the chosen terminal: open the shell first when there is none yet. */
  async function connect({ focusScreen = false } = {}): Promise<void> {
    disconnect()
    const seq = s.seq
    const x = it()
    clearScreen()
    s.cols = null
    s.closeArmed = 0
    s.missing = !x
    if (!x) return setStatus('gone')
    if (s.target === 'agent') {
      if (x.sleeping) return setStatus('asleep')
      return stream(seq, focusScreen)
    }
    if (hasShell(x.key)) return stream(seq, focusScreen)
    if (!deps.canMutate()) return setStatus('none')
    setStatus('starting')
    const r = await api.post(x.key, 'shell', 'open', {})
    if (seq !== s.seq) return
    if (!r.ok) return setStatus('error', r.error ?? '')
    stream(seq, focusScreen)
  }

  function stream(seq: number, focusScreen: boolean): void {
    setStatus('connecting')
    const x = it()
    if (!x) return
    const es = api.stream(x.key, s.target, deps.token() ?? '')
    s.es = es
    let first = true
    let takeFocus = focusScreen
    es.onmessage = e => {
      if (seq !== s.seq) return es.close()
      let msg: unknown
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      if (!isRecord(msg)) return
      if (msg.t === 'frame') {
        if (first) {
          first = false
          clearScreen()
        }
        frame(frameOf(msg))
        if (s.status === 'live' && s.error) setStatus('live') // herdr answers again
        if (s.status !== 'live') {
          setStatus('live')
          // Not on a phone: its keyboard would cover the screen before anything is on it.
          if (takeFocus && !deps.coarse()) takeKeys()
          takeFocus = false
        }
      } else if (msg.t === 'gone') {
        es.close()
        setStatus('gone')
      } else if (msg.t === 'error') setStatus('live', tr('term.error', { why: String(msg.why) }))
    }
    es.onerror = () => {
      if (seq !== s.seq) return es.close()
      // Closed for good: the server said no (no shell any more, the session left, the token).
      if (es.readyState === STREAM_CLOSED)
        setStatus(
          s.target === 'shell' && !hasShell(s.key) ? 'gone' : 'error',
          tr('term.error', { why: '' }).replace(/:\s*$/, ''),
        )
      else setStatus('connecting')
    }
  }

  // ------------------------------------------------------------ the screen
  // Pinned to the bottom, as a terminal is, until the user scrolls up; back down, pinned again.
  let pinned = true
  let lastTop = 0
  function clearScreen(): void {
    if (refs.lines.current) refs.lines.current.textContent = ''
    s.nodes = []
    s.lines = []
    pinned = true
    lastTop = 0
  }

  function lineNode(line: string): HTMLElement {
    const div = document.createElement('div')
    div.className = 'tl'
    div.innerHTML = lineHtml(line)
    return div
  }

  const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 6
  const toBottom = () => {
    const el = refs.scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }

  function frame(d: LineDiff & { cols: number | null }): void {
    const linesEl = refs.lines.current
    if (!linesEl) return
    const stick = pinned || !s.nodes.length
    const keep = s.nodes.slice(d.drop, d.drop + d.keep)
    for (const n of s.nodes.slice(0, d.drop)) n.remove()
    for (const n of s.nodes.slice(d.drop + d.keep)) n.remove()
    const rows = d.lines.map(lineNode)
    linesEl.append(...rows)
    s.nodes = keep.concat(rows)
    s.lines = applyDiff(s.lines, d)
    if (d.cols && d.cols !== s.cols) {
      s.cols = d.cols
      fit()
    }
    placeCaret()
    changed()
    if (stick) toBottom()
  }

  /**
   * herdr does not say where a terminal's cursor is: the caret goes where the screen says it
   * most likely is (core/terminal/term-model.ts), after a shell's prompt or in Claude Code's input
   * box. Shown once the screen has been still for a moment, never while output runs.
   */
  let caretTimer: ReturnType<typeof setTimeout> | undefined
  let caretEl: HTMLElement | null = null
  const caret = (): HTMLElement => {
    caretEl ??= Object.assign(document.createElement('span'), { className: 'tcaret' })
    return caretEl
  }
  function placeCaret(): void {
    caretEl?.remove()
    clearTimeout(caretTimer)
    const kind = s.target === 'shell' ? 'shell' : it()?.agent === 'claude' ? 'claude' : null
    if (!kind) return
    caretTimer = setTimeout(() => {
      const linesEl = refs.lines.current
      const spot = caretSpot(s.lines, kind)
      const node = spot && s.nodes[spot.line]
      if (!spot || !node?.isConnected || !linesEl) return
      // Lines wrap at the window's edge: a row holds as many columns as fit there.
      const style = getComputedStyle(linesEl)
      const per = Math.max(
        1,
        Math.floor(linesEl.clientWidth / (charRatio() * Number.parseFloat(style.fontSize)) + 0.01),
      )
      const c = caret()
      c.style.left = `${spot.col % per}ch`
      c.style.top = `${node.offsetTop + Math.floor(spot.col / per) * Number.parseFloat(style.lineHeight)}px`
      linesEl.append(c)
    }, 350)
  }

  // The text's size: the pane's columns fit the window, down to a size that still reads; below
  // that the lines wrap sooner than the pane's (a phone).
  let ratio = 0
  function charRatio(): number {
    if (ratio) return ratio
    const linesEl = refs.lines.current
    if (!linesEl) return 0.6
    const probe = document.createElement('span')
    probe.className = 'term-probe'
    probe.textContent = 'M'.repeat(50)
    linesEl.append(probe)
    // Its layout width: the window may still be scaled by its spring, which the box would count.
    ratio = probe.offsetWidth / 50 / 100 || 0
    probe.remove()
    return ratio || 0.6
  }
  function fit(): void {
    const scroller = refs.scroller.current
    const screen = refs.screen.current
    if (!scroller || !screen) return
    const style = getComputedStyle(scroller)
    const width = scroller.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
    const { size } = fitFont({ width, cols: s.cols, ratio: charRatio(), min: deps.coarse() ? 9.5 : 10, max: 14 })
    screen.style.setProperty('--term-size', `${size}px`)
  }

  // ------------------------------------------------------------ state
  const canInput = () => deps.canMutate() && s.status === 'live' && !!it() && !(s.target === 'agent' && it()?.sleeping)

  function setStatus(status: TermStatus, error = ''): void {
    s.status = status
    s.error = error
    if (status !== 'live' && s.typing) refs.input.current?.blur()
    changed()
  }

  // ------------------------------------------------------------ typing
  function takeKeys(): void {
    if (!canInput()) return
    // On a phone the keyboard comes up for a focused field: only on the user's own tap.
    refs.input.current?.focus({ preventScroll: true })
  }
  function leave(): void {
    refs.input.current?.blur()
    refs.win.current?.focus({ preventScroll: true })
  }

  const selection = (): string => {
    const sel = getSelection()
    const screen = refs.screen.current
    return sel && !sel.isCollapsed && screen?.contains(sel.anchorNode) ? sel.toString() : ''
  }

  function queue(steps: TermStep[]) {
    if (!steps.length) return
    if (!canInput()) return changed()
    // herdr this slow: what is typed meanwhile is dropped, said so, rather than land much later.
    if (s.pending.length + steps.length > MAX_PENDING) return slow()
    s.pending.push(...steps)
    void flush()
  }
  function slow(): void {
    s.pending = []
    s.slowNote = true
    changed()
  }

  async function flush(): Promise<void> {
    const key = s.key
    if (s.sending || !s.pending.length || !key) return
    s.sending = true
    const seq = s.seq
    // As much as one request takes: so many steps, so much text.
    const batch = mergeSteps(s.pending.splice(0, batchSize(s.pending)))
    // A request herdr takes long over says so; one it does not answer in time is given up, and
    // the server types nothing of it that late either (services/terminals.ts).
    const waiting = setTimeout(() => {
      s.waitingSend = true
      changed()
    }, 1500)
    const r = await api.post(
      key,
      s.target,
      'input',
      { session: deps.item(key)?.session ?? null, steps: batch },
      INPUT_TIMEOUT,
    )
    clearTimeout(waiting)
    s.sending = false
    s.waitingSend = false
    // Switched meanwhile: what was queued for the other terminal went; what came since goes now.
    if (seq !== s.seq) return flush()
    if (!r.ok) {
      // What was queued behind it would land somewhere unknown: it goes.
      s.pending = []
      if (r.timeout) s.slowNote = true
      else deps.toast(tr('term.lost', { why: r.error ?? '' }), true)
    } else s.slowNote = false
    changed()
    return flush()
  }

  /** One line goes as typed; more ask first, as every line runs. A last line break is left off. */
  function paste(raw: string) {
    const p = pasteOf(raw)
    if (p.kind === 'none') return
    if (p.kind === 'big') return deps.toast(tr('term.pasteBig', { kb: MAX_PASTE >> 10 }), true)
    if (p.kind === 'type') return queue(textSteps(p.text))
    s.paste = { text: p.text, n: p.n, shown: p.shown }
    changed()
  }
  function settlePaste(yes: boolean): void {
    const text = s.paste?.text
    s.paste = null
    changed()
    if (yes && text) queue(textSteps(text))
    if (s.status === 'live') takeKeys()
  }

  async function copySelection(): Promise<void> {
    const text = selection()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      deps.toast(tr('ql.copied'))
    } catch (err) {
      deps.toast(err instanceof Error ? err.message : String(err), true)
    }
  }

  // ------------------------------------------------------------ the field the keys arrive in
  let composing = false
  const onFocus = () => {
    s.typing = true
    if (refs.input.current) refs.input.current.value = ''
    placeCaret()
    changed()
  }
  const onBlur = () => {
    s.typing = false
    changed()
  }
  const onKeydown = (e: KeyboardEvent) => {
    if (s.paste) {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        settlePaste(e.key === 'Enter')
      }
      return
    }
    // Ctrl+` closes the window from anywhere in it, as it opened it.
    if (e.ctrlKey && e.code === 'Backquote') {
      e.preventDefault()
      e.stopPropagation()
      return close()
    }
    const step = keyStep(e, { selection: !!selection() })
    if (!step) return
    e.preventDefault()
    e.stopPropagation()
    if ('leave' in step) return leave()
    if ('copy' in step) return void copySelection()
    queue([{ key: step.key }])
  }
  const onCompositionStart = () => {
    composing = true
  }
  const onCompositionEnd = (e: CompositionEvent) => {
    composing = false
    queue(textSteps(e.data))
    if (refs.input.current) refs.input.current.value = ''
  }
  const onBeforeInput = (e: InputEvent) => {
    if (e.isComposing || composing) return
    const kind = e.inputType
    if (kind === 'insertText' || kind === 'insertReplacementText') {
      e.preventDefault()
      queue(textSteps(e.data ?? e.dataTransfer?.getData('text/plain') ?? ''))
    } else if (kind === 'insertLineBreak' || kind === 'insertParagraph') {
      e.preventDefault()
      queue([{ key: 'enter' }])
    } else if (kind === 'deleteContentBackward') {
      e.preventDefault()
      queue([{ key: 'backspace' }])
    } else if (kind === 'deleteContentForward') {
      e.preventDefault()
      queue([{ key: 'delete' }])
    } else if (kind === 'deleteWordBackward') {
      e.preventDefault()
      queue([{ key: 'ctrl+backspace' }])
    } else if (kind === 'insertFromPaste' || kind === 'insertFromDrop') e.preventDefault()
  }
  // Where the browser would not let the text be taken before it lands (some phone keyboards).
  const onInput = () => {
    const input = refs.input.current
    if (composing || !input?.value) return
    queue(textSteps(input.value))
    input.value = ''
  }
  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault()
    paste(e.clipboardData?.getData('text/plain') ?? '')
  }

  // The window's own keys while the screen does not have them: Esc closes, Ctrl+` too.
  const onWindowKey = (e: KeyboardEvent) => {
    if (!isOpen() || !deps.focus().isTop() || e.target === refs.input.current) return
    // A paste that asks first: Esc says no to it, the window stays.
    if (s.paste && e.key === 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
      return settlePaste(false)
    }
    if (e.key === 'Escape' || (e.code === 'Backquote' && e.ctrlKey)) {
      e.preventDefault()
      e.stopImmediatePropagation()
      close()
    }
  }

  // A page out of sight reads nothing: the stream goes while it is hidden and comes back with it.
  const onVisibility = () => {
    if (!isOpen()) return
    if (document.hidden && s.es) {
      disconnect()
      s.paused = true
    } else if (!document.hidden && s.paused) void connect()
  }

  // Only a scroll up away from the bottom unpins: the view coming down to it (ours too, whose
  // event may arrive after the screen changed again) never does.
  const onScroll = () => {
    const el = refs.scroller.current
    if (!el) return
    if (atBottom(el)) pinned = true
    else if (el.scrollTop < lastTop - 1) pinned = false
    lastTop = el.scrollTop
  }

  function mount(): () => void {
    const input = refs.input.current
    const scroller = refs.scroller.current
    const offs: (() => void)[] = []
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement | null,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      el?.addEventListener(type, fn)
      offs.push(() => el?.removeEventListener(type, fn))
    }
    on(input, 'focus', onFocus)
    on(input, 'blur', onBlur)
    on(input, 'keydown', onKeydown)
    on(input, 'compositionstart', onCompositionStart)
    on(input, 'compositionend', onCompositionEnd)
    on(input, 'beforeinput', onBeforeInput)
    on(input, 'input', onInput)
    on(input, 'paste', onPaste)
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    // A new size (the window, the key row coming, a phone's keyboard) keeps a pinned view pinned.
    const resize =
      scroller && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            if (hidden) return
            if (s.cols) fit()
            if (pinned) toBottom()
          })
        : null
    if (scroller) resize?.observe(scroller)
    addEventListener('keydown', onWindowKey, true)
    document.addEventListener('visibilitychange', onVisibility)
    // A phone's keyboard takes the bottom of the screen: the window keeps above it.
    const vv = globalThis.visualViewport
    const onViewport = () => {
      if (vv) refs.layer.current?.style.setProperty('--term-vh', `${vv.height}px`)
    }
    vv?.addEventListener('resize', onViewport)
    return () => {
      for (const off of offs) off()
      scroller?.removeEventListener('scroll', onScroll)
      resize?.disconnect()
      removeEventListener('keydown', onWindowKey, true)
      document.removeEventListener('visibilitychange', onVisibility)
      vv?.removeEventListener('resize', onViewport)
    }
  }

  async function toHerdr(): Promise<void> {
    if (fresh()) return
    const key = s.key
    if (!key) return
    if (s.target === 'agent') return deps.focusAgent(key)
    const r = await api.post(key, 'shell', 'focus', {})
    if (!r.ok) deps.toast(r.error ?? '', true)
  }

  async function closeShell(): Promise<void> {
    if (fresh()) return
    if (Date.now() - s.closeArmed > 3000) {
      s.closeArmed = Date.now()
      changed()
      setTimeout(changed, 3100)
      return
    }
    s.closeArmed = 0
    const key = s.key
    if (!key) return
    disconnect()
    const r = await api.post(key, 'shell', 'close', {})
    if (key !== s.key) return
    if (!r.ok) {
      deps.toast(r.error ?? '', true)
      return connect() // still there: back on show
    }
    deps.toast(tr('term.closed'))
    clearScreen()
    setStatus('gone')
  }

  return {
    view,
    openNow,
    refs,
    open,
    close,
    isOpen,
    grow,
    mount,
    boardChanged() {
      if (!isOpen()) return
      const x = it()
      // A session can be off the board for a refresh or two (waking up, say): it comes back.
      if (!x && s.status !== 'gone') {
        disconnect()
        s.missing = true
        setStatus('gone')
      } else if (x && s.missing) {
        s.missing = false
        void connect()
      } else if (
        x &&
        s.target === 'agent' &&
        x.sleeping !== (s.status === 'asleep') &&
        ['asleep', 'live', 'connecting'].includes(s.status)
      ) {
        // Woke up, or was put to sleep: its terminal is another program now.
        void connect()
      }
      changed()
    },
    pickTarget(target) {
      if (fresh()) return
      const x = it()
      const off = target === 'agent' ? !x?.pane : !x?.cwd
      if (off || target === s.target) return
      s.target = target
      deps.storage.set(TARGET_KEY, s.target)
      void connect({ focusScreen: s.target === 'shell' })
    },
    toHerdr,
    closeShell,
    clickClose() {
      if (!fresh()) close()
    },
    clickScreen(e) {
      if (fresh()) return
      const el = hasClosest(e.target) ? e.target : null
      const link = el?.closest('.tlink')
      if (link) {
        e.preventDefault()
        const url = isRecord(link) && isRecord(link.dataset) ? link.dataset.url : undefined
        return deps.openUrl(typeof url === 'string' ? url : '')
      }
      if (el?.closest('.term-state, .term-paste')) return
      if (!selection()) takeKeys()
    },
    stateDo(what) {
      if (what === 'start' || what === 'retry') void connect({ focusScreen: s.target === 'shell' })
      else if (what === 'wake' && s.key) void deps.wake(s.key).then(() => connect())
    },
    settlePaste,
    sendKey: key => queue([{ key }]),
    stop() {
      motion.stop()
      clearTimeout(caretTimer)
      s.es?.close()
    },
  }
}

/** What the page wires to the window (App.tsx). */
export interface TerminalUI {
  /** It is open (not shrinking away): for the Back button's layers. */
  open: boolean
  isOpen(): boolean
  /** The terminal of session `key`, grown from `from`; not where the board offers none. */
  openTerminal(key: string, from?: Element | null): void
  close(): void
  engine: TerminalEngine
}

/** The page's terminal window; `openUrl` opens a web link of the output in the default browser. */
export function useTerminal(openUrl: (href: string) => void): TerminalUI {
  const t = useT()
  const board = useBoardContext()
  const actions = useSessionActions()
  const latest = useLatest({ t, board, actions, openUrl })
  const [refs] = useState<TermRefs>(() => ({
    layer: createRef(),
    win: createRef(),
    scrim: createRef(),
    screen: createRef(),
    scroller: createRef(),
    lines: createRef(),
    input: createRef(),
  }))
  const focus = useModalFocus(refs.layer, refs.win)
  const focusRef = useLatest(focus)
  const [engine] = useState(() => {
    const page = () => latest.current
    const itemOf = (key: string) => page().board.data?.items.find(i => i.key === key)
    return terminalEngine({
      refs,
      focus: () => focusRef.current,
      api: terminalApi(() => page().t),
      t: () => page().t,
      toast: (text, error) => page().board.toast(text, error),
      canMutate: () => page().board.canMutate,
      item: itemOf,
      token: () => page().board.data?.fsToken ?? null,
      shells: () => page().board.data?.shells ?? [],
      // As "Wake" in the sheet, saying only what went wrong: the window shows the rest.
      async wake(key) {
        const { board, actions, t } = page()
        board.dispatch({ type: 'busy', key, label: t('busy.waking') })
        const r = await actions.act(key, 'wake')
        board.dispatch({ type: 'busy', key, label: null })
        if (!r.ok) board.toast(r.error, true)
      },
      focusAgent: key => void page().actions.focusSession(key),
      openUrl: href => page().openUrl(href),
      storage,
      coarse: () => matchMedia('(pointer: coarse)').matches,
    })
  })
  useEffect(() => {
    const unmount = engine.mount()
    return () => {
      unmount()
      engine.stop()
    }
  }, [engine])
  // Every change of the board: fresh data or not, the session still there, a shell opened or closed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are when to look again, not what it reads
  useEffect(() => engine.boardChanged(), [engine, board.data, board.canMutate])

  const open = useStore(engine.openNow)
  return {
    open,
    isOpen: engine.isOpen,
    openTerminal(key, from) {
      const data = latest.current.board.data
      if (data?.terminal === false || !data?.items.some(i => i.key === key)) return
      engine.open(key, from ?? null)
    },
    close: engine.close,
    engine,
  }
}
