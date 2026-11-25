// Decisions (#487): a `board ask` with two to four options, a recommended one, and a default
// after a time; one queue of what waits on the owner; a record of every answer. Behind config.json's
// `decisions` key: absent, nothing here runs. Pure: the config, the flags and their refusals, the
// lines, the queue's order, whose prompt answers a question.
import { switchedOff } from './feature-switch.ts'
import { codeModeEvent, isNotice } from './notices.ts'
import { oneLine } from './work-threads.ts'

export interface DecisionsConfig {
  /** `--default-after` taken (`"decisions": { "defaults": false }` refuses it: nothing decides by itself). */
  defaults: boolean
}

/** config.json's `decisions`: `true` or an object turns it on; `"on": false` (Settings, #596) or anything else is off (null). */
export function decisionsConfig(raw: unknown): DecisionsConfig | null {
  if (raw === true) return { defaults: true }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || switchedOff(raw)) return null
  return { defaults: (raw as Record<string, unknown>).defaults !== false }
}

export const OPTIONS_MIN = 2
export const OPTIONS_MAX = 4
export const LABEL_MAX = 60
export const DEFAULT_MIN_MS = 5 * 60_000
export const DEFAULT_MAX_MS = 72 * 3_600_000

/** A refusal: one line for the agent (or the page), a code for --json and the routes. */
export class DecisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** The open question of a card, as the card keeps it: what the page and the scheduler read. */
export interface CardDecision {
  id: string
  options: string[]
  /** 1-based; absent: none. */
  recommend?: number
  /** When the default fires; absent: none, or held. */
  defaultAt?: number
  /** The --default-after it was asked with, in ms. */
  defaultMs?: number
  /** When the owner pressed Hold. */
  held?: number
  /** A `board thread ask`: the thread's id and key, and its question's entry (the open ask it answers). */
  thread?: { id: string; key: string; ask?: string }
}

/** What `board ask` asks. */
/** A question's id and its default's schedule entry, taken before the question is written (services/decisions.ts). */
export interface ReservedDecision {
  id: string
  entry: string | null
  defaultAt: number | null
}

export interface AskSpec {
  question: string
  options: string[]
  recommend: number | null
  defaultMs: number | null
}

/** "30m", "2h", "1h30m", "90 min": ms, or null for anything else. */
export function parseDuration(raw: string): number | null {
  const m = /^\s*(?:(\d{1,3})\s*h)?\s*(?:(\d{1,4})\s*m(?:in)?)?\s*$/i.exec(raw)
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000
}

/** A duration in words, as the line and the card say it: "2 h", "1 h 30 min", "45 min". */
export function durationWords(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  const h = Math.floor(min / 60)
  const m = min % 60
  return [h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ')
}

const FLAGS = ['--option', '--recommend', '--default-after'] as const
/** The flags `board ask` takes while decisions are on; off, `board ask` says they are words of the question (#596). */
export const DECISION_FLAGS: readonly string[] = FLAGS

/**
 * `board ask`'s words: the flags among `before` (the words before a lone `--`), the question the
 * rest of them and `after` (the words after it, as they are). Refused with one line: an option
 * alone or more than four, an empty, repeated or long label, --recommend without options or out of
 * range, --default-after without --recommend, with defaults off, or a time that does not read or is
 * out of bounds.
 */
export function parseAsk(before: readonly string[], after: readonly string[], cfg: DecisionsConfig): AskSpec {
  const options: string[] = []
  let recommend: string | undefined
  let after_: string | undefined
  const rest: string[] = []
  for (let i = 0; i < before.length; i++) {
    const w = before[i] as string
    if (!(FLAGS as readonly string[]).includes(w)) {
      rest.push(w)
      continue
    }
    const v = before[i + 1]
    if (v === undefined) throw new DecisionError('usage', `${w} needs a value`)
    i++
    if (w === '--option') options.push(v)
    else if (w === '--recommend') recommend = v
    else after_ = v
  }
  return askSpec([...rest, ...after].join(' '), options, recommend, after_, cfg)
}

/** The same from words already parsed (`board thread ask`): the refusals of parseAsk. */
export function askSpec(
  words: string,
  labels: readonly string[],
  recommend: string | undefined,
  after_: string | undefined,
  cfg: DecisionsConfig,
): AskSpec {
  const options = labels.map(l => oneLine(l, LABEL_MAX + 1))
  // The question as a plain `board ask` keeps it: whole, its spaces folded.
  const question = words.replace(/\s+/g, ' ').trim()
  if (!question)
    throw new DecisionError(
      'usage',
      'usage: board ask <question> [--option "<label>"]... [--recommend <n>] [--default-after <duration>]',
    )
  if (options.length && (options.length < OPTIONS_MIN || options.length > OPTIONS_MAX))
    throw new DecisionError('options', `give ${OPTIONS_MIN} to ${OPTIONS_MAX} options, not ${options.length}`)
  for (const o of options) {
    if (!o) throw new DecisionError('label', 'an option needs a label')
    if (o.length > LABEL_MAX)
      throw new DecisionError('label', `an option's label has more than ${LABEL_MAX} characters`)
    // A click types the label in as the owner's line: never a slash command or a shell line.
    if (/^[/!]/.test(o)) throw new DecisionError('label', "an option's label may not start with / or !")
  }
  if (new Set(options.map(o => o.toLowerCase())).size !== options.length)
    throw new DecisionError('label', 'two options have the same label')
  let rec: number | null = null
  if (recommend !== undefined) {
    if (!options.length) throw new DecisionError('recommend', '--recommend needs --option')
    if (!/^\d{1,2}$/.test(recommend) || Number(recommend) < 1 || Number(recommend) > options.length)
      throw new DecisionError('recommend', `--recommend takes an option's number, 1 to ${options.length}`)
    rec = Number(recommend)
  }
  let defaultMs: number | null = null
  if (after_ !== undefined) {
    if (!cfg.defaults)
      throw new DecisionError('defaults_off', 'defaults are off on this board: ask without --default-after')
    if (rec === null)
      throw new DecisionError('default', '--default-after needs --recommend: the default is the recommended option')
    defaultMs = parseDuration(after_)
    if (defaultMs === null)
      throw new DecisionError('default', `--default-after takes a time like 30m, 2h or 1h30m, not "${after_}"`)
    if (defaultMs < DEFAULT_MIN_MS || defaultMs > DEFAULT_MAX_MS)
      throw new DecisionError('default', '--default-after takes 5 min to 72 h')
  }
  return { question, options, recommend: rec, defaultMs }
}

/** What the board types when the default's time has come (after `[board reminder from decisions]`). */
export const defaultLine = (ms: number, label: string): string =>
  `no answer in ${durationWords(ms)}: go with your recommendation "${label}"`

/** The tag the default goes with: `[board reminder from decisions]`. */
export const DECISIONS_FROM = { key: 'decisions', name: 'decisions' } as const

// Prompts no person typed that the hook still counts as the user's on main (it clears the ask):
// another session's message, a teammate's, an agent's. A Telegram message (<channel>) is the owner's.
const PEER_TAG = /^\s*<(?:task-notification|cross-session-message|agent-message|teammate-message)\b/
// A slash command: the board's own /compact (services/compactor.ts) or one the owner typed; neither
// answers a question (an option never starts with /, core/decisions.ts askSpec).
const SLASH = /^\s*\//

/**
 * Whether a prompt that cleared the card's ask (the hook: not a board reminder, a restart's note, a
 * call's results or a task notification) is the owner's own answer: not another session's or
 * teammate's message, not Code Mode's background result, not a slash command. Those clear the ask as
 * on main, and the decision is recorded as withdrawn, never as the owner's.
 */
export const ownerPrompt = (text: unknown): boolean =>
  !isNotice(text) && !codeModeEvent(text) && !PEER_TAG.test(String(text ?? '')) && !SLASH.test(String(text ?? ''))

/** An answer as the record keeps it: the prompt's first line, clipped. */
export const answerText = (text: unknown): string =>
  oneLine(
    String(text ?? '')
      .split(/\r?\n/)
      .find(l => l.trim()) ?? '',
    200,
  )

/** One question in the queue (the page's Decisions panel, `board decisions`). */
export interface DecisionView {
  /** The card's key: what an answer goes to. */
  key: string
  /** Its open decision's id; null for an ask with none (one from before, or the board's own). */
  id: string | null
  who: string
  lane?: string
  question: string
  options: string[]
  recommend: number | null
  askedAt: number | null
  defaultAt: number | null
  held: boolean
  thread?: string
  /** The board's own "needs the user" (a secret request): answered in its own form, not here. */
  board?: boolean
}

/** A question the default answered, for the panel's "went by default" lines. */
export interface DefaultedView {
  id: string
  key: string
  who: string
  question: string
  answer: string
  at: number
}

/** The payload's `decisions`, only while on. */
export interface DecisionsPayload {
  items: DecisionView[]
  /** Answered by the default since the owner last opened the panel. */
  defaulted: DefaultedView[]
  defaults: boolean
}

/** The queue's order: a running default first, soonest first; then the rest, oldest first. */
export function orderQueue<T extends Pick<DecisionView, 'defaultAt' | 'held' | 'askedAt'>>(list: readonly T[]): T[] {
  const running = (d: T): number | null => (d.defaultAt !== null && !d.held ? d.defaultAt : null)
  return [...list].sort((a, b) => {
    const ra = running(a)
    const rb = running(b)
    if (ra !== null || rb !== null) return ra === null ? 1 : rb === null ? -1 : ra - rb
    return (a.askedAt ?? Number.MAX_SAFE_INTEGER) - (b.askedAt ?? Number.MAX_SAFE_INTEGER)
  })
}

/**
 * A decision as a node's card keeps it (#781): its master holds the question, and the mark tells
 * this computer's hook and `board` not to look for it in their own database.
 */
export const masterHeld = (d: CardDecision): CardDecision => ({ ...d, master: true }) as CardDecision

/** Whether a card's raw decision is one its master holds (masterHeld). */
export const heldByMaster = (raw: unknown): boolean =>
  typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>).master === true

/**
 * The owner's own answer to a question its master holds (#784): a node's hook notes it on the card
 * when the owner types it in the session's terminal, and the master, seeing the card without the
 * question, records it as the owner's instead of withdrawn.
 */
export interface DecisionAnswer {
  id: string
  /** The prompt's first line, clipped (answerText). */
  answer: string
  at: number
}

/** What the node's hook notes for the master-held decision `raw` on the owner's prompt; null for any other prompt. */
export function decisionAnswerFor(raw: unknown, prompt: unknown, now: number): DecisionAnswer | null {
  const id = cardDecisionOf(raw)?.id
  return id && ownerPrompt(prompt) ? { id, answer: answerText(prompt), at: now } : null
}

/** A noted answer as a card or a node's item carries it, or null. */
export function decisionAnswerOf(raw: unknown): DecisionAnswer | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { id, answer, at } = raw as Record<string, unknown>
  if (typeof id !== 'string' || !id || id.length > 64 || typeof answer !== 'string' || answer.length > 500) return null
  return typeof at === 'number' && Number.isFinite(at) ? { id, answer, at } : null
}

/** A card's decision as kept, when it reads as one. */
export function cardDecisionOf(raw: unknown): CardDecision | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id || !Array.isArray(r.options)) return null
  const options = r.options.filter((o): o is string => typeof o === 'string')
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const th = r.thread as Record<string, unknown> | undefined
  const thread =
    th && typeof th === 'object' && typeof th.id === 'string' && typeof th.key === 'string'
      ? { id: th.id, key: th.key, ...(typeof th.ask === 'string' && th.ask && { ask: th.ask }) }
      : undefined
  const recommend = num(r.recommend)
  const defaultAt = num(r.defaultAt)
  const defaultMs = num(r.defaultMs)
  const held = num(r.held)
  return {
    id: r.id,
    options,
    ...(recommend !== undefined && recommend >= 1 && recommend <= options.length && { recommend }),
    ...(defaultAt !== undefined && { defaultAt }),
    ...(defaultMs !== undefined && { defaultMs }),
    ...(held !== undefined && { held }),
    ...(thread && { thread }),
  }
}
