// Classify transcript API errors that mean a session lost provider access (usage/rate limit,
// logged out / 401, expired OAuth login) and format one-line card messages. Pure: no I/O.
import type { Translator } from './types.ts'
import { shortWhen } from './when-format.ts'

export type LostAccessKind = 'limit' | 'logged_out' | 'expired'

export interface LostAccess {
  kind: LostAccessKind
  /** Epoch ms when the limit resets, or null when unknown / not applicable. */
  resetsAt: number | null
  /** Clean unparsed reset string when resetsAt could not be resolved to an epoch. */
  resetText?: string
  /** Timestamp (epoch ms) of the transcript error entry, 0 when unknown. */
  at: number
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}

const DAY_MS = 86_400_000

/** Convert a wall-clock date/time in `timeZone` (or local when omitted) to epoch ms; null if invalid. */
function zonedWallToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone?: string,
): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  if (!timeZone) {
    const d = new Date(year, month - 1, day, hour, minute, second, 0)
    return Number.isNaN(d.getTime()) ? null : d.getTime()
  }
  const zone = timeZone.toUpperCase() === 'GMT' ? 'UTC' : timeZone
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    const target = Date.UTC(year, month - 1, day, hour, minute, second)
    let guess = target
    for (let i = 0; i < 3; i++) {
      const parts = fmt.formatToParts(new Date(guess))
      const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)
      const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
      const diff = target - shown
      if (diff === 0) return guess
      guess += diff
    }
    return guess
  } catch {
    return null
  }
}

/** Year, month (1-12), and day (1-31) of `ms` in `timeZone` (or local). */
function zonedDateParts(ms: number, timeZone?: string): { year: number; month: number; day: number } | null {
  if (!timeZone) {
    const d = new Date(ms)
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }
  }
  const zone = timeZone.toUpperCase() === 'GMT' ? 'UTC' : timeZone
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms))
    const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)
    return { year: get('year'), month: get('month'), day: get('day') }
  } catch {
    return null
  }
}

function to24h(hour: number, ampm?: string): number | null {
  if (ampm) {
    if (hour < 1 || hour > 12) return null
    const low = ampm.toLowerCase()
    if (low === 'am') return hour === 12 ? 0 : hour
    if (low === 'pm') return hour === 12 ? 12 : hour + 12
    return null
  }
  return hour >= 0 && hour <= 23 ? hour : null
}

function parseJsonResetFields(
  text: string,
  referenceAt: number,
): { resetsAt: number | null; resetText: string } | null {
  const epoch = /"(?:resets_at|resetsAt|reset_at)"\s*:\s*(\d{10,13})\b/.exec(text)
  if (epoch?.[1]) {
    const n = Number(epoch[1])
    const ms = epoch[1].length >= 13 ? n : n * 1000
    if (Number.isFinite(ms) && ms > 0) return { resetsAt: ms, resetText: '' }
  }
  const iso = /"(?:resets_at|resetsAt|reset_at)"\s*:\s*"([^"]+)"/.exec(text)
  if (iso?.[1]) {
    const ms = Date.parse(iso[1])
    if (Number.isFinite(ms) && ms > 0) return { resetsAt: ms, resetText: '' }
  }
  const retry = /"(?:retry_after|retryAfter|resets_in_seconds|resetsInSeconds)"\s*:\s*(\d+(?:\.\d+)?)\b/.exec(text)
  if (retry?.[1]) {
    const sec = Number(retry[1])
    if (Number.isFinite(sec) && sec > 0) {
      return referenceAt > 0
        ? { resetsAt: referenceAt + Math.round(sec * 1000), resetText: '' }
        : { resetsAt: null, resetText: `${Math.round(sec)}s` }
    }
  }
  return null
}

function parseRelativeReset(text: string, referenceAt: number): { resetsAt: number | null; resetText: string } | null {
  const m =
    /\b(?:resets?|try\s+again|retry)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\s*,?\s*)+)/i.exec(
      text,
    )
  if (!m?.[1]) return null
  const raw = m[1].trim().replace(/[.,;]+$/, '')
  let deltaMs = 0
  for (const part of raw.matchAll(
    /(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)(?=\b|\d)/gi,
  )) {
    const n = Number(part[1])
    const unit = (part[2] ?? '').toLowerCase()
    if (!Number.isFinite(n) || n <= 0) continue
    if (unit.startsWith('d')) deltaMs += n * DAY_MS
    else if (unit.startsWith('h')) deltaMs += n * 3_600_000
    else if (unit.startsWith('m')) deltaMs += n * 60_000
    else if (unit.startsWith('s')) deltaMs += n * 1000
  }
  if (deltaMs <= 0) return null
  if (referenceAt > 0) return { resetsAt: referenceAt + deltaMs, resetText: '' }
  return { resetsAt: null, resetText: raw.slice(0, 60) }
}

const CLOCK_RESET_RE =
  /\b(?:resets?(?:\s+at)?|until|try\s+again\s+at|available\s+at)\s+((?:([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?(?:\s*,?\s*at|\s*,)?\s+)?(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm))?(?:\s*\(([^)]+)\))?)/i

/** Extract a reset timestamp or clean text from a rate/usage-limit error message. */
export function parseResetTime(text: string, referenceAt = 0): { resetsAt: number | null; resetText: string } {
  const pipe = /\|(\d{10,13})\s*$/.exec(text.trim())
  if (pipe?.[1]) {
    const n = Number(pipe[1])
    const ms = pipe[1].length >= 13 ? n : n * 1000
    if (Number.isFinite(ms) && ms > 0) return { resetsAt: ms, resetText: '' }
  }

  const jsonReset = parseJsonResetFields(text, referenceAt)
  if (jsonReset) return jsonReset

  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))\b/.exec(text)
  if (iso?.[1]) {
    const ms = Date.parse(iso[1])
    if (Number.isFinite(ms) && ms > 0) return { resetsAt: ms, resetText: '' }
  }

  const rel = parseRelativeReset(text, referenceAt)
  if (rel) return rel

  const m = CLOCK_RESET_RE.exec(text)
  if (!m) return { resetsAt: null, resetText: '' }

  const rawExpr = (m[1] ?? '')
    .trim()
    .replace(/[.,;]+$/, '')
    .slice(0, 60)
  const monthName = m[2]?.toLowerCase()
  const dayNum = m[3] ? Number(m[3]) : null
  const yearNum = m[4] ? Number(m[4]) : null
  const rawHour = Number(m[5])
  const minute = m[6] ? Number(m[6]) : 0
  const ampm = m[7]
  const tz = m[8]?.trim()

  // Bare integers like "resets 5" without ":mm" or "am/pm" are not clock times.
  if (!m[6] && !ampm) return { resetsAt: null, resetText: '' }

  const hour = to24h(rawHour, ampm)
  if (hour === null || minute < 0 || minute > 59) return { resetsAt: null, resetText: rawExpr }

  const anchor = referenceAt > 0 ? referenceAt : Date.now()
  const base = zonedDateParts(anchor, tz)
  if (!base) return { resetsAt: null, resetText: rawExpr }

  const month = monthName ? (MONTHS[monthName] ?? null) : base.month
  if (month === null) return { resetsAt: null, resetText: rawExpr }

  let year = yearNum ?? base.year
  const day = dayNum ?? base.day
  let ms = zonedWallToEpoch(year, month, day, hour, minute, 0, tz)
  if (ms === null) return { resetsAt: null, resetText: rawExpr }

  if (!monthName && !yearNum && ms <= anchor - 60_000) {
    const nextDay = zonedDateParts(anchor + DAY_MS, tz)
    if (nextDay) {
      const rolled = zonedWallToEpoch(nextDay.year, nextDay.month, nextDay.day, hour, minute, 0, tz)
      if (rolled !== null) ms = rolled
    }
  } else if (monthName && !yearNum && ms < anchor - 180 * DAY_MS) {
    year += 1
    const rolled = zonedWallToEpoch(year, month, day, hour, minute, 0, tz)
    if (rolled !== null) ms = rolled
  }

  return { resetsAt: ms, resetText: '' }
}

const EXPIRED_RE =
  /\boauth\b.{0,40}\b(?:expired|invalid|revoked|refresh)\b|\b(?:access|auth(?:entication)?|refresh)\s+token\b.{0,40}\b(?:expired|invalid|reused|already\s+used|revoked|could\s+not\s+be\s+refreshed)\b|\btoken\s+(?:has\s+)?expired\b|\b(?:session|login|credentials?)\s+(?:has|have)?\s*expired\b/i

const LOGGED_OUT_RE =
  /\bauthentication[_\s-]?(?:error|failed)\b|(?:^|[\s:(])401\b(?=\s*(?:unauthorized|authentication|\{|error|$))|\b(?:api\s+error|http|status(?:\s+code)?)[:\s]+401\b|\bunauthorized\b|\b(?:logged\s+out|not\s+logged\s+in|please\s+(?:run\s+\/login|log\s*in|sign\s+in\s+again|re-?authenticate)|run\s+\/login)\b|\b(?:invalid\s+(?:api[- ]?key|x-api-key|bearer\s+token|auth(?:entication)?\s+token|credentials)|no\s+api\s+key)\b/i

const LIMIT_RE =
  /\byou(?:'ve| have)\s+(?:hit|reached)\s+your\s+(?:[\w-]+\s+)*limit\b|\busage\s+limit\b|\brate[_\s-]?limit(?:ed|_error|_exceeded)?\b|(?:^|[\s:(])429\b(?=\s*(?:too\s+many|rate|\{|error|$))|\b(?:api\s+error|http|status(?:\s+code)?)[:\s]+429\b|\btoo\s+many\s+requests\b|\bexceeded\s+your\s+current\s+quota\b|\b(?:quota|spending\s+limit|5-hour\s+limit|weekly\s+limit|session\s+limit|extra\s+usage)\b.{0,30}\b(?:exceeded|reached|exhausted|limit)\b|\bout\s+of\s+extra\s+usage\b/i

/**
 * Classify a transcript error entry as a lost-access incident, or null for transient/other errors.
 * Only call on error entries (e.g. Claude `isApiErrorMessage`, Codex error events, pi `stopReason === 'error'`).
 */
export function parseLostAccess(text: string, opts: { errorCode?: string; at?: number } = {}): LostAccess | null {
  const at = typeof opts.at === 'number' && Number.isFinite(opts.at) && opts.at > 0 ? opts.at : 0
  const code = (opts.errorCode ?? '').trim().toLowerCase()
  const body = String(text ?? '').trim()

  if (EXPIRED_RE.test(body)) {
    return { kind: 'expired', resetsAt: null, at }
  }
  if (code === 'authentication_failed' || code === 'unauthorized' || code === '401' || LOGGED_OUT_RE.test(body)) {
    return { kind: 'logged_out', resetsAt: null, at }
  }
  if (
    code === 'rate_limit' ||
    code === 'usage_limit_exceeded' ||
    code === 'usagelimitexceeded' ||
    code === 'rate_limit_exceeded' ||
    code === 'ratelimitexceeded' ||
    code === '429' ||
    LIMIT_RE.test(body)
  ) {
    const { resetsAt, resetText } = parseResetTime(body, at)
    return { kind: 'limit', resetsAt, ...(resetText && { resetText }), at }
  }
  return null
}

/** One-line card text for a lost-access incident, in the board's language. */
export function lostAccessLine(
  access: LostAccess,
  profileTitle: string | null,
  t: Translator,
  now = Date.now(),
): string {
  if (access.kind === 'limit') {
    if (access.resetsAt !== null) return t('access.limitUntil', { when: shortWhen(access.resetsAt, t, now) })
    if (access.resetText) return t('access.limitUntil', { when: access.resetText })
    return t('access.limit')
  }
  if (access.kind === 'expired') {
    return profileTitle ? t('access.expiredProfile', { profile: profileTitle }) : t('access.expired')
  }
  return profileTitle ? t('access.loggedOutProfile', { profile: profileTitle }) : t('access.loggedOut')
}

/** Stable identity of a lost-access state (kept in lost-access.json). */
export function lostAccessSignature(access: LostAccess): string {
  return `${access.kind}:${access.resetsAt ?? access.resetText ?? ''}:${access.at}`
}
