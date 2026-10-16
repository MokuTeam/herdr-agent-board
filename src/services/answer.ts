// Answers a dialog that holds a session in its terminal, from the board: a question form
// (AskUserQuestion) or a permission prompt. The choice becomes key presses in the pane through
// herdr, one step at a time, and every step waits until the screen shows what that key should
// have done (core/dialogs/questions.ts says how the dialog behaves). Nothing is pressed into a pane that
// shows another session, another dialog, or a question already answered; anything unexpected
// stops it and the user is told where it stopped.

import { agentGet, herdr, herdrText } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import { inputDraft } from '../core/dialogs/input-box.ts'
import type { FormQuestion } from '../core/dialogs/question-form.ts'
import {
  type AnswerPick,
  answerText,
  arrows,
  cursorRow,
  type Dialog,
  onQuestion,
  type PermissionDialog,
  parseDialog,
  type QuestionDialog,
  resolveAnswers,
  reviewMatches,
  sameText,
  screenIndex,
  typedOther,
} from '../core/dialogs/questions.ts'
import { t } from '../core/lang.ts'
import type { Item } from '../core/types.ts'
import type { Deps } from './deps.ts'

/** Reading and typing in one pane. */
export interface PaneIO {
  read(): Promise<string>
  keys(...keys: string[]): Promise<void>
  text(text: string): Promise<void>
}

/** A PaneIO that can also tell, from the transcript, that the dialog was answered. */
export interface DriveIO extends PaneIO {
  answered?: () => boolean | Promise<boolean>
}

/** How long the waits poll: `timeout` and `every`, in ms. */
export interface Timing {
  timeout?: number
  every?: number
}

/** Where a run is, for the user: question number (from 1), what was being done, the option number. */
export interface Step {
  q?: number
  what: string
  n?: number
}

/** `step` is set unless herdr failed (reason 'herdr'), which sets `why` instead. */
export interface DriveFailure {
  ok: false
  reason: 'changed' | 'stuck' | 'review' | 'unconfirmed' | 'herdr'
  step?: Step
  why?: string
  screen: string
  sent: number
}
export type DriveResult = { ok: true } | DriveFailure

/** What the page sends: `toolUseId` and `answers` for a question form, `option` and `fingerprint` for a prompt. */
export type AnswerBody = Record<string, unknown>

const bodyOf = (body: unknown): AnswerBody => (isRecord(body) ? body : {})

/** The answer to the page: done (with what was typed for a form), or why not. */
export type AnswerResult =
  | { ok: true; answers?: { question: string; answer: string }[] }
  | { ok: false; error: string; gone?: boolean; stopped?: boolean; screen?: string }

/** checkPane's verdict: null when the pane is fine to type into. */
export type PaneCheck = Extract<AnswerResult, { ok: false }> | null

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A step that did not end as expected: why, the step, and the screen it ended on. */
class Stop extends Error {
  constructor(
    readonly reason: 'changed' | 'stuck' | 'review' | 'unconfirmed',
    readonly step: Step,
    readonly screen = '',
  ) {
    super(reason)
  }
}

/**
 * Reading and typing in one pane through herdr. `agent send-keys` takes the pane id as its
 * target (`pane send-keys` would do too). Text goes literally with `pane send-text`: `agent
 * prompt` refuses a pane that waits in a dialog. herdr 0.9 types even "-x" or "--help" as text,
 * but a leading dash gets a space before it all the same, as the board's other calls do, so a
 * herdr that reads it as an option cannot; typeOther() takes that space out of the field again.
 */
export function paneIO(pane: string): PaneIO {
  return {
    read: () => herdrText(['agent', 'read', pane, '--source', 'visible'], 5000),
    keys: async (...keys) => {
      await herdr(['agent', 'send-keys', pane, ...keys], 10_000)
    },
    text: async text => {
      await herdr(['pane', 'send-text', pane, /^-/.test(text) ? ` ${text}` : text], 10_000)
    },
  }
}

interface Seen {
  sent: number
  screen: string
}

/** The same io, counting what it sent and keeping the last screen it read: where a failure leaves the dialog. */
function counted(io: DriveIO): { seen: Seen; io: DriveIO } {
  const seen: Seen = { sent: 0, screen: '' }
  return {
    seen,
    io: {
      ...io,
      read: async () => (seen.screen = await io.read()),
      keys: (...keys) => {
        seen.sent += keys.length
        return io.keys(...keys)
      },
      text: text => {
        seen.sent++
        return io.text(text)
      },
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Reads the screen until `ok(dialog)` holds; throws Stop('stuck') after `timeout` ms. Returns the
 * dialog. Claude Code redraws within tens of milliseconds; herdr's read takes about a tenth of a second.
 */
async function until(
  io: PaneIO,
  ok: (d: Dialog | null) => boolean,
  step: Step,
  { timeout = 3000, every = 100 }: Timing = {},
): Promise<Dialog | null> {
  const end = Date.now() + timeout
  for (;;) {
    const screen = await io.read()
    const d = parseDialog(screen)
    if (ok(d)) return d
    if (Date.now() > end) throw new Stop('stuck', step, screen)
    await sleep(every)
  }
}

/**
 * Waits until the dialog is surely gone, which a blank or half-drawn screen does not prove: the
 * transcript has the answer (io.answered, when the caller can tell), or two reads in a row show
 * Claude's input box with no dialog, or a whole other dialog. `ours(dialog)`: the dialog is still
 * the one answered. Throws Stop('unconfirmed') after `timeout` ms.
 */
async function settled(
  io: DriveIO,
  ours: (d: Dialog | null) => boolean,
  step: Step,
  { timeout = 5000, every = 100 }: Timing = {},
): Promise<void> {
  const end = Date.now() + timeout
  let streak = 0
  for (;;) {
    if (io.answered && (await io.answered())) return
    const screen = await io.read()
    const d = parseDialog(screen)
    streak = !ours(d) && (d || inputDraft(screen) !== null) ? streak + 1 : 0
    if (streak >= 2) return
    if (Date.now() > end) throw new Stop('unconfirmed', step, screen)
    await sleep(every)
  }
}

type Wait = (ok: (d: Dialog | null) => boolean, step: Step) => Promise<Dialog | null>

/** A dialog a wait on `onQuestion` returned: it is one, by what the wait asked for. */
function questionOf(d: Dialog | null): QuestionDialog {
  if (d?.kind !== 'question') throw new Error('the wait returned something other than the question it asked for')
  return d
}

/**
 * Types an own answer into the field the cursor is on and waits until the field holds it. The
 * space paneIO puts before a leading dash is taken out again (start of the line, one right, one
 * back), so the answer is the text as written, which the screen then shows with nothing before it.
 */
async function typeOther(io: PaneIO, wait: Wait, q: FormQuestion, text: string, step: Step): Promise<Dialog | null> {
  const row = q.options.length + 1
  await io.text(text)
  const d = questionOf(await wait(x => onQuestion(x, q) && x.cursor === row && sameText(typedOther(x), text), step))
  if (!d.options[row - 1]?.spaced) return d
  await io.keys('ctrl+a', 'right', 'backspace')
  return wait(
    x => onQuestion(x, q) && x.cursor === row && sameText(typedOther(x), text) && !x.options[row - 1]?.spaced,
    step,
  )
}

/** A failure of herdr itself, with what was sent before it. */
const broken = (err: unknown, seen: Seen): DriveFailure => ({
  ok: false,
  reason: 'herdr',
  why: messageOf(err),
  sent: seen.sent,
  screen: seen.screen,
})

const stopped = (err: Stop, seen: Seen): DriveFailure => ({
  ok: false,
  reason: err.reason,
  step: err.step,
  screen: err.screen,
  sent: seen.sent,
})

/**
 * Drives the question dialog to these answers and submits it. `picks` from resolveAnswers.
 * Resolves { ok: true } once the dialog is surely gone, or { ok: false, reason, step, screen, sent }:
 *   changed      the screen does not show these questions (nothing was pressed in that state)
 *   stuck        a key did not do what it should have
 *   review       the review screen lists other answers than these, or no "Submit answers" (not submitted)
 *   unconfirmed  submitted, but the screen never showed the dialog gone
 *   herdr        herdr failed (why); `sent` says whether keys went in before
 */
export async function driveQuestions({
  questions,
  picks,
  io: raw,
  timing,
}: {
  questions: FormQuestion[]
  picks: AnswerPick[]
  io: DriveIO
  timing?: Timing | undefined
}): Promise<DriveResult> {
  const { io, seen } = counted(raw)
  const wait: Wait = (ok, step) => until(io, ok, step, timing)
  const leaveText = async (d: Dialog | null, i: number, step: Step): Promise<Dialog | null> => {
    // On the own-answer row keys are text: up puts the cursor back on the options.
    if (d?.kind !== 'question' || !d.editing) return d
    await io.keys('up')
    return wait(x => onQuestion(x, questions[i] as FormQuestion) && !x.editing, step)
  }
  const ours = (x: Dialog | null): boolean => screenIndex(x, questions) >= 0
  try {
    let d = parseDialog(await io.read())
    let at = screenIndex(d, questions)
    if (at < 0) throw new Stop('changed', { what: 'start' }, seen.screen)
    // Begun in the terminal: back to the first question (left moves one tab back).
    while (at > 0) {
      if (d?.kind === 'question') d = await leaveText(d, at, { what: 'back' })
      const from = at
      await io.keys('left')
      d = await wait(x => screenIndex(x, questions) === from - 1, { what: 'back' })
      at = from - 1
    }
    for (const [i, q] of questions.entries()) {
      const pick = picks[i] as AnswerPick
      d = await wait(x => onQuestion(x, q), { q: i + 1, what: 'question' })
      d = await leaveText(d, i, { q: i + 1, what: 'question' })
      // A lone single-choice question is submitted by its answer: settled() below waits for that,
      // the transcript included, rather than for the screen to move on.
      const lone = questions.length === 1 && !q.multiSelect
      const moved = (x: Dialog | null): boolean => lone || !onQuestion(x, q)
      if (!q.multiSelect) {
        if (pick.other) {
          const row = q.options.length + 1
          const step = { q: i + 1, what: 'other' }
          const keys = arrows(cursorRow(questionOf(d)) ?? 0, row)
          if (keys.length) await io.keys(...keys)
          await wait(x => onQuestion(x, q) && x.cursor === row && x.editing, step)
          await io.keys('ctrl+u')
          await wait(x => onQuestion(x, q) && x.cursor === row && typedOther(x) === '', step)
          await typeOther(io, wait, q, pick.other, step)
          await io.keys('enter')
          await wait(moved, step)
        } else if (q.preview) {
          const n = pick.choose[0] as number
          await io.keys(String(n))
          await wait(x => onQuestion(x, q) && x.cursor === n, { q: i + 1, what: 'option', n })
          await io.keys('enter')
          await wait(moved, { q: i + 1, what: 'option', n })
        } else {
          const n = pick.choose[0] as number
          await io.keys(String(n))
          await wait(moved, { q: i + 1, what: 'option', n })
        }
        continue
      }
      // multiSelect: tick what differs, one key at a time.
      for (const [j] of q.options.entries()) {
        const n = j + 1
        const want = pick.choose.includes(n)
        if (questionOf(d).options[j]?.checked === want) continue
        await io.keys(String(n))
        d = await wait(x => onQuestion(x, q) && x.options[j]?.checked === want, { q: i + 1, what: 'option', n })
      }
      const row = q.options.length + 1
      const step = { q: i + 1, what: 'other' }
      if (pick.other) {
        const keys = arrows(cursorRow(questionOf(d)) ?? 0, row)
        if (keys.length) await io.keys(...keys)
        await wait(x => onQuestion(x, q) && x.cursor === row && x.editing, step)
        await io.keys('ctrl+u')
        await wait(x => onQuestion(x, q) && typedOther(x) === '', step)
        await typeOther(io, wait, q, pick.other, step)
        d = await wait(
          x => onQuestion(x, q) && sameText(typedOther(x), pick.other) && !!x.options[row - 1]?.checked,
          step,
        )
      } else if (questionOf(d).options[row - 1]?.checked) {
        await io.keys(String(row))
        d = await wait(x => onQuestion(x, q) && !x.options[row - 1]?.checked, step)
      }
      // On to the next tab by the row under the options.
      const keys = arrows(cursorRow(questionOf(d)) ?? 0, row + 1)
      if (keys.length) await io.keys(...keys)
      await wait(x => onQuestion(x, q) && x.cursor === 'next', { q: i + 1, what: 'next' })
      await io.keys('enter')
      await wait(moved, { q: i + 1, what: 'next' })
    }
    // A lone single-choice question is submitted by its answer; the others end on the review.
    if (questions.length > 1 || questions[0]?.multiSelect) {
      d = await wait(x => x?.kind === 'review', { what: 'review' })
      if (!reviewMatches(d, questions, picks) || d?.options[0]?.text !== 'Submit answers')
        throw new Stop('review', { what: 'review' }, seen.screen)
      await io.keys('1')
    }
    await settled(io, ours, { what: 'submit' }, timing)
    return { ok: true }
  } catch (err) {
    return err instanceof Stop ? stopped(err, seen) : broken(err, seen)
  }
}

/** Picks option `n` of the permission prompt whose fingerprint the user saw. Results as driveQuestions. */
export async function drivePermission({
  fingerprint,
  n,
  io: raw,
  timing,
}: {
  fingerprint: string
  n: number
  io: DriveIO
  timing?: Timing | undefined
}): Promise<DriveResult> {
  const { io, seen } = counted(raw)
  const ours = (x: Dialog | null): x is PermissionDialog => x?.kind === 'permission' && x.fingerprint === fingerprint
  try {
    const d = parseDialog(await io.read())
    if (!ours(d) || !d.options.some(o => o.n === n))
      return { ok: false, reason: 'changed', step: { what: 'start' }, screen: seen.screen, sent: 0 }
    await io.keys(String(n))
    await settled(io, ours, { what: 'option', n }, timing)
    return { ok: true }
  } catch (err) {
    return err instanceof Stop ? stopped(err, seen) : broken(err, seen)
  }
}

/** The last lines of a screen, for the user to see where it stopped. */
const tail = (screen: unknown): string =>
  String(screen ?? '')
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split('\n')
    .slice(-24)
    .join('\n')

/**
 * The pane still holds this Claude session, waiting in a dialog. Returns an error result or null.
 * gone: the dialog is no longer there to answer.
 */
export async function checkPane(item: Item): Promise<PaneCheck> {
  if (!item?.pane) return { ok: false, error: t('err.noPane') }
  if (item.agent !== 'claude' || !item.session) return { ok: false, error: t('err.qa.notClaude', { name: item.name }) }
  if (item.sleeping) return { ok: false, gone: true, error: t('err.qa.notWaiting', { name: item.name }) }
  try {
    const agent = await agentGet(item.pane)
    if (!agent || agent.session !== item.session)
      return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
    if (agent.status !== 'blocked') return { ok: false, gone: true, error: t('err.qa.notWaiting', { name: item.name }) }
  } catch (err) {
    return { ok: false, error: t('err.qa.herdr', { why: messageOf(err) }) }
  }
  return null
}

/** Where a run stopped, in words: "question 2, option 3". */
function stepText(step: Step): string {
  const what = t(`qa.step.${step.what}`, { n: step.n ?? '' })
  return step.q ? t('qa.step.inQuestion', { q: step.q, what }) : what
}

/**
 * A run that did not go through, for the page. stopped: keys went in, so the dialog may be partly
 * filled in; the screen shows where it was left.
 */
function failure(item: Item, r: DriveFailure): AnswerResult {
  const name = item.name
  if (r.reason === 'herdr') {
    const why = r.why ?? ''
    return r.sent
      ? { ok: false, error: t('err.qa.herdrMidway', { name, why }), stopped: true, screen: tail(r.screen) }
      : { ok: false, error: t('err.qa.herdr', { why }) }
  }
  const error =
    r.reason === 'changed'
      ? t('err.qa.changed', { name })
      : r.reason === 'review'
        ? t('err.qa.review', { name })
        : r.reason === 'unconfirmed'
          ? t('err.qa.unconfirmed', { name })
          : t('err.qa.stuck', { name, step: stepText(r.step ?? { what: 'start' }) })
  return { ok: false, error, stopped: r.sent > 0, screen: tail(r.screen) }
}

/**
 * Answer the question form the session waits in. `body`: { toolUseId, answers } where answers
 * holds one { options: [labels], other } per question. The questions come from the transcript,
 * not from the page: the page only says which labels it picked.
 */
export async function answerQuestions(
  deps: Pick<Deps, 'claude'>,
  item: Item,
  rawBody: unknown,
  io: PaneIO = paneIO(item?.pane ?? ''),
): Promise<AnswerResult> {
  const body = bodyOf(rawBody)
  const bad = await checkPane(item)
  if (bad) return bad
  const tool = deps.claude.transcriptInfo(item.transcript ?? null)?.tool
  if (tool?.name !== 'AskUserQuestion' || !tool.pending || tool.id !== body.toolUseId)
    return { ok: false, gone: true, error: t('err.qa.answered', { name: item.name }) }
  const questions = tool.questions
  if (!questions) return { ok: false, error: t('err.qa.unknown', { name: item.name }) }
  const resolved = resolveAnswers(questions, body.answers)
  if ('error' in resolved) return { ok: false, error: t(resolved.error) }
  const { picks } = resolved
  // The transcript holds the answer once Claude Code took it: proof the form is done.
  const answered = (): boolean => {
    const now = deps.claude.transcriptInfo(item.transcript ?? null)?.tool
    return !!now && (now.id !== tool.id || !now.pending)
  }
  const r = await driveQuestions({ questions, picks, io: { ...io, answered } })
  if (!r.ok) return failure(item, r)
  return {
    ok: true,
    answers: questions.map((q, i) => ({ question: q.question, answer: answerText(q, picks[i] as AnswerPick) })),
  }
}

/** Pick option `n` of the permission prompt the user saw (its fingerprint, from the screen). */
export async function answerPermission(
  item: Item,
  rawBody: unknown,
  io: PaneIO = paneIO(item?.pane ?? ''),
): Promise<AnswerResult> {
  const body = bodyOf(rawBody)
  const n = Number(body.option)
  if (!Number.isInteger(n) || n < 1 || n > 9 || typeof body.fingerprint !== 'string')
    return { ok: false, error: t('err.qa.invalid') }
  const bad = await checkPane(item)
  if (bad) return bad
  const r = await drivePermission({ fingerprint: body.fingerprint, n, io })
  return r.ok ? { ok: true } : failure(item, r)
}
