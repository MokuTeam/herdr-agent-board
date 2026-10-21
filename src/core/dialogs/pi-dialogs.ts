// pi's dialogs in a terminal (https://pi.dev, 1.3), read from a pane's screen (`herdr agent read
// --source visible`): what an extension asks with ctx.ui.select or ctx.ui.confirm (a menu) and
// ctx.ui.input (one line of text). Pure functions; services/answer.ts reads and types. Read only
// for panes herdr says run pi (questions.ts parseDialog).
//
// The menu (pi's ExtensionSelectorComponent), between two rules the width of the pane:
//
//   ──────────────────────
//
//    Git approval needed: git commit        the title, one or more lines with a one-space margin,
//                                           and a description under it if the extension gave one
//    Why (from Lobster): …
//
//    → Approve                              the option the cursor is on
//      Reject
//      Reject with a note
//
//    ↑↓ navigate  enter select  escape/ctrl+c cancel
//
//   ──────────────────────
//
// No digit picks an option: up and down move the cursor, which stops at either end, and Enter
// picks. A long option wraps onto lines with only the margin. ctx.ui.confirm is the same menu with
// "Yes" and "No". A timed one counts down at the end of its title: "… (12s)".
//
// The text input (ExtensionInputComponent) is the same frame with the title, the field
// ("> <text>": one line that scrolls sideways to keep the cursor in sight) and
// "enter submit  escape/ctrl+c cancel". End goes to the end of the field, Ctrl+U clears what is
// left of the cursor.
//
// A dialog taller than the pane shows only its end: the opening rule is above the screen. It is
// still read (options, field, hint), with `cut` set and no title, since the first line on the
// screen is somewhere in the middle of the text.

import { createHash } from 'node:crypto'
import { stripAnsi } from './input-box.ts'
import type { DialogOption } from './questions.ts'

export interface SelectDialog {
  kind: 'select'
  title: string
  body: string[]
  /** The top of the text is above the screen. */
  cut: boolean
  options: DialogOption[]
  cursor: number | null
  fingerprint: string
}

export interface InputDialog {
  kind: 'input'
  title: string
  body: string[]
  cut: boolean
  /** What the field shows: the whole text, or the end of a long one. */
  value: string
  fingerprint: string
}

export type PiDialog = SelectDialog | InputDialog

const RULE = /^\s*─{8,}\s*$/
// The key names come from the user's key bindings: any, as long as the words are pi's.
const SELECT_HINT = /^\s*↑↓ navigate\s+\S+ select\s+\S+ cancel$/
const INPUT_HINT = /^\s*\S+ submit\s+\S+ cancel$/
// A row of the menu: the cursor or two spaces after the margin, then the option.
const ROW = /^ (?:(→) | {2})(\S.*)$/
// The rest of a long option, wrapped: the margin only.
const WRAPPED = /^ (\S.*)$/
const FIELD = /^> ?(.*)$/
const COUNTDOWN = /(?:^| )\(\d+s\)$/

const blank = (line: string | undefined): boolean => !(line ?? '').trim()

/**
 * The dialog at the bottom of pi's screen, or null. `lines`: the screen without escapes, each
 * line without trailing spaces. Only the last frame counts: its closing rule is the last rule on
 * the screen (pi's footer under it has none), so a menu's words higher up in the conversation do
 * not pass for one.
 */
export function parsePiDialog(lines: string[]): PiDialog | null {
  let close = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE.test(lines[i] ?? '')) {
      close = i
      break
    }
  }
  // The hint, one blank line above the closing rule.
  const hint = close - 2
  if (hint < 0 || !blank(lines[close - 1])) return null
  const line = lines[hint] ?? ''
  if (SELECT_HINT.test(line)) return select(lines, hint)
  if (INPUT_HINT.test(line)) return input(lines, hint)
  return null
}

/** The title and body above `end` (a blank line), up to the opening rule or the top of the screen. */
function text(lines: string[], end: number): { title: string; body: string[]; cut: boolean; drawn: string[] } {
  let top = end - 1
  while (top >= 0 && !RULE.test(lines[top] ?? '')) top--
  const cut = top < 0
  // The dialog's own one-space margin off, the text's indentation kept.
  const drawn = lines.slice(top + 1, end).map(l => (l.startsWith(' ') ? l.slice(1) : l))
  while (drawn.length && blank(drawn[0])) drawn.shift()
  while (drawn.length && blank(drawn.at(-1))) drawn.pop()
  if (cut) return { title: '', body: drawn, cut, drawn }
  const [title = '', ...body] = drawn
  return { title: title.trim(), body, cut, drawn }
}

/**
 * Everything drawn but the cursor and a countdown, every character and space: `rm -rf build_*`
 * and `rm -rf build` must not pass for the same dialog, and a dialog that counts down is the same
 * one from second to second.
 */
function fingerprintOf(kind: string, drawn: string[], options: string[][]): string {
  const still = drawn.map(l => l.replace(COUNTDOWN, ''))
  return createHash('sha256')
    .update(JSON.stringify([kind, still, options]))
    .digest('hex')
    .slice(0, 24)
}

function select(lines: string[], hint: number): SelectDialog | null {
  // One blank line between the options and the hint, one between the text and the options.
  const end = hint - 1
  if (!blank(lines[end])) return null
  let start = end - 1
  while (start >= 0 && !blank(lines[start])) start--
  if (start < 0) return null
  const options: DialogOption[] = []
  for (const line of lines.slice(start + 1, end)) {
    const row = ROW.exec(line)
    const last = options.at(-1)
    if (row) {
      const label = row[2] ?? ''
      options.push({ n: options.length + 1, label, text: label, raw: [label], checked: null, cursor: !!row[1] })
      continue
    }
    const more = WRAPPED.exec(line)
    if (!more || !last) return null
    last.raw?.push(more[1] ?? '')
    last.text += `\n${more[1] ?? ''}`
  }
  if (!options.length || options.filter(o => o.cursor).length !== 1) return null
  const { title, body, cut, drawn } = text(lines, start)
  const rows = options.map(o => o.raw ?? [])
  return {
    kind: 'select',
    title,
    body,
    cut,
    options,
    cursor: options.find(o => o.cursor)?.n ?? null,
    fingerprint: fingerprintOf('select', drawn, rows),
  }
}

function input(lines: string[], hint: number): InputDialog | null {
  // The field, between two blank lines, then the text.
  if (!blank(lines[hint - 1])) return null
  const field = FIELD.exec(lines[hint - 2] ?? '')
  if (!field || !blank(lines[hint - 3])) return null
  const { title, body, cut, drawn } = text(lines, hint - 3)
  if (!drawn.length) return null
  return {
    kind: 'input',
    title,
    body,
    cut,
    value: field[1] ?? '',
    fingerprint: fingerprintOf('input', drawn, []),
  }
}

// pi's input box at the bottom of the screen: a few lines between its two rules, and under it only
// the footer (the model, the context, an extension's status line or two).
const BOX_LINES = 20
const FOOTER_LINES = 10

/**
 * pi's own input box is at the bottom of the screen with no dialog in its place: the last two
 * rules are close together, the footer under them is short, and no dialog's hint is in either.
 * What a dialog that went away leaves; a screen read halfway through drawing is not it.
 */
export function piEditor(screen: unknown): boolean {
  const lines = stripAnsi(String(screen ?? ''))
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trimEnd())
  while (lines.length && blank(lines.at(-1))) lines.pop()
  const rules: number[] = []
  for (let i = lines.length - 1; i >= 0 && rules.length < 2; i--) if (RULE.test(lines[i] ?? '')) rules.push(i)
  const [below, above] = rules
  if (below === undefined || above === undefined) return false
  if (below - above - 1 > BOX_LINES || lines.length - below - 1 > FOOTER_LINES) return false
  return !lines.slice(above + 1).some(l => SELECT_HINT.test(l) || INPUT_HINT.test(l))
}
