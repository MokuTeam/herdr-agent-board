// The terminal window without the page (the old page's terminal.js, its pure parts): what one
// line of the screen is as markup, what the window says in its state panel and its footer, how
// much of the typed keys one request takes, what a paste asks first, and the sheet's Terminal
// button. hooks/useTerminal.ts runs the window; components/terminal/Terminal.tsx draws it.
import type { TermStep } from '../../../src/core/terminal/term-keys.ts'
import { MAX_STEPS, MAX_TEXT } from '../../../src/core/terminal/term-keys.ts'
import { parseLine, type TermRun, withLinks } from '../../../src/core/terminal/term-model.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import { esc } from './markdown.ts'

export type TermTarget = 'agent' | 'shell'
/** idle (never opened), connecting, starting (a shell being opened), live, none (no shell yet), gone, asleep, error. */
export type TermStatus = 'idle' | 'connecting' | 'starting' | 'live' | 'none' | 'gone' | 'asleep' | 'error'

// What one request may carry (the server checks the same).
export const MAX_PASTE = MAX_TEXT
// Keys waiting to go, at most; and how long a request may take before the page gives up on it
// (longer than the server types for one: services/terminals.ts).
export const MAX_PENDING = 400
export const INPUT_TIMEOUT = 8000
// The row of keys a phone's keyboard does not have.
export const KEY_ROW: readonly { key: string; label: string; aria?: string }[] = [
  { key: 'esc', label: 'Esc' },
  { key: 'tab', label: 'Tab' },
  { key: 'ctrl+c', label: '⌃C' },
  { key: 'left', label: '←', aria: 'Left' },
  { key: 'up', label: '↑', aria: 'Up' },
  { key: 'down', label: '↓', aria: 'Down' },
  { key: 'right', label: '→', aria: 'Right' },
]
/** Where the last used terminal is remembered (agent or shell). */
export const TARGET_KEY = 'board.termTarget'

/** One run of a line as markup: its colors as palette classes or inline colors, its attributes, its link. */
export function runHtml(r: TermRun): string {
  const st = r.style
  let fg: number | string | null = st.fg
  let bg: number | string | null = st.bg
  // Inverse with the screen's own colors swaps those too.
  if (st.inverse) [fg, bg] = [bg ?? 'screen', fg ?? 'ink']
  const cls: string[] = []
  const css: string[] = []
  if (typeof fg === 'number') cls.push(`f${fg}`)
  else if (fg === 'screen') cls.push('fs')
  else if (fg) css.push(`color:${fg}`)
  if (typeof bg === 'number') cls.push(`b${bg}`)
  else if (bg === 'ink') cls.push('bi')
  else if (bg) css.push(`background:${bg}`)
  if (st.bold) cls.push('tb')
  if (st.dim) cls.push('td')
  if (st.italic) cls.push('ti')
  if (st.underline || r.href) cls.push(st.strike ? 'tus' : 'tu')
  else if (st.strike) cls.push('ts')
  if (st.hidden) cls.push('th')
  if (r.href) cls.push('tlink')
  const attrs = `${cls.length ? ` class="${cls.join(' ')}"` : ''}${css.length ? ` style="${css.join(';')}"` : ''}${r.href ? ` data-url="${esc(r.href)}" title="${esc(r.href)}"` : ''}`
  return attrs ? `<span${attrs}>${esc(r.text)}</span>` : esc(r.text)
}

/** A line of the pane (ANSI) as the markup of its row on the screen. */
export const lineHtml = (line: string): string => withLinks(parseLine(line)).map(runHtml).join('')

/** The session's agent by name ("Claude"), else "Agent". */
export const agentName = (x: { agent?: string | undefined } | null | undefined, t: Translator): string =>
  x?.agent ? (x.agent === 'claude' ? 'Claude' : (x.agent[0] ?? '').toUpperCase() + x.agent.slice(1)) : t('term.agent')

/** The terminal a window opens on: the one asked for (or used last) when the session has it. */
export const targetFor = (want: string, x: Pick<Item, 'pane' | 'cwd'>): TermTarget =>
  want === 'agent' && x.pane ? 'agent' : x.cwd ? 'shell' : 'agent'

/** How many of the keys waiting go in one request: so many steps, so much text. */
export function batchSize(pending: readonly TermStep[]): number {
  let n = 0
  for (let size = 0; n < pending.length && n < MAX_STEPS; n++) {
    size += pending[n]?.text?.length ?? 0
    if (size > MAX_TEXT && n) break
  }
  return n
}

/** A paste waiting for its yes: the text, how many lines, and the first lines as shown. */
export interface PendingPaste {
  text: string
  n: number
  shown: string
}

/**
 * What a paste does: nothing (empty), too big, one line typed at once, or several lines that ask
 * first, as every line runs. A last line break is left off.
 */
export function pasteOf(
  raw: string,
): { kind: 'none' } | { kind: 'big' } | { kind: 'type'; text: string } | ({ kind: 'ask' } & PendingPaste) {
  const text = String(raw).replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (!text) return { kind: 'none' }
  if (text.length > MAX_PASTE) return { kind: 'big' }
  const lines = text.split('\n')
  const n = lines.length
  if (n === 1) return { kind: 'type', text }
  // What would run: the first lines, each as far as it fits.
  const shown =
    lines
      .slice(0, 3)
      .map(l => (l.length > 120 ? `${l.slice(0, 120)}…` : l))
      .join('\n') + (n > 3 ? '\n…' : '')
  return { kind: 'ask', text, n, shown }
}

/** What the window's state reads to say what it says. */
export interface TermState {
  status: TermStatus
  error: string
  /** Gone because the session is off the board for now. */
  missing: boolean
  target: TermTarget
  /** Lines are on the screen (the panel dims them rather than replace them). */
  hasLines: boolean
}

/** What the screen says when there is nothing (yet) to show: starting, gone, asleep, an error. */
export type StatePanel =
  | { kind: 'connecting' }
  | { kind: 'starting'; path: string }
  | { kind: 'none'; path: string }
  | { kind: 'missing' }
  | { kind: 'gone' }
  | { kind: 'goneAgent' }
  | { kind: 'asleep'; name: string }
  | { kind: 'error'; text: string }

export function statePanel(
  s: TermState,
  x: Pick<Item, 'cwd' | 'name'> | null | undefined,
  t: Translator,
): StatePanel | null {
  const path = x?.cwd ?? ''
  if (s.status === 'connecting' && !s.hasLines) return { kind: 'connecting' }
  if (s.status === 'starting') return { kind: 'starting', path }
  if (s.status === 'none') return { kind: 'none', path }
  if (s.status === 'gone' && s.missing) return { kind: 'missing' }
  if (s.status === 'gone') return s.target === 'shell' ? { kind: 'gone' } : { kind: 'goneAgent' }
  if (s.status === 'asleep') return { kind: 'asleep', name: x?.name ?? '' }
  if (s.status === 'error') return { kind: 'error', text: s.error || t('err.unavailable') }
  return null
}

/** What the footer reads. */
export interface FootState {
  status: TermStatus
  error: string
  typing: boolean
  waitingSend: boolean
  slowNote: boolean
  target: TermTarget
  canMutate: boolean
  /** The pointer is a finger. */
  coarse: boolean
}

/** The footer's line: what the keys do now, or why they wait; `dot` when the screen is live. */
export function footStatus(s: FootState, x: Pick<Item, 'agent'> | null | undefined, t: Translator) {
  const live = s.status === 'live'
  const typingText = () =>
    [
      s.target === 'shell' ? t('term.typing') : t('term.typingAgent', { agent: agentName(x, t) }),
      !s.coarse && t('term.leaveKey'),
    ]
      .filter(Boolean)
      .join(' · ')
  const text = !live
    ? ''
    : s.error
      ? s.error
      : s.waitingSend
        ? t('term.waiting')
        : s.slowNote
          ? t('term.slow')
          : !s.canMutate
            ? t('mobile.readOnly')
            : s.typing
              ? typingText()
              : t(s.coarse ? 'term.tapToType' : 'term.clickToType')
  return {
    text,
    dot: live && !s.error,
    warn: !!s.error || (live && (!s.canMutate || s.waitingSend || s.slowNote)),
  }
}

/** The sheet's Terminal button: hidden where the board offers none, a dot while the board has a shell open. */
export function termButton(
  it: Pick<Item, 'key' | 'cwd' | 'pane'>,
  data: { terminal?: boolean | undefined; shells?: readonly string[] | undefined } | null | undefined,
  t: Translator,
): { hidden: boolean; hasShell: boolean; title: string } {
  const hasShell = (data?.shells ?? []).includes(it.key)
  return {
    hidden: data?.terminal === false || !(it.cwd || it.pane),
    hasShell,
    title: t(hasShell ? 'term.shellOpen' : 'term.hint'),
  }
}
