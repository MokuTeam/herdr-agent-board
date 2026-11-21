// The away journal on the page (#489): the "While you were away" strip's title, the toolbar's
// "Since 23:56", and what GET /api/journal answers, without a page. The list itself and its order
// are core/journal.ts's, the same as `board journal` prints.
import { clockText, type JournalList, ROW_ORDER } from '../../../src/core/journal.ts'
import type { Translator } from '../../../src/core/types.ts'

/** The toolbar button's words for the last return: "Since 23:56". */
export const journalButton = (
  last: { from: number } | null | undefined,
  t: Translator,
  now = Date.now(),
): string | null => (last ? t('journal.button', { from: clockText(last.from, now) }) : null)

/** The strip's title: the return's absence, or "Since 23:56" for one opened again from the toolbar. */
export function stripTitle(from: number, to: number | null, t: Translator, now = Date.now()): string {
  const f = clockText(from, now)
  return to === null ? t('journal.stripSince', { from: f }) : t('journal.strip', { from: f, to: clockText(to, now) })
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A list as GET /api/journal answers it. */
export function isJournalList(v: unknown): v is JournalList {
  if (typeof v !== 'object' || v === null) return false
  const l = v as Record<string, unknown>
  const rest = l.rest as Record<string, unknown> | null
  return (
    isNumber(l.since) &&
    isNumber(l.more) &&
    isNumber(l.before) &&
    typeof rest === 'object' &&
    rest !== null &&
    isNumber(rest.work) &&
    isNumber(rest.idle) &&
    Array.isArray(l.rows) &&
    l.rows.every(
      (r: unknown) =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as Record<string, unknown>).key === 'string' &&
        ROW_ORDER.includes((r as Record<string, unknown>).kind as never),
    )
  )
}
