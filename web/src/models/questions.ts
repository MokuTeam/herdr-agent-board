// Questions a session asks in its terminal, answered from the board: the rules of what the sheet
// shows — which form or permission prompt, a form's state, its send button, its hint and its
// preview — without the DOM. The page's desk (models/question-desk.ts) and the old page's
// questions.js read them from here.
import type { FormQuestion } from '../../../src/core/dialogs/question-form.ts'
import type { PublicDialog } from '../../../src/core/dialogs/questions.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import {
  type DigitTarget,
  formKey,
  instant,
  pendingQuestions,
  type QuestionPick,
  type QuestionShape,
  remaining,
} from './question-model.ts'

export type PermissionDialog = Extract<PublicDialog, { kind: 'permission' }>

/** What the sheet shows: a question form or a permission prompt, by its form key. */
export type Shown =
  | { kind: 'question'; key: string; it: Item; questions: FormQuestion[] }
  | { kind: 'permission'; key: string; it: Item; dialog: PermissionDialog }

/** The last answer that went through, until herdr sees the session move on. */
export interface Answered {
  shown: Shown
  at: number
}

/** What the sheet's detail says of the dialog on the session's screen. */
export interface DialogDetail {
  item?: { key: string } | undefined
  dialog?: PublicDialog | null | undefined
}

/** A finished form gives way after this long even when herdr still says the session is held. */
export const ANSWERED_MS = 10_000

/**
 * What the sheet should show for this session: its question form, the form just answered (the
 * transcript knows at once, herdr's status follows a refresh later; a new permission prompt on the
 * screen takes over), a permission prompt, or null. `expired`: the answered form is over (the
 * session moved on, or is still held long after), so the same prompt asked again is a new one.
 */
export function dialogFor(
  it: Item,
  detail: DialogDetail | null | undefined,
  answered: Answered | null,
  now: number,
): { shown: Shown | null; expired: boolean } {
  const questions = pendingQuestions(it)
  if (questions) return { shown: { kind: 'question', key: formKey(it), it, questions }, expired: false }
  const dialog = detail?.item?.key === it.key ? (detail.dialog ?? null) : null
  let expired = false
  if (answered?.shown.it.key === it.key) {
    const was = answered.shown.kind === 'permission' ? answered.shown.dialog.fingerprint : undefined
    if (it.status !== 'blocked' || now - answered.at > ANSWERED_MS) expired = true
    else if (!(dialog?.kind === 'permission' && dialog.fingerprint !== was))
      return { shown: { ...answered.shown, it }, expired: false }
  }
  if (it.status === 'blocked' && dialog?.kind === 'permission')
    return { shown: { kind: 'permission', key: `${it.key}|${dialog.fingerprint}`, it, dialog }, expired }
  return { shown: null, expired }
}

// ---------------------------------------------------------------- one form's state

export type FormStatus = 'idle' | 'sending' | 'sent' | 'error'

export interface FormState {
  picks: QuestionPick[]
  status: FormStatus
  error: string
  /** Keys went in before it stopped: the dialog may be partly filled in. */
  stopped: boolean
  /** The terminal's screen when it failed. */
  screen: string
  /** The permission option on its way. */
  chosen: number | null
}

/** The form takes no picks: read only, or its answer is on its way or through. */
export const formLocked = (f: Pick<FormState, 'status'>, canMutate: boolean): boolean =>
  !canMutate || f.status === 'sending' || f.status === 'sent'

/** The form is busy: its answer is on its way or through. */
export const formBusy = (f: Pick<FormState, 'status'>): boolean => f.status === 'sending' || f.status === 'sent'

/** Whether option `n` (or the own answer) of a question is picked. */
export function optionOn(question: QuestionShape | undefined, pick: QuestionPick | undefined, n: DigitTarget): boolean {
  if (!pick) return false
  if (n === 'other') return pick.otherOn
  const label = question?.options[n - 1]?.label
  return label !== undefined && pick.options.includes(label)
}

export interface SendButton {
  label: string
  disabled: boolean
  title: string
  /** One question picked with a click needs no button, unless it is an own answer. */
  hidden: boolean
}

export function sendButton(
  questions: readonly QuestionShape[],
  f: Pick<FormState, 'picks' | 'status'>,
  canMutate: boolean,
  t: Translator,
): SendButton {
  const left = remaining(questions, f.picks)
  return {
    label: f.status === 'error' ? t('qa.retry') : t('qa.send', { n: questions.length }),
    disabled: formLocked(f, canMutate) || left > 0,
    title: !canMutate ? t('mobile.readOnly') : left ? t('qa.left', { n: left }) : '',
    hidden: instant(questions) && !f.picks[0]?.otherOn && f.status !== 'error',
  }
}

/** Under the form: read only, how many are left, or the keys (only where there is a keyboard to press them on). */
export function formHint(
  questions: readonly QuestionShape[],
  picks: readonly QuestionPick[],
  canMutate: boolean,
  pointerFine: boolean,
  t: Translator,
): string {
  const left = remaining(questions, picks)
  const most = Math.max(...questions.map(q => q.options.length + (q.preview ? 0 : 1)))
  const keys = pointerFine ? t('qa.keys', { n: Math.min(9, most) }) : ''
  return !canMutate ? t('mobile.readOnly') : left && questions.length > 1 ? t('qa.left', { n: left }) : keys
}

/** An option under the pointer or the focus: { q, n }. */
export interface Peek {
  q: number
  n: number
}

/**
 * The preview under question `i`: the option under the pointer or the focus, as the terminal
 * shows the one under its cursor; else the one picked, else the first. '' hides it.
 */
export function previewText(
  question: QuestionShape,
  pick: QuestionPick | undefined,
  i: number,
  peek: Peek | null,
): string {
  const label = pick?.options[0]
  const o =
    (peek?.q === i ? question.options[peek.n - 1] : null) ??
    question.options.find(x => x.label === label) ??
    question.options[0]
  return o?.preview ?? ''
}
