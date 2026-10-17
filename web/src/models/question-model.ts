// What the user picks in a question form on the board before it goes to the terminal, and the
// small rules around it. No DOM; components/questions/QuestionForm.tsx draws the form. A question
// is the shape src/core/dialogs/questions.ts gives the page: { question, header, multiSelect,
// preview, options: [{ label, description, preview? }] }.
import type { FormQuestion } from '../../../src/core/dialogs/question-form.ts'

/** What these rules read of a question (a FormQuestion has it all). */
export interface QuestionShape {
  multiSelect: boolean
  preview: boolean
  options: readonly { label: string; preview?: string | undefined }[]
}

/** What is picked for one question. `other` is the own answer's text, `otherOn` whether it is the choice. */
export interface QuestionPick {
  options: string[]
  other: string
  otherOn: boolean
}

/** What a digit means on a question: an option number, or the own answer's row after them. */
export type DigitTarget = number | 'other'

/** What pendingQuestions reads of a session. */
export interface Asking<Q> {
  status?: string | undefined
  tool?: { name: string; pending?: boolean | undefined; questions?: Q[] | null | undefined } | null | undefined
}

/** The questions a session waits on in its terminal, or null. */
export function pendingQuestions<Q = FormQuestion>(it: Asking<Q> | null | undefined): Q[] | null {
  const tool = it?.tool
  return it?.status === 'blocked' &&
    tool?.name === 'AskUserQuestion' &&
    tool.pending &&
    Array.isArray(tool.questions) &&
    tool.questions.length
    ? tool.questions
    : null
}

/** One form per question call: a new call starts a new form. */
export const formKey = (it: { key: string; tool?: { id: string } | null | undefined }): string =>
  `${it.key}|${it.tool?.id ?? ''}`

/** Nothing picked yet. */
export const emptyPicks = (questions: readonly unknown[]): QuestionPick[] =>
  questions.map(() => ({ options: [], other: '', otherOn: false }))

const update = (picks: QuestionPick[], i: number, next: Partial<QuestionPick>): QuestionPick[] =>
  picks.map((p, j) => (j === i ? { ...p, ...next } : p))

/** Option `n` (from 1) of question `i` picked: the only one for a single select, toggled for multiSelect. */
export function choose(
  picks: QuestionPick[],
  questions: readonly QuestionShape[],
  i: number,
  n: number,
): QuestionPick[] {
  const q = questions[i]
  const label = q?.options[n - 1]?.label
  if (!q || label === undefined) return picks
  if (!q.multiSelect) return update(picks, i, { options: [label], otherOn: false })
  const on = new Set(picks[i]?.options)
  if (on.has(label)) on.delete(label)
  else on.add(label)
  // In the order of the options, as the terminal lists them.
  return update(picks, i, { options: q.options.map(o => o.label).filter(l => on.has(l)) })
}

/** The own answer picked (single select) or toggled (multiSelect). */
export function chooseOther(picks: QuestionPick[], questions: readonly QuestionShape[], i: number): QuestionPick[] {
  const q = questions[i]
  if (!q || q.preview) return picks
  return q.multiSelect
    ? update(picks, i, { otherOn: !picks[i]?.otherOn })
    : update(picks, i, { options: [], otherOn: true })
}

/** Text typed into the own answer: like the terminal, typing picks it and an empty field drops it. */
export function typeOther(
  picks: QuestionPick[],
  questions: readonly QuestionShape[],
  i: number,
  text: string,
): QuestionPick[] {
  const q = questions[i]
  if (!q || q.preview) return picks
  const has = !!String(text).trim()
  if (q.multiSelect) return update(picks, i, { other: text, otherOn: has })
  const pick = picks[i]
  return update(
    picks,
    i,
    has
      ? { other: text, options: [], otherOn: true }
      : { other: text, otherOn: !!pick?.otherOn && !pick.options.length },
  )
}

/** The question has an answer the terminal will take. */
export function answered(question: Pick<QuestionShape, 'multiSelect'>, pick: QuestionPick | undefined): boolean {
  if (!pick) return false
  const own = pick.otherOn && !!pick.other.trim()
  return question.multiSelect ? pick.options.length > 0 || own : pick.options.length === 1 ? !pick.otherOn : own
}

/** How many questions still need an answer. */
export const remaining = (questions: readonly QuestionShape[], picks: readonly QuestionPick[]): number =>
  questions.filter((q, i) => !answered(q, picks[i])).length

/** The body for POST .../answer: labels picked and the own answer, per question. */
export function payload(
  questions: readonly unknown[],
  picks: readonly QuestionPick[],
): { options: string[]; other: string }[] {
  return questions.map((_q, i) => {
    const pick = picks[i]
    return { options: pick?.options ?? [], other: pick?.otherOn ? pick.other.trim() : '' }
  })
}

/** A lone single-select question is answered by one click or key, as a digit does in the terminal. */
export const instant = (questions: readonly Pick<QuestionShape, 'multiSelect'>[]): boolean =>
  questions.length === 1 && !questions[0]?.multiSelect

/** What digit `d` means on a question: an option number, 'other' for the row after them, or null. */
export function digitTarget(question: QuestionShape | undefined, d: number): DigitTarget | null {
  if (!question || !Number.isInteger(d) || d < 1) return null
  if (d <= question.options.length) return d
  return d === question.options.length + 1 && !question.preview ? 'other' : null
}

/** The question the keys go to: the one with the focus, else the first without an answer. */
export function currentQuestion(
  questions: readonly QuestionShape[],
  picks: readonly QuestionPick[],
  focused: number | null,
): number {
  if (focused !== null && Number.isInteger(focused) && questions[focused]) return focused
  const open = questions.findIndex((q, i) => !answered(q, picks[i]))
  return open < 0 ? questions.length - 1 : open
}

/** A permission option by its words: allow, allow for good (or switch modes), or refuse. */
export function permissionTone(label: unknown): 'yes' | 'always' | 'no' | 'other' {
  const l = String(label).trim().toLowerCase()
  if (/^no\b/.test(l)) return 'no'
  if (/^yes\b/.test(l)) return l === 'yes' ? 'yes' : 'always'
  return 'other'
}
