// Where things go on a calendar's grid (#328), for the Calendar panel and whatever else is put on
// it later (time entries, #241): items, not events, so the grid does not know what it shows. No
// I/O and no zone of its own: times are instants, days are dates the caller worked out.
//
// A day's timed items side by side where they overlap (columns), the days of a week and a month,
// and the rows of a strip of bars that run over days (all-day events in the week's head, every
// event in the month).
import { addDays } from './time.ts'

export interface Span {
  start: number
  end: number
}

/** An item's place in its day: column `col` of `cols`, `span` columns wide (it widens over free ones). */
export interface Placed<T> {
  item: T
  start: number
  end: number
  col: number
  cols: number
  span: number
}

/**
 * Timed items laid out the way a day's column shows them: items that overlap each other share the
 * width, each in the first column free at its start; a group of items that overlap one another in
 * a chain (a cluster) shares one count of columns; an item widens to the right over columns that
 * stay free for its whole length. `minMs`: an item shorter than that takes that much room (a
 * five-minute call still reads), and so overlaps what that room overlaps.
 */
export function columns<T>(items: readonly T[], spanOf: (t: T) => Span, minMs = 15 * 60_000): Placed<T>[] {
  const all = items
    .map(item => {
      const s = spanOf(item)
      return { item, start: s.start, end: Math.max(s.end, s.start + minMs) }
    })
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Placed<T>[] = []
  let cluster: Placed<T>[] = []
  let clusterEnd = Number.NEGATIVE_INFINITY
  let lastEnds: number[] = []
  const finish = () => {
    const cols = lastEnds.length
    for (const p of cluster) {
      p.cols = cols
      let span = 1
      for (let c = p.col + 1; c < cols; c++) {
        if (cluster.some(q => q.col === c && q.start < p.end && q.end > p.start)) break
        span++
      }
      p.span = span
    }
    out.push(...cluster)
    cluster = []
    lastEnds = []
  }
  for (const a of all) {
    if (a.start >= clusterEnd && cluster.length) finish()
    let col = lastEnds.findIndex(end => end <= a.start)
    if (col < 0) {
      col = lastEnds.length
      lastEnds.push(a.end)
    } else lastEnds[col] = a.end
    cluster.push({ item: a.item, start: a.start, end: a.end, col, cols: 1, span: 1 })
    clusterEnd = cluster.length === 1 ? a.end : Math.max(clusterEnd, a.end)
  }
  if (cluster.length) finish()
  return out
}

/** The part of a span inside [from, to), or null when none of it is. */
export function clip(s: Span, from: number, to: number): Span | null {
  const start = Math.max(s.start, from)
  const end = Math.min(s.end, to)
  if (end > start || (s.start === s.end && s.start >= from && s.start < to)) return { start, end: Math.max(end, start) }
  return null
}

/** 0 for Sunday … 6 for Saturday. */
export const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay()

/** The first day of the week `date` is in, the week starting on `weekStart` (0: Sunday, 1: Monday…). */
export const weekOf = (date: string, weekStart: number): string =>
  addDays(date, -((weekdayOf(date) - weekStart + 7) % 7))

/** `n` days from `from`. */
export const daysFrom = (from: string, n: number): string[] => Array.from({ length: n }, (_, i) => addDays(from, i))

/** The weeks a month's grid shows: from the week its first day is in to the week of its last, seven days each. */
export function monthWeeks(month: string, weekStart: number): string[][] {
  const first = `${month.slice(0, 7)}-01`
  const [y, m] = first.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  const weeks: string[][] = []
  for (let w = weekOf(first, weekStart); w <= last; w = addDays(w, 7)) weeks.push(daysFrom(w, 7))
  return weeks
}

/** A bar over days: its first day's and last day's places among the strip's days. */
export interface Bar<T> {
  item: T
  /** The first and the last of the strip's days it covers (indexes). */
  from: number
  to: number
  /** It goes on before the strip's first day, or after its last. */
  before: boolean
  after: boolean
  row: number
}

/**
 * Bars over a strip of days (a week's head, a month's week), each in the first row free over all
 * its days, longer ones first. `days`: the strip's dates in order; `first` and `last`: the item's
 * first and last date.
 */
export function bars<T>(
  items: readonly T[],
  days: readonly string[],
  datesOf: (t: T) => { first: string; last: string },
): Bar<T>[] {
  const lo = days[0]
  const hi = days.at(-1)
  if (!lo || !hi) return []
  const placed: Bar<T>[] = []
  const rows: boolean[][] = []
  const list = items
    .map(item => ({ item, ...datesOf(item) }))
    .filter(x => x.first <= hi && x.last >= lo)
    .map(x => {
      const from = x.first < lo ? 0 : days.indexOf(x.first)
      const to = x.last > hi ? days.length - 1 : days.indexOf(x.last)
      return { ...x, from: Math.max(0, from), to: Math.max(from, to) }
    })
    .sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from))
  for (const x of list) {
    let row = rows.findIndex(r => r.slice(x.from, x.to + 1).every(taken => !taken))
    if (row < 0) {
      row = rows.length
      rows.push(Array.from({ length: days.length }, () => false))
    }
    const r = rows[row] as boolean[]
    for (let i = x.from; i <= x.to; i++) r[i] = true
    placed.push({ item: x.item, from: x.from, to: x.to, before: x.first < lo, after: x.last > hi, row })
  }
  return placed
}
