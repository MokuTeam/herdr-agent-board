// The session's conversation as the sheet shows it: messages as bubbles, runs of tool calls
// folded into one line that opens to show them, and the question forms it asked with their
// answers; under a message, previews of the images sent from the board.
import type { AssistantTurn, ConversationTurn, ToolTurn, UserTurn } from '../../../src/core/transcript.ts'
import type { Item, Translator } from '../../../src/core/types.ts'

export type AskTurn = ToolTurn & { ask: NonNullable<ToolTurn['ask']> }

export type ThreadPart =
  /** `i`: the fold's place among the folds, which a redraw keeps open. `live`: its last call runs now. */
  | { kind: 'tools'; i: number; live: boolean; summary: string; calls: ToolTurn[] }
  /** `live`: the session is held at a dialog, so an unanswered form still waits. */
  | { kind: 'ask'; turn: AskTurn; live: boolean }
  | { kind: 'message'; turn: UserTurn | AssistantTurn }

const isAsk = (turn: ToolTurn): turn is AskTurn => !!turn.ask

/** The conversation in the order it went (web/app.js thread). */
export function threadParts(
  conversation: readonly ConversationTurn[],
  it: Pick<Item, 'column' | 'status'>,
  t: Translator,
): ThreadPart[] {
  const parts: ThreadPart[] = []
  let run: ToolTurn[] = []
  let i = 0
  const flush = () => {
    const last = run.at(-1)
    if (!last) return
    const live = !last.done && it.column === 'work'
    const summary = live ? t('run.now', { tool: last.label }) : `${t('run.actions', { n: run.length })} · ${last.label}`
    parts.push({ kind: 'tools', i: i++, live, summary, calls: run })
    run = []
  }
  for (const turn of conversation) {
    if (turn.role === 'tool') {
      // A question form is a turn of its own: what was asked, and the answer.
      if (isAsk(turn)) {
        flush()
        parts.push({ kind: 'ask', turn, live: it.status === 'blocked' })
      } else run.push(turn)
      continue
    }
    flush()
    parts.push({ kind: 'message', turn })
  }
  flush()
  return parts
}

/** Under a question form in the conversation: it still waits for an answer, it closed without one, or nothing. */
export function askState(turn: AskTurn, live: boolean): 'waiting' | 'closed' | null {
  if (turn.answers) return null
  if (!turn.done) return live ? 'waiting' : null
  return 'closed'
}

/** Previews of images sent from the board: their paths in a message point into the uploads folder. */
const UPLOAD_IMAGE =
  /((?:[A-Za-z]:[\\/]|\/)[^\s"'<>]*?agent-board[\\/]uploads[\\/](\d{4}-\d{2}-\d{2})[\\/]([^\s\\/]+\.(?:png|jpe?g|gif|webp)))/gi

export interface Thumb {
  /** The path as the message has it (the quick look opens it). */
  path: string
  /** Where the board serves it. */
  url: string
}

export function uploadThumbs(text: unknown): Thumb[] {
  return [...String(text ?? '').matchAll(UPLOAD_IMAGE)].map(m => ({
    path: m[1] ?? '',
    url: `/uploads/${m[2]}/${encodeURIComponent(m[3] ?? '')}`,
  }))
}
