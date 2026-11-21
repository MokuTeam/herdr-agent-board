// `board journal [--since <when> | --away] [--json]` (#489): what changed on the board since the
// owner left, a line per session (core/journal.ts journalLines), or all of it as JSON. Reads
// journal.db itself (adapters/journal-store.ts) and only reads it, so it works while the web board
// is down; it never makes the file. Without a flag it is --away: since presence last went to away,
// or, without presence, since the page last went off show.
import { journalStore, openJournalDb } from '../adapters/journal-store.ts'
import { currentPresence } from '../adapters/presence-store.ts'
import { awaySince, type JournalList, journalConfig, journalLines, journalList, withRecord } from '../core/journal.ts'
import { t } from '../core/lang.ts'
import { presenceConfig } from '../core/presence.ts'
import type { Config } from '../core/types.ts'
import { dayOf, parseDuration, parseWhen } from '../core/when.ts'

/**
 * `--since`: a time back (3h, 90m), a bare time of day (23:56, 9pm, 3:30pm: the last one, today or
 * yesterday), a date (its midnight) or a date and time. A time of day is bare with no date and no
 * day word; anything else ahead of now ("2026-11-22 09:00", "tomorrow 9:00", "in 2h") is refused,
 * not moved back.
 */
export function sinceOf(text: string, now: number): number | null {
  // "in 2h" is ahead, not back
  if (/^\s*(in\b|\+)/i.test(text)) return null
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  if (day) {
    const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
    return d.getMonth() === Number(day[2]) - 1 && d.getTime() <= now ? d.getTime() : null
  }
  const back = parseDuration(text)
  if (back !== null) return now - back
  let at = parseWhen(text, now)
  if (at === null) return null
  const words = text.trim().toLowerCase().split(/\s+/)
  const bare = !/^\d{4}-/.test(words[0] ?? '') && !words.some(w => dayOf(w) !== null)
  if (at > now && bare) {
    const d = new Date(at)
    d.setDate(d.getDate() - 1)
    at = d.getTime()
  }
  return at > now ? null : at
}

interface Ctx {
  cfg: Pick<Config, 'journal' | 'presence'> & { categories?: readonly { id: string; title?: string }[] }
  now?: number
  out?: (line: string) => void
  err?: (line: string) => void
}

export function journalCmd(args: readonly string[], ctx: Ctx): number {
  const out = ctx.out ?? ((line: string) => console.log(line))
  const err = ctx.err ?? ((line: string) => console.error(line))
  const now = ctx.now ?? Date.now()
  const json = args.includes('--json')
  const fail = (code: string, key: string, vars?: Record<string, string | number>): number => {
    const message = t(key, vars)
    if (json) out(JSON.stringify({ ok: false, error: code, message }))
    else err(message)
    return 1
  }
  const known = new Set(['--since', '--away', '--json'])
  const at = args.indexOf('--since')
  const sinceText = at >= 0 ? args[at + 1] : undefined
  const stray = args.filter((a, i) => !known.has(a) && !(at >= 0 && i === at + 1))
  if (stray.length || (at >= 0 && (sinceText === undefined || args.includes('--away'))))
    return fail('usage', 'journal.usage')
  if (!journalConfig(ctx.cfg.journal)) return fail('off', 'journal.off')
  let db: ReturnType<typeof openJournalDb> = null
  try {
    db = openJournalDb(false)
    const store = db ? journalStore(db) : null
    let since: number | null
    if (sinceText !== undefined) {
      since = sinceOf(sinceText, now)
      if (since === null) return fail('since', 'journal.badSince')
    } else {
      const presence = presenceConfig(ctx.cfg.presence) ? currentPresence() : null
      since = awaySince(presence, store?.away() ?? {})
      if (since === null) return fail('no_absence', 'journal.noAway')
    }
    const list: JournalList = withRecord(
      store
        ? journalList(store.movesSince(since), store.states(), since)
        : { since, rows: [], more: 0, rest: { work: 0, idle: 0 }, before: 0 },
      store ? (store.start() ?? undefined) : null,
      now,
    )
    const lane = (id: string): string => ctx.cfg.categories?.find(c => c.id === id)?.title || id
    if (json) out(JSON.stringify({ ok: true, ...list }, null, 2))
    else for (const line of journalLines(list, t, now, lane)) out(line)
    return 0
  } finally {
    db?.close()
  }
}
