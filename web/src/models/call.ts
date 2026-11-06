// What a MokuPilot call agent's card says of its call (#326): a line like the one for the tool at
// work (on a call and for how long, or after the call how many helpers it still waits for), and
// its task board as the card's task lines: what it does, then what comes next. The item carries
// its call (src/core/call-agent.ts CallView); every other card has none and shows nothing more.
import type { CallTask } from '../../../src/core/call-agent.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import { longWhen } from '../../../src/core/when-format.ts'
import { ago, plain } from './card.ts'
import { liveCount } from './helper-model.ts'

/**
 * A MokuPilot call agent with no pane (#326), or a day session (#331): it runs in MokuPilot, so
 * nothing of herdr's or of a terminal goes with its card (focus, sleep, restart, a fork or a call
 * of it, archive, a terminal). A day session's messages go to its day's inbox.
 */
export const inMokupilot = (it: { call?: unknown; day?: unknown; pane?: string | null | undefined }): boolean =>
  (!!it.call || !!it.day) && !it.pane

/** Doing lines a card shows at most; the last one says how many more there are. */
export const CALL_DOING_ROWS = 2

export interface CallRow {
  /** Its task's id on the board. */
  id: string
  kind: 'doing' | 'next'
  label: string
  text: string
  /** Its steps done of all ("2/5"), '' without steps. */
  steps: string
  /** How many more of its kind wait ("+2"), ''. */
  more: string
}

export interface CallLines {
  phase: 'on' | 'after'
  /** "On a call", or "After the call: 2 helpers finishing". */
  label: string
  /** How long it has been on the call, and how much of its board is done. */
  detail: string
  hint: string
  rows: CallRow[]
}

const stepsOf = (task: CallTask, t: Translator): string =>
  task.steps ? t('call.steps', { done: task.steps.done, total: task.steps.total }) : ''

/** A call agent's lines, null for every other card. `now`: the board's clock. */
export function callLines(it: Item, now: number, t: Translator): CallLines | null {
  const call = it.call
  if (!call) return null
  const tasks = call.tasks ?? []
  const done = tasks.filter(x => x.status === 'done').length
  const since = call.since ? ago(call.since, now, t) : ''
  const detail = [since, done ? t('call.done', { n: done }) : ''].filter(Boolean).join(' · ')
  // The card's own line says what it does already: that one is not said twice.
  const said = plain(it.doing)
  const doing = tasks.filter(x => x.status === 'doing' && x.text !== said)
  const next = tasks.filter(x => x.status === 'next')
  const rows: CallRow[] = doing.slice(0, CALL_DOING_ROWS).map((x, i, shown) => ({
    id: x.id,
    kind: 'doing',
    label: t('call.doing'),
    text: x.text,
    steps: stepsOf(x, t),
    more:
      i === shown.length - 1 && doing.length > shown.length ? t('call.more', { n: doing.length - shown.length }) : '',
  }))
  const first = next[0]
  if (first)
    rows.push({
      id: first.id,
      kind: 'next',
      label: t('call.next'),
      text: first.text,
      steps: stepsOf(first, t),
      more: next.length > 1 ? t('call.more', { n: next.length - 1 }) : '',
    })
  if (call.phase === 'after') {
    // Its helpers as its transcript says where the board could read them, else as MokuPilot counts them.
    const n = it.helpers ? liveCount(it) : (call.helpers ?? 0)
    return {
      phase: 'after',
      label: n ? t('call.after', { n }) : t('call.ending'),
      detail,
      hint: t('call.afterHint'),
      rows,
    }
  }
  const hint = call.since ? t('call.onHint', { time: longWhen(call.since, t, now) }) : ''
  return { phase: 'on', label: t('call.on'), detail, hint, rows }
}
