// Web model and response guards for token spend (#636).
import {
  addDays,
  formatTokens,
  type SessionSpend,
  type SpendCounts,
  type SpendReport,
} from '../../../src/core/spend.ts'
import type { Lang, Translator } from '../../../src/core/types.ts'
import { isSpendCounts } from '../api/client.ts'

export type SpendView = 'week' | 'day'
export const SPEND_VIEWS: readonly SpendView[] = ['week', 'day']

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isCountsMap = (v: unknown): v is Record<string, SpendCounts> => isObj(v) && Object.values(v).every(isSpendCounts)

export function isSpendReport(v: unknown): v is SpendReport {
  return (
    isObj(v) &&
    typeof v.from === 'string' &&
    typeof v.to === 'string' &&
    typeof v.zone === 'string' &&
    (v.lane === null || typeof v.lane === 'string') &&
    isSpendCounts(v.total) &&
    Array.isArray(v.lanes) &&
    v.lanes.every(
      l =>
        isObj(l) &&
        typeof l.lane === 'string' &&
        isSpendCounts(l.counts) &&
        isCountsMap(l.byDay) &&
        typeof l.sessions === 'number',
    ) &&
    Array.isArray(v.days) &&
    v.days.every(d => isObj(d) && typeof d.day === 'string' && isSpendCounts(d.counts) && isCountsMap(d.byLane)) &&
    Array.isArray(v.sessions) &&
    v.sessions.every(
      s =>
        isObj(s) &&
        typeof s.key === 'string' &&
        typeof s.name === 'string' &&
        typeof s.lane === 'string' &&
        typeof s.agent === 'string' &&
        isSpendCounts(s.counts) &&
        isCountsMap(s.byDay),
    )
  )
}

export function spendSheetLine(spend: SessionSpend, today: string, t: Translator): string {
  const c = spend.total
  const cache = c.cacheRead + c.cacheWrite
  const base = t('spend.sheetLine', {
    total: formatTokens(c.total),
    input: formatTokens(c.input),
    output: formatTokens(c.output),
    cache: formatTokens(cache),
  })
  const todayCount = spend.byDay[today]?.total ?? 0
  if (todayCount > 0 && todayCount < c.total) {
    return `${base} · ${t('spend.sheetToday', { today: formatTokens(todayCount) })}`
  }
  return base
}

export function spendSheetTooltip(spend: SessionSpend, today: string, t: Translator): string {
  const c = spend.total
  const parts = [
    `${t('spend.total')}: ${c.total.toLocaleString()}`,
    `${t('spend.in')}: ${c.input.toLocaleString()}`,
    `${t('spend.out')}: ${c.output.toLocaleString()}`,
    `${t('spend.cacheRead')}: ${c.cacheRead.toLocaleString()}`,
    `${t('spend.cacheWrite')}: ${c.cacheWrite.toLocaleString()}`,
    t('spend.responses', { n: c.responses }),
  ]
  const todayCount = spend.byDay[today]?.total ?? 0
  if (todayCount > 0) parts.push(t('spend.sheetToday', { today: todayCount.toLocaleString() }))
  return parts.join(' · ')
}

export function weekRange(anchorDay: string): { from: string; to: string; days: string[] } {
  const from = addDays(anchorDay, -6)
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i))
  return { from, to: anchorDay, days }
}

export function shortDayHead(date: string, lang: Lang): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(lang, {
    weekday: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function cellTooltip(c: SpendCounts, t: Translator): string {
  return [
    `${t('spend.total')}: ${c.total.toLocaleString()}`,
    `${t('spend.in')}: ${c.input.toLocaleString()}`,
    `${t('spend.out')}: ${c.output.toLocaleString()}`,
    `${t('spend.cache')}: ${(c.cacheRead + c.cacheWrite).toLocaleString()}`,
    t('spend.responses', { n: c.responses }),
  ].join(' · ')
}
