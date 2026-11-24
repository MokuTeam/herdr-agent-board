// Token spend per session and per lane, by local day (#636).
// Pure: no node: imports, shared by the server, CLI, and web UI.
import { addDays, dateIn, isDate, localZone, spanLength } from './time.ts'

export { addDays, dateIn, isDate, localZone, spanLength }

export type SpendAgent = 'claude' | 'codex' | 'pi'

export interface SpendCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  responses: number
}

export interface SessionSpend {
  total: SpendCounts
  byDay: Record<string, SpendCounts>
}

export interface SpendSessionRow {
  key: string
  name: string
  lane: string
  agent: SpendAgent
  counts: SpendCounts
  byDay: Record<string, SpendCounts>
}

export interface SpendLaneRow {
  lane: string
  counts: SpendCounts
  byDay: Record<string, SpendCounts>
  sessions: number
}

export interface SpendDayRow {
  day: string
  counts: SpendCounts
  byLane: Record<string, SpendCounts>
}

export interface SpendReport {
  from: string
  to: string
  zone: string
  lane: string | null
  total: SpendCounts
  lanes: SpendLaneRow[]
  days: SpendDayRow[]
  sessions: SpendSessionRow[]
}

export interface SpendParseOptions {
  zone?: string
  fallbackDay?: string
  minAt?: number
}

export interface SpendParser {
  feed(line: string): void
  result(): SessionSpend
  title(): string
}

export const MAX_SPEND_DAYS = 42

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const nonNegInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)

function parseLine(line: string): Rec | null {
  try {
    return rec(JSON.parse(line))
  } catch {
    return null
  }
}

export function emptyCounts(): SpendCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, responses: 0 }
}

export function cloneCounts(c: SpendCounts): SpendCounts {
  return {
    input: c.input,
    output: c.output,
    cacheRead: c.cacheRead,
    cacheWrite: c.cacheWrite,
    total: c.total,
    responses: c.responses,
  }
}

export function addCounts(target: SpendCounts, delta: Partial<SpendCounts>): void {
  target.input += delta.input ?? 0
  target.output += delta.output ?? 0
  target.cacheRead += delta.cacheRead ?? 0
  target.cacheWrite += delta.cacheWrite ?? 0
  target.responses += delta.responses ?? 0
  target.total = target.input + target.output + target.cacheRead + target.cacheWrite
}

/** Compact token formatting: 0, 640, 1.5k, 42k, 1.2M, 120M, 1.5B. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 999_500) {
    if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
    return `${Math.round(n / 1000)}k`
  }
  if (n < 999_500_000) {
    if (n < 100_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    return `${Math.round(n / 1_000_000)}M`
  }
  return `${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`
}

interface TokenEntry {
  day: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

function bucketOf(map: Record<string, SpendCounts>, key: string): SpendCounts {
  if (Object.hasOwn(map, key) && map[key]) return map[key]
  const b = emptyCounts()
  map[key] = b
  return b
}

function summarizeEntries(entries: Iterable<TokenEntry>): SessionSpend {
  const total = emptyCounts()
  const byDay: Record<string, SpendCounts> = {}
  for (const e of entries) {
    const sum = e.input + e.output + e.cacheRead + e.cacheWrite
    if (sum <= 0) continue
    const delta: Partial<SpendCounts> = {
      input: e.input,
      output: e.output,
      cacheRead: e.cacheRead,
      cacheWrite: e.cacheWrite,
      responses: 1,
    }
    addCounts(total, delta)
    if (e.day) addCounts(bucketOf(byDay, e.day), delta)
  }
  return { total, byDay }
}

/**
 * Streaming parser for Claude Code transcripts.
 * Each response is deduplicated by message.id -> requestId -> uuid -> line index, taking max
 * counts across streaming chunks so each response is counted once.
 */
export function createClaudeSpendParser(opts: SpendParseOptions = {}): SpendParser {
  const zone = opts.zone || localZone()
  const fallbackDay = opts.fallbackDay ?? ''
  const minAt = opts.minAt ?? 0
  const byResponse = new Map<string, TokenEntry>()
  let lineIndex = 0
  let aiTitle = ''

  return {
    feed(line: string) {
      const idx = lineIndex++
      if (!line) return
      if (line.includes('"type":"ai-title"') || line.includes('"aiTitle"')) {
        const o = parseLine(line)
        if (o?.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) {
          aiTitle = o.aiTitle.trim()
        }
        if (!line.includes('"assistant"')) return
      }
      if (!line.includes('"assistant"') || !line.includes('"usage"')) return
      const o = parseLine(line)
      if (o?.type !== 'assistant' || o.isSidechain) return
      const message = rec(o.message)
      if (!message || message.model === '<synthetic>') return
      const u = rec(message.usage)
      if (!u) return
      const input = nonNegInt(u.input_tokens)
      const output = nonNegInt(u.output_tokens)
      const cacheRead = nonNegInt(u.cache_read_input_tokens)
      const cacheWrite = nonNegInt(u.cache_creation_input_tokens)
      if (input + output + cacheRead + cacheWrite <= 0) return

      const at = Date.parse(str(o.timestamp))
      if (minAt > 0 && Number.isFinite(at) && at < minAt) return
      const day = Number.isFinite(at) ? dateIn(at, zone) : fallbackDay
      const key = str(message.id) || str(o.requestId) || str(o.uuid) || `line:${idx}`
      const prev = byResponse.get(key)
      if (prev) {
        prev.day ||= day
        prev.input = Math.max(prev.input, input)
        prev.output = Math.max(prev.output, output)
        prev.cacheRead = Math.max(prev.cacheRead, cacheRead)
        prev.cacheWrite = Math.max(prev.cacheWrite, cacheWrite)
      } else {
        byResponse.set(key, { day, input, output, cacheRead, cacheWrite })
      }
    },
    result() {
      return summarizeEntries(byResponse.values())
    },
    title() {
      return aiTitle
    },
  }
}

interface CodexTotal {
  input: number
  cached: number
  output: number
}

function fromCodexUsage(u: Rec): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const inTotal = nonNegInt(u.input_tokens)
  const cached = nonNegInt(u.cached_input_tokens)
  const output = nonNegInt(u.output_tokens)
  // OpenAI reports cached_input_tokens as a subset of input_tokens: subtract to avoid double counting.
  return { input: Math.max(0, inTotal - cached), output, cacheRead: cached, cacheWrite: 0 }
}

/**
 * Streaming parser for Codex rollout JSONL files.
 * Reads `event_msg` `token_count` records, computes deltas from cumulative `total_token_usage`
 * without double-counting duplicate `token_count` events or `cached_input_tokens`.
 */
export function createCodexSpendParser(opts: SpendParseOptions = {}): SpendParser {
  const zone = opts.zone || localZone()
  const fallbackDay = opts.fallbackDay ?? ''
  const minAt = opts.minAt ?? 0
  const total = emptyCounts()
  const byDay: Record<string, SpendCounts> = {}
  let prevTotal: CodexTotal | null = null

  return {
    feed(line: string) {
      if (!line?.includes('"token_count"')) return
      const entry = parseLine(line)
      const item = rec(entry?.payload)
      if (entry?.type !== 'event_msg' || item?.type !== 'token_count') return
      const info = rec(item.info)
      if (!info) return
      const tot = rec(info.total_token_usage)
      const last = rec(info.last_token_usage)

      let delta: { input: number; output: number; cacheRead: number; cacheWrite: number }
      if (tot) {
        const cur: CodexTotal = {
          input: nonNegInt(tot.input_tokens),
          cached: nonNegInt(tot.cached_input_tokens),
          output: nonNegInt(tot.output_tokens),
        }
        if (prevTotal) {
          if (cur.input === prevTotal.input && cur.cached === prevTotal.cached && cur.output === prevTotal.output) {
            return
          }
          if (cur.input >= prevTotal.input && cur.cached >= prevTotal.cached && cur.output >= prevTotal.output) {
            const dInTotal = cur.input - prevTotal.input
            const dCached = cur.cached - prevTotal.cached
            const dOut = cur.output - prevTotal.output
            prevTotal = cur
            delta = { input: Math.max(0, dInTotal - dCached), output: dOut, cacheRead: dCached, cacheWrite: 0 }
          } else {
            // Counter reset within the rollout: take last_token_usage if available, else current total.
            prevTotal = cur
            delta = fromCodexUsage(last ?? tot)
          }
        } else {
          prevTotal = cur
          delta = fromCodexUsage(tot)
        }
      } else if (last) {
        delta = fromCodexUsage(last)
      } else {
        return
      }

      const at = Date.parse(str(entry.timestamp))
      if (minAt > 0 && Number.isFinite(at) && at < minAt) return
      if (delta.input + delta.output + delta.cacheRead + delta.cacheWrite <= 0) return

      const day = Number.isFinite(at) ? dateIn(at, zone) : fallbackDay
      const add: Partial<SpendCounts> = { ...delta, responses: 1 }
      addCounts(total, add)
      if (day) addCounts(bucketOf(byDay, day), add)
    },
    result() {
      const clonedByDay: Record<string, SpendCounts> = {}
      for (const [d, c] of Object.entries(byDay)) clonedByDay[d] = cloneCounts(c)
      return { total: cloneCounts(total), byDay: clonedByDay }
    },
    title() {
      return ''
    },
  }
}

/**
 * Streaming parser for pi session JSONL files.
 * Counts assistant `message` entries with `usage` (`input`, `output`, `cacheRead`, `cacheWrite`).
 */
export function createPiSpendParser(opts: SpendParseOptions = {}): SpendParser {
  const zone = opts.zone || localZone()
  const fallbackDay = opts.fallbackDay ?? ''
  const minAt = opts.minAt ?? 0
  const byResponse = new Map<string, TokenEntry>()
  let lineIndex = 0
  let sessionName = ''

  return {
    feed(line: string) {
      const idx = lineIndex++
      if (!line) return
      if (line.includes('"session_info"')) {
        const o = parseLine(line)
        if (o?.type === 'session_info' && typeof o.name === 'string') sessionName = o.name.trim()
        if (!line.includes('"assistant"')) return
      }
      if (!line.includes('"assistant"') || !line.includes('"usage"')) return
      const o = parseLine(line)
      if (o?.type !== 'message') return
      const message = rec(o.message)
      if (message?.role !== 'assistant') return
      const u = rec(message.usage)
      if (!u) return
      const input = nonNegInt(u.input)
      const output = nonNegInt(u.output)
      const cacheRead = nonNegInt(u.cacheRead)
      const cacheWrite = nonNegInt(u.cacheWrite)
      if (input + output + cacheRead + cacheWrite <= 0) return

      const msgAt = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) ? message.timestamp : 0
      const at = msgAt > 0 ? msgAt : Date.parse(str(o.timestamp))
      if (minAt > 0 && Number.isFinite(at) && at < minAt) return
      const day = Number.isFinite(at) ? dateIn(at, zone) : fallbackDay
      const key = str(o.id) || `line:${idx}`
      const prev = byResponse.get(key)
      if (prev) {
        prev.day ||= day
        prev.input = Math.max(prev.input, input)
        prev.output = Math.max(prev.output, output)
        prev.cacheRead = Math.max(prev.cacheRead, cacheRead)
        prev.cacheWrite = Math.max(prev.cacheWrite, cacheWrite)
      } else {
        byResponse.set(key, { day, input, output, cacheRead, cacheWrite })
      }
    },
    result() {
      return summarizeEntries(byResponse.values())
    },
    title() {
      return sessionName
    },
  }
}

export function createSpendParser(agent: SpendAgent, opts?: SpendParseOptions): SpendParser {
  if (agent === 'codex') return createCodexSpendParser(opts)
  if (agent === 'pi') return createPiSpendParser(opts)
  return createClaudeSpendParser(opts)
}

export function parseClaudeSpend(lines: readonly string[], opts?: SpendParseOptions): SessionSpend {
  const p = createClaudeSpendParser(opts)
  for (const line of lines) p.feed(line)
  return p.result()
}

export function parseCodexSpend(lines: readonly string[], opts?: SpendParseOptions): SessionSpend {
  const p = createCodexSpendParser(opts)
  for (const line of lines) p.feed(line)
  return p.result()
}

export function parsePiSpend(lines: readonly string[], opts?: SpendParseOptions): SessionSpend {
  const p = createPiSpendParser(opts)
  for (const line of lines) p.feed(line)
  return p.result()
}

export interface AggregateSessionInput {
  key: string
  name: string
  lane: string
  agent: SpendAgent
  spend: SessionSpend
}

/** Pure aggregation of per-session spend into a SpendReport for `[from, to]` and optional `lane`. */
export function aggregateSpend(input: {
  from: string
  to: string
  zone: string
  lane?: string | null
  sessions: readonly AggregateSessionInput[]
}): SpendReport {
  const { from, to, zone, lane = null } = input
  const total = emptyCounts()
  const laneMap = new Map<string, SpendLaneRow>()
  const dayMap = new Map<string, SpendDayRow>()
  const sessions: SpendSessionRow[] = []

  for (const s of input.sessions) {
    if (lane && s.lane !== lane) continue
    const counts = emptyCounts()
    const byDay: Record<string, SpendCounts> = {}
    for (const [d, c] of Object.entries(s.spend.byDay)) {
      if (d < from || d > to || c.total <= 0) continue
      byDay[d] = cloneCounts(c)
      addCounts(counts, c)
    }
    if (counts.total <= 0) continue

    sessions.push({
      key: s.key,
      name: s.name,
      lane: s.lane,
      agent: s.agent,
      counts,
      byDay,
    })
    addCounts(total, counts)

    let laneRow = laneMap.get(s.lane)
    if (!laneRow) {
      laneRow = { lane: s.lane, counts: emptyCounts(), byDay: {}, sessions: 0 }
      laneMap.set(s.lane, laneRow)
    }
    laneRow.sessions += 1
    addCounts(laneRow.counts, counts)
    for (const [d, c] of Object.entries(byDay)) {
      addCounts(bucketOf(laneRow.byDay, d), c)

      let dayRow = dayMap.get(d)
      if (!dayRow) {
        dayRow = { day: d, counts: emptyCounts(), byLane: {} }
        dayMap.set(d, dayRow)
      }
      addCounts(dayRow.counts, c)
      addCounts(bucketOf(dayRow.byLane, s.lane), c)
    }
  }

  const lanes = [...laneMap.values()].sort((a, b) => b.counts.total - a.counts.total || a.lane.localeCompare(b.lane))
  const days = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day))
  sessions.sort((a, b) => b.counts.total - a.counts.total || a.key.localeCompare(b.key))

  return { from, to, zone, lane, total, lanes, days, sessions }
}
