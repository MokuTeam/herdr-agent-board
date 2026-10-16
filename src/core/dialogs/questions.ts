// Claude Code's dialogs in a terminal, read from a pane's screen (`herdr agent read --source
// visible`), and the keys that answer them. Pure functions; answer.mjs reads and types.
//
// The question dialog (AskUserQuestion), as Claude Code 2.1 draws and drives it:
// - One question: a header line (" ☐ Color"), the question, numbered options with their
//   descriptions indented under them, then "N+1. Type something." for an own answer. The cursor
//   (❯) starts on option 1.
// - Several questions, or one multiSelect question: a tab bar
//   ("←  ☒ Size  ☐ Toppings  ✔ Submit  →", ☒ answered), one question at a time, and at the end a
//   "Review your answers" screen that lists every answer above "1. Submit answers" and
//   "2. Cancel". Left and right arrows move between the tabs.
// - Single select: a digit picks that option and moves on at once (a lone question is submitted).
//   On the own-answer row a digit does the same with the text it holds, so that row is reached
//   with the arrow keys instead: there it takes text (the footer offers "ctrl+g to edit"), up
//   leaves it, ctrl+u clears it, Enter takes it.
// - Options with a preview (a mockup beside the list, no own-answer row): a digit only moves the
//   cursor; Enter picks.
// - multiSelect: options show "[ ]" or "[✔]" and a digit toggles one without moving the cursor.
//   Text typed on the own-answer row ticks it. A "Next" row ("Submit" for a lone question) under
//   the options goes on with Enter.
// A permission prompt: a title ("Bash command", "Create file"), what the tool will do between
// dashed rules, "Do you want to ...?" and numbered options; a digit picks one at once.

import { createHash } from 'node:crypto'
import { stripAnsi } from './input-box.ts'
import { type FormQuestion, LIMITS, questionsOf } from './question-form.ts'

export { LIMITS, questionsOf }

/** A row of a dialog. text has the wrapped lines under the first; checked is null outside multiSelect. */
export interface DialogOption {
  n: number
  label: string
  text: string
  checked: boolean | null
  cursor: boolean
  /** The row's text starts with a space of its own (one typed before a leading dash). */
  spaced?: boolean
  /** The option as drawn (its lines, without the cursor), for the fingerprint. */
  raw?: string[]
}
export interface Tab {
  header: string
  answered: boolean
}
export interface QuestionDialog {
  kind: 'question'
  tabs: Tab[]
  question: string
  options: DialogOption[]
  next: { label: string; cursor: boolean } | null
  cursor: number | 'next' | null
  editing: boolean
  preview: boolean
}
export interface ReviewDialog {
  kind: 'review'
  tabs: Tab[]
  answers: { question: string; answer: string }[]
  options: DialogOption[]
  cursor: number | null
}
export interface PermissionDialog {
  kind: 'permission'
  title: string
  body: string[]
  prompt: string
  options: DialogOption[]
  cursor: number | null
  fingerprint: string
}
export type Dialog = QuestionDialog | ReviewDialog | PermissionDialog

/** What a user picked for one question: option numbers (from 1) and an own answer. */
export interface AnswerPick {
  choose: number[]
  other: string
}

/** What the page gets of a dialog. */
export type PublicDialog =
  | {
      kind: 'permission'
      title: string
      body: string[]
      more: number
      prompt: string
      options: { n: number; label: string }[]
      fingerprint: string
    }
  | { kind: 'review' }
  | { kind: 'question'; question: string }

const RULE = /^\s*─{8,}\s*$/
const DASHED = /^\s*╌{8,}\s*$/
const TABS = /^\s*(?:←\s+)?[☐☒]\s/
// An option row: "❯ " or two spaces, the number, a checkbox for multiSelect, the text.
const OPTION = /^(❯| ) (\d+)\. (?:\[( |✔)\] )?(.*)$/
const NEXT = /^(❯| )\s{3,}(Next|Submit)\s*$/
const BOX = /\s{2,}[┌│└].*$/
const PLACEHOLDER = /^Type something\.?$/
export const OTHER_LIMIT = 1000

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
/** Text as it reads on a screen: no markdown marks, one space between words. */
export const norm = (s: unknown): string =>
  String(s ?? '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Text to compare with what the screen shows, without any whitespace. The terminal wraps long
 * lines at a space or, for a long path, in the middle of it, and nothing on the screen tells the
 * two apart (a line broken at a space can fill the whole width too). Read without spaces, a
 * wrapped label is the label either way.
 */
const flat = (s: unknown): string => norm(s).replace(/\s+/g, '')
/** The text of a row and the line wrapped under it, as one, for reading and for flat(). */
const wrapJoin = (text: string, line: string): string => norm(`${text} ${line}`)

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const UNSAFE_CHARS = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]+/g

/**
 * An own answer as the terminal's one-line field takes it: no control characters (C0, C1), no
 * bidirectional overrides that make it read otherwise than it is, one space between words.
 */
export const cleanOther = (text: unknown): string =>
  clip(
    String(text ?? '')
      .replace(UNSAFE_CHARS, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    OTHER_LIMIT,
  )

/**
 * The answers the user picked, checked against the questions: per question { choose: [option
 * numbers, from 1], other: '' }. `answers` is one { options: [labels], other } per question.
 * Returns { picks } or { error } (a dictionary key).
 */
export function resolveAnswers(
  questions: FormQuestion[],
  answers: unknown,
): { picks: AnswerPick[] } | { error: string } {
  if (!Array.isArray(questions) || !Array.isArray(answers) || answers.length !== questions.length)
    return { error: 'err.qa.invalid' }
  const picks: AnswerPick[] = []
  for (const [i, q] of questions.entries()) {
    const a: { options?: unknown; other?: unknown } = answers[i] ?? {}
    const labels: string[] = Array.isArray(a.options) ? a.options.map(String) : []
    const choose: number[] = []
    for (const label of labels) {
      const n = q.options.findIndex(o => o.label === label) + 1
      if (!n || choose.includes(n)) return { error: 'err.qa.invalid' }
      choose.push(n)
    }
    choose.sort((x, y) => x - y)
    const other = cleanOther(a.other)
    if (other && q.preview) return { error: 'err.qa.invalid' } // no own-answer row beside previews
    if (q.multiSelect ? !choose.length && !other : choose.length + (other ? 1 : 0) !== 1)
      return { error: 'err.qa.invalid' }
    picks.push({ choose, other })
  }
  return { picks }
}

/** The answer as the terminal's review screen and the transcript write it. */
export function answerText(question: FormQuestion, pick: AnswerPick): string {
  return [...pick.choose.map(n => question.options[n - 1]?.label ?? ''), ...(pick.other ? [pick.other] : [])].join(', ')
}

/**
 * What the screen shows, or null when it shows no dialog the board knows:
 *   { kind: 'question', tabs, question, options, next, cursor, editing, preview }
 *   { kind: 'review', tabs, answers: [{ question, answer }], options, cursor }
 *   { kind: 'permission', title, body, prompt, options, cursor, fingerprint }
 * options: [{ n, label, text, checked, cursor }]; text has the wrapped lines under the first;
 * checked is null outside multiSelect. cursor: the option number, 'next', or null.
 */
export function parseDialog(screen: unknown): Dialog | null {
  const lines = stripAnsi(String(screen ?? ''))
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trimEnd())
  return questionDialog(lines) ?? permissionDialog(lines)
}

function questionDialog(lines: string[]): QuestionDialog | ReviewDialog | null {
  let bar = -1
  for (let i = lines.length - 1; i > 0; i--) {
    if (TABS.test(lines[i] ?? '') && RULE.test(lines[i - 1] ?? '')) {
      bar = i
      break
    }
  }
  if (bar < 0) return null
  const tabs: Tab[] = [...(lines[bar] ?? '').matchAll(/([☐☒])\s(.+?)(?=\s{2,}|\s*[✔→]|$)/g)].map(m => ({
    header: (m[2] ?? '').trim(),
    answered: m[1] === '☒',
  }))
  let i = bar + 1
  while (i < lines.length && !(lines[i] ?? '').trim()) i++
  if (lines[i]?.trim() === 'Review your answers') return review(lines, i + 1, tabs)
  const text: string[] = []
  for (; i < lines.length && (lines[i] ?? '').trim() && !OPTION.test(lines[i] ?? ''); i++) text.push(lines[i] ?? '')
  if (!text.length) return null
  const block = optionBlock(lines, i)
  if (!block.options.length) return null
  const footer = lines.slice(block.end).find(l => /Esc to cancel/.test(l)) ?? ''
  return {
    kind: 'question',
    tabs,
    question: norm(text.join(' ')),
    options: block.options,
    next: block.next,
    cursor: block.next?.cursor ? 'next' : (block.options.find(o => o.cursor)?.n ?? null),
    editing: /ctrl\+g to edit/.test(footer),
    preview: block.preview,
  }
}

/** Numbered rows from `start`, each with the lines indented under it, until a rule or the footer. */
function optionBlock(
  lines: string[],
  start: number,
): { options: DialogOption[]; next: { label: string; cursor: boolean } | null; preview: boolean; end: number } {
  const options: DialogOption[] = []
  let next: { label: string; cursor: boolean } | null = null
  let preview = false
  let i = start
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (RULE.test(line) || /Esc to cancel/.test(line) || /^\s*Ready to submit/.test(line)) break
    const m = OPTION.exec(line)
    if (m && Number(m[2]) === options.length + 1) {
      const rest = m[4] ?? ''
      if (BOX.test(rest)) preview = true
      const label = rest.replace(BOX, '').trim()
      // spaced: the row's text starts with a space of its own (one typed before a leading dash).
      options.push({
        n: Number(m[2]),
        label,
        text: norm(label),
        spaced: /^\s/.test(rest),
        checked: m[3] === undefined ? null : m[3] === '✔',
        cursor: m[1] === '❯',
      })
      continue
    }
    const nx = NEXT.exec(line)
    if (nx && options.length) {
      next = { label: nx[2] ?? '', cursor: nx[1] === '❯' }
      continue
    }
    // Under an option: its description or the rest of a long label. Beside previews: the mockup.
    const last = options.at(-1)
    if (last && line.trim() && !preview && !next && /^\s{3,}/.test(line)) {
      last.text = wrapJoin(last.text, line)
    }
  }
  return { options, next, preview, end: i }
}

function review(lines: string[], start: number, tabs: Tab[]): ReviewDialog | null {
  const answers: { question: string; answer: string | null }[] = []
  let i = start
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^\s*Ready to submit/.test(line) || OPTION.test(line)) break
    const q = /^\s*●\s+(.*)$/.exec(line)
    const a = /^\s*→\s+(.*)$/.exec(line)
    const last = answers.at(-1)
    if (q) answers.push({ question: (q[1] ?? '').trim(), answer: null })
    else if (a && last) last.answer = (a[1] ?? '').trim()
    else if (line.trim() && last) {
      if (last.answer === null) last.question = wrapJoin(last.question, line)
      else last.answer = wrapJoin(last.answer, line)
    }
  }
  while (i < lines.length && !OPTION.test(lines[i] ?? '')) i++
  const { options } = optionBlock(lines, i)
  if (!options.length) return null
  return {
    kind: 'review',
    tabs,
    answers: answers.map(a => ({ question: norm(a.question), answer: norm(a.answer ?? '') })),
    options,
    cursor: options.find(o => o.cursor)?.n ?? null,
  }
}

const PERM_OPTION = /^\s{0,3}(?:(❯)\s+)?(\d+)\.\s+(.*)$/

function permissionDialog(lines: string[]): PermissionDialog | null {
  let foot = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*Esc to cancel/.test(lines[i] ?? '')) {
      foot = i
      break
    }
  }
  if (foot < 0) return null
  // The options are the numbered rows right above the footer; the prompt is the line above them.
  let first = -1
  for (let i = foot - 1; i >= 0 && foot - i < 40; i--) {
    const m = PERM_OPTION.exec(lines[i] ?? '')
    if (m && m[2] === '1') {
      first = i
      break
    }
  }
  if (first < 1) return null
  // raw: the option as drawn (its lines, without the cursor), for the fingerprint. text: for
  // reading, its lines as the terminal broke them: a path broken in the middle shows as it is
  // rather than with a space that is not in it.
  const options: DialogOption[] = []
  for (let i = first; i < foot; i++) {
    const line = lines[i] ?? ''
    const m = PERM_OPTION.exec(line)
    const o = options.at(-1)
    if (m && Number(m[2]) === options.length + 1) {
      const text = m[3] ?? ''
      options.push({
        n: options.length + 1,
        label: text.trim(),
        text: text.trim(),
        raw: [text],
        checked: null,
        cursor: !!m[1],
      })
    } else if (o && line.trim()) {
      o.raw?.push(line)
      o.text += `\n${line.trim()}`
    }
  }
  let p = first - 1
  while (p > 0 && !(lines[p] ?? '').trim()) p--
  const prompt = (lines[p] ?? '').trim()
  if (options.length < 2 || !prompt.endsWith('?') || !options.some(o => o.cursor)) return null
  let top = p - 1
  while (top > 0 && !RULE.test(lines[top] ?? '') && p - top < 120) top--
  const rest = lines.slice(RULE.test(lines[top] ?? '') ? top + 1 : top, p).filter(l => !DASHED.test(l))
  while (rest.length && !(rest[0] ?? '').trim()) rest.shift()
  const title = (rest.shift() ?? '').trim()
  const body = rest.filter(l => !/^\s*Tip:/.test(l))
  while (body.length && !(body.at(-1) ?? '').trim()) body.pop()
  // The dialog's own one-space margin off, the tool's indentation kept.
  const shown = body.every(l => !l.trim() || l.startsWith(' ')) ? body.map(l => l.slice(1)) : body
  // Everything as drawn, every character and space: `rm -rf build_*` and `rm -rf build` must
  // not pass for the same prompt. Only where the cursor stands is left out.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([title, shown, prompt, options.map(o => o.raw)]))
    .digest('hex')
    .slice(0, 24)
  return {
    kind: 'permission',
    title,
    body: shown,
    prompt,
    options,
    cursor: options.find(o => o.cursor)?.n ?? null,
    fingerprint,
  }
}

const BODY_LINES = 80
const LINE = 600

/**
 * The dialog for the page: what it needs to show it and answer it. A permission prompt's text
 * comes as drawn; what does not fit is cut with a mark ("…", `more` lines) and never silently,
 * and the fingerprint is always of the whole.
 */
export function publicDialog(d: Dialog | null | undefined): PublicDialog | null {
  if (!d) return null
  if (d.kind === 'permission') {
    return {
      kind: d.kind,
      title: clip(d.title, LINE),
      body: d.body.slice(0, BODY_LINES).map(l => clip(l, LINE)),
      more: Math.max(0, d.body.length - BODY_LINES),
      prompt: clip(d.prompt, LINE),
      options: d.options.map(o => ({ n: o.n, label: clip(o.text, LINE) })),
      fingerprint: d.fingerprint,
    }
  }
  if (d.kind === 'review') return { kind: d.kind }
  return { kind: d.kind, question: clip(d.question, LIMITS.question) }
}

/** The screen shows question `q` of the dialog: its text and its options in order. */
export function onQuestion(d: Dialog | null | undefined, q: FormQuestion): boolean {
  if (d?.kind !== 'question' || flat(d.question) !== flat(q.question)) return false
  if (d.options.length !== q.options.length + (q.preview ? 0 : 1)) return false
  return q.options.every((o, j) => flat(d.options[j]?.text).startsWith(flat(o.label)))
}

/** Which of `questions` the screen shows: its index, questions.length for the review, -1 for neither. */
export function screenIndex(d: Dialog | null | undefined, questions: FormQuestion[]): number {
  if (d?.kind === 'review') return questions.length
  return questions.findIndex(q => onQuestion(d, q))
}

/** The own answer the screen's last row holds ('' for the placeholder). */
export function typedOther(d: Dialog | null | undefined): string {
  const row = d?.options.at(-1)
  if (!row) return ''
  return PLACEHOLDER.test(row.text) ? '' : row.text
}

/** Text on the screen is the text wanted (read flat). A long own answer may be cut short with an ellipsis; the start must agree. */
export function sameText(shown: unknown, wanted: unknown): boolean {
  const a = flat(shown)
  const b = flat(wanted)
  if (a === b) return true
  const cut = a.replace(/…$/, '')
  return a.endsWith('…') && cut.length >= 20 && b.startsWith(cut)
}

/** The review screen lists exactly these answers. */
export function reviewMatches(d: Dialog | null | undefined, questions: FormQuestion[], picks: AnswerPick[]): boolean {
  if (d?.kind !== 'review' || d.answers.length !== questions.length) return false
  return questions.every((q, i) => {
    const shown = d.answers[i]
    const pick = picks[i]
    return !!shown && !!pick && flat(shown.question) === flat(q.question) && sameText(shown.answer, answerText(q, pick))
  })
}

/** The arrow keys from one row to another (the "Next" row counts as the one after the last option). */
export function arrows(from: number, to: number): ('up' | 'down')[] {
  const n = to - from
  return Array(Math.abs(n)).fill(n > 0 ? 'down' : 'up')
}

/** Row number of the cursor, with "Next" after the options. */
export const cursorRow = (d: Pick<QuestionDialog, 'cursor' | 'options'>): number | null =>
  d.cursor === 'next' ? d.options.length + 1 : d.cursor
