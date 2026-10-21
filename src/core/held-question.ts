// A question form Claude Code holds back from the transcript. In auto and plan mode, Claude Code
// 2.1.303 writes the response that calls AskUserQuestion (its thinking, its text and the call)
// only once the question is answered, together with the answer: while the dialog is open the
// transcript has no form to show. The board's PreToolUse hook (entrypoints/hook.ts) hears of the
// call before its dialog opens and puts it on the session's card (card.asking). Pure functions.

import { questionsOf } from './dialogs/question-form.ts'
import { toolDetail, toolLabel } from './transcript.ts'
import type { HeldQuestion, ToolCall, TranscriptInfo } from './types.ts'

export const QUESTION_TOOL = 'AskUserQuestion'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * What a PreToolUse hook's input says of an AskUserQuestion call, reported at `at`: its id, its
 * first question (the card's line), its questions as the board answers them (null: it cannot).
 * Null for any other tool, or a call without an id.
 */
export function heldQuestionOf(input: unknown, at: number): HeldQuestion | null {
  if (!isRecord(input) || input.tool_name !== QUESTION_TOOL) return null
  const id = input.tool_use_id
  if (typeof id !== 'string' || !id) return null
  return { id, detail: toolDetail(QUESTION_TOOL, input.tool_input), questions: questionsOf(input.tool_input), at }
}

const isHeld = (v: unknown): v is HeldQuestion =>
  isRecord(v) &&
  typeof v.id === 'string' &&
  !!v.id &&
  typeof v.detail === 'string' &&
  typeof v.at === 'number' &&
  (v.questions === null || Array.isArray(v.questions))

/**
 * The call a session waits on: the transcript's last one, unless herdr says the session waits for
 * the user, the transcript has no question of its own waiting, and the card holds a question the
 * hook reported after everything the transcript has (else it is an old one: answered by now, or
 * left behind by a process that ended while it asked). That question then, its `reported` time
 * with it, as the transcript would have it.
 */
export function waitingTool(status: string, info: TranscriptInfo | null | undefined, held: unknown): ToolCall | null {
  const tool = info?.tool ?? null
  if (status !== 'blocked' || !isHeld(held)) return tool
  if (tool && (tool.id === held.id || (tool.name === QUESTION_TOOL && tool.pending))) return tool
  if ((info?.lastAt ?? 0) >= held.at) return tool
  return {
    id: held.id,
    name: QUESTION_TOOL,
    label: toolLabel(QUESTION_TOOL),
    detail: held.detail,
    pending: true,
    questions: held.questions,
    reported: held.at,
  }
}

/**
 * Whether the transcript shows a call answered: its result is in, or (a call Claude Code held
 * back) anything was written after the hook reported it. A different last call counts as well,
 * for one the transcript had: it came after the question.
 */
export function answeredIn(info: TranscriptInfo | null | undefined, tool: ToolCall): boolean {
  const now = info?.tool
  if (now?.id === tool.id) return !now.pending
  if (tool.reported === undefined) return !!now
  return (info?.lastAt ?? 0) > tool.reported
}
