// Decisions on the page (#487, src/core/decisions.ts): how long until a default, how long a question
// has waited, who closed one, and the feature's stylesheet. Pure, apart from the sheet's link.
import type { CardDecision } from '../../../src/core/decisions.ts'
import type { Translator } from '../../../src/core/types.ts'

/** A span in hours and minutes, as the card says it: "1 h 12 min", "45 min", "2 h". */
export function spanText(ms: number, t: Translator): string {
  const min = Math.max(1, Math.ceil(ms / 60_000))
  const h = Math.floor(min / 60)
  const m = min % 60
  return [h > 0 && t('dec.h', { n: h }), m > 0 && t('dec.min', { n: m })].filter(Boolean).join(' ')
}

/** The default's line: when it goes, held, or none. */
export function defaultText(d: Pick<CardDecision, 'defaultAt' | 'held'>, now: number, t: Translator): string {
  if (d.held !== undefined) return t('dec.held')
  if (d.defaultAt === undefined) return ''
  const left = d.defaultAt - now
  return left <= 0 ? t('dec.defaultNow') : t('dec.defaultIn', { t: spanText(left, t) })
}

/** How long a question has waited. */
export function askedText(at: number | null, now: number, t: Translator): string {
  if (at === null) return ''
  const ms = now - at
  return ms < 60_000 ? t('dec.askedNow') : t('dec.asked', { t: spanText(ms, t) })
}

/** A closed question as the record keeps it (GET /api/decisions). */
export interface DecisionRecord {
  id: string
  question: string
  options: string[]
  recommend: number | null
  answer: string | null
  answeredBy: 'owner' | 'default' | 'withdrawn' | null
  via: string | null
  askedAt: number
  answeredAt: number | null
}

export const isDecisionRecord = (v: unknown): v is DecisionRecord =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as DecisionRecord).id === 'string' &&
  typeof (v as DecisionRecord).question === 'string'

/** Who closed it, in words. */
export function closedBy(r: Pick<DecisionRecord, 'answeredBy' | 'via'>, t: Translator): string {
  if (r.answeredBy === 'default') return t('dec.byDefault')
  if (r.answeredBy === 'owner') return t(r.via === 'button' ? 'dec.byButton' : 'dec.byOwner')
  return t('dec.withdrawn')
}

/**
 * The feature's stylesheet (web/styles/decisions.css), linked once decisions are on and before the
 * Terminal look's sheet, which stays last: a page with decisions off loads exactly what it did.
 */
export function linkDecisionsSheet(doc: Document = document): void {
  if (doc.getElementById('decisions-css')) return
  const link = doc.createElement('link')
  link.id = 'decisions-css'
  link.rel = 'stylesheet'
  link.href = 'styles/decisions.css'
  const look = doc.querySelector('link[href$="look-terminal.css"]')
  if (look?.parentNode) look.parentNode.insertBefore(link, look)
  else doc.head.append(link)
}
