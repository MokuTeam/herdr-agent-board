// `board ask` with options and `board decisions` (#487, services/decisions.ts), loaded by the board
// command only while config.json's `decisions` is on.
import { allCards, readCard } from '../adapters/cards.ts'
import {
  type AskSpec,
  DecisionError,
  type DecisionsConfig,
  durationWords,
  parseAsk,
  type ReservedDecision,
} from '../core/decisions.ts'
import {
  askDecision,
  closeCardDecision,
  decisionsDone,
  decisionsFromCards,
  releaseDecision,
  reserveDecision,
  withDecisionsDb,
} from '../services/decisions.ts'

export { releaseDecision }

/**
 * `board ask "<q>" [--option "<label>"]... [--recommend <n>] [--default-after <duration>]`: the card's
 * ask with its decision; what goes after the card's line ("decision <id> · default in 2 h").
 */
export function askCommand(
  cfg: DecisionsConfig,
  s: { key: string; name?: string | undefined; lane: string | null; own?: boolean },
  before: readonly string[],
  after: readonly string[],
  now: number,
): string {
  const spec = parseAsk(before, after, cfg)
  // Another session's card (`--session`): its default would be typed in with nobody named as asking.
  if (s.own === false && (spec.options.length || spec.defaultMs))
    throw new DecisionError(
      'other',
      "--option and --default-after are for the session's own question: ask another session's card without them",
    )
  const r = withDecisionsDb(db =>
    askDecision(db, { key: s.key, name: s.name ?? '', lane: s.lane, spec, ask: spec.question, now }),
  )
  return ` · decision ${r.id}${r.defaultAt !== null && spec.defaultMs ? ` · default in ${durationWords(spec.defaultMs)}` : ''}`
}

/** `board thread ask` with decisions on: the question's id and default, taken before the thread's question is written. */
export const reserveThreadDecision = (s: { key: string; name: string }, spec: AskSpec, now: number): ReservedDecision =>
  reserveDecision({ key: s.key, name: s.name, spec, now })

/** `board thread ask` with decisions on: the card's ask is the thread's waitingOn, with its decision. */
export function askThreadDecision(
  s: { key: string; name: string; lane: string | null },
  ask: string,
  d: { spec: AskSpec; thread: { id: string; key: string; ask?: string }; reserved?: ReservedDecision | undefined },
  now: number,
): string {
  const r = withDecisionsDb(db =>
    askDecision(db, {
      key: s.key,
      name: s.name,
      lane: s.lane,
      spec: d.spec,
      ask,
      thread: d.thread,
      now,
      ...(d.reserved && { reserved: d.reserved }),
    }),
  )
  return `decision ${r.id}${r.defaultAt !== null && d.spec.defaultMs ? ` · default in ${durationWords(d.spec.defaultMs)}` : ''}`
}

/** `board doing / done / clear`: an open decision of the card is withdrawn with its ask. */
export function withdrawDecision(key: string, now: number): void {
  if (!readCard(key)?.decision) return
  try {
    withDecisionsDb(db =>
      closeCardDecision(db, key, { answer: null, answeredBy: 'withdrawn', via: 'cleared', at: now }, { by: 'agent' }),
    )
  } catch {}
}

const age = (ms: number): string => (ms < 60_000 ? 'just now' : `${durationWords(ms)} ago`)

/** `board decisions [--done] [--json]`: the queue, or the last ones closed. */
export function decisionsCommand(
  words: readonly string[],
  now: number,
  out: (line: string) => void = console.log,
): void {
  const json = words.includes('--json')
  const unknown = words.filter(w => w !== '--json' && w !== '--done')
  if (unknown.length) throw new DecisionError('usage', 'usage: board decisions [--done] [--json]')
  if (words.includes('--done')) {
    const rows = decisionsDone({ limit: 20 })
    if (json) {
      out(JSON.stringify({ ok: true, done: rows }))
      return
    }
    if (!rows.length) {
      out('no decisions closed yet')
      return
    }
    for (const r of rows) {
      const who =
        r.answeredBy === 'default'
          ? 'by default'
          : r.answeredBy === 'owner'
            ? `the owner (${r.via})`
            : `withdrawn (${r.via})`
      const answer = r.answer ? `"${r.answer}"` : '-'
      out(
        `${r.id} · ${r.name || r.session.slice(0, 8)} · ${r.question} · ${answer} · ${who} · ${age(now - (r.answeredAt ?? now))}`,
      )
    }
    return
  }
  const items = decisionsFromCards(allCards())
  if (json) {
    out(JSON.stringify({ ok: true, items }))
    return
  }
  if (!items.length) {
    out('nothing waits on the owner')
    return
  }
  for (const d of items) {
    const opts = d.options.map((o, i) => `${i + 1}. ${o}${d.recommend === i + 1 ? ' (recommended)' : ''}`).join(' / ')
    const when =
      d.defaultAt !== null && !d.held
        ? ` · default in ${durationWords(Math.max(0, d.defaultAt - now))}`
        : d.held
          ? ' · held'
          : ''
    const asked = d.askedAt !== null ? ` · asked ${age(now - d.askedAt)}` : ''
    out(`${d.who} · ${d.question}${opts ? ` · ${opts}` : ''}${asked}${when}`)
  }
}
