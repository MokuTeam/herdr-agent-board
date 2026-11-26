// View model and strict runtime sanitization for the NetSuite Sessions view (#897,
// components/devices/NsSessionsSection.tsx). Accepts metadata only; any unknown property
// (including any hypothetical cookie field) is dropped on parse.
import type { NsDeadReason, NsEventKind, NsState } from '../../../src/core/ns-sessions.ts'
import type { Lang, Translator } from '../../../src/core/types.ts'

export interface NsSessionWhere {
  machine: string
  profile: string
}

export interface NsSessionLastEvent {
  kind: NsEventKind
  at: number
  where: NsSessionWhere | null
  reason?: NsDeadReason | null
}

export interface NsSessionEntry {
  account: string
  user: string | null
  host: string
  role: string | null
  fp: string
  state: NsState
  generation: number
  login_at: number
  abs_expiry: number
  idle_expiry: number
  last_activity: number
  last_where: NsSessionWhere
  origin: NsSessionWhere
  holders: string[]
  dead_at: number | null
  dead_reason: NsDeadReason | null
  auto_renew: boolean | null
  last_event: NsSessionLastEvent | null
  lock: { holder: NsSessionWhere & { run_id: string }; until: number } | null
}

export interface NsSessionsSnapshot {
  entries: NsSessionEntry[]
  notify: Record<string, boolean>
}

export interface NsSessionRowView {
  key: string
  account: string
  user: string
  userUnknown: boolean
  role: string | null
  fp: string
  state: NsState
  stateLabel: string
  deadReason: string | null
  noTotp: boolean
  lockLabel: string | null
  loginText: string
  absExpiryText: string
  idleLeftText: string
  idleLow: boolean
  lastActivityText: string
  holders: string[]
  lastEventText: string
  notifyOn: boolean
  notifyIsDefault: boolean
}

const STATES: ReadonlySet<unknown> = new Set<NsState>(['live', 'dying', 'dead'])
const DEAD_REASONS: ReadonlySet<unknown> = new Set<NsDeadReason>([
  'login_redirect',
  'import_bounced',
  'switch',
  'logout',
  'expired',
])
const EVENT_KINDS: ReadonlySet<unknown> = new Set<NsEventKind>(['published', 'imported', 'activity', 'dead', 'expired'])
const FP_RE = /^[0-9a-f]{8}$/

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function parseWhere(v: unknown): NsSessionWhere | null {
  if (!isObj(v) || typeof v.machine !== 'string' || typeof v.profile !== 'string') return null
  return { machine: v.machine, profile: v.profile }
}

function parseLastEvent(v: unknown): NsSessionLastEvent | null {
  if (!isObj(v) || !EVENT_KINDS.has(v.kind)) return null
  const at = num(v.at)
  if (at === null) return null
  return {
    kind: v.kind as NsEventKind,
    at,
    where: parseWhere(v.where),
    ...(v.reason !== undefined && { reason: DEAD_REASONS.has(v.reason) ? (v.reason as NsDeadReason) : null }),
  }
}

/** Parses one entry field-by-field, dropping any unexpected fields (never retains cookies or values). */
export function parseNsSessionEntry(raw: unknown): NsSessionEntry | null {
  if (!isObj(raw)) return null
  if (typeof raw.account !== 'string' || !raw.account) return null
  if (typeof raw.host !== 'string') return null
  if (!STATES.has(raw.state)) return null
  const fpRaw = typeof raw.fp === 'string' ? raw.fp.slice(0, 8) : ''
  if (!FP_RE.test(fpRaw)) return null
  const loginAt = num(raw.login_at)
  const absExpiry = num(raw.abs_expiry)
  const idleExpiry = num(raw.idle_expiry)
  const lastActivity = num(raw.last_activity)
  const generation = num(raw.generation)
  if (loginAt === null || absExpiry === null || idleExpiry === null || lastActivity === null || generation === null)
    return null
  const lastWhere = parseWhere(raw.last_where) ?? { machine: '', profile: '' }
  const origin = parseWhere(raw.origin) ?? { machine: '', profile: '' }
  const holders = Array.isArray(raw.holders) ? raw.holders.filter((h): h is string => typeof h === 'string') : []
  let lock: NsSessionEntry['lock'] = null
  if (isObj(raw.lock) && isObj(raw.lock.holder)) {
    const hw = parseWhere(raw.lock.holder)
    const until = num(raw.lock.until)
    if (hw && until !== null) {
      lock = {
        holder: { ...hw, run_id: typeof raw.lock.holder.run_id === 'string' ? raw.lock.holder.run_id : '' },
        until,
      }
    }
  }
  return {
    account: raw.account,
    user: typeof raw.user === 'string' ? raw.user : null,
    host: raw.host,
    role: typeof raw.role === 'string' ? raw.role : null,
    fp: fpRaw,
    state: raw.state as NsState,
    generation,
    login_at: loginAt,
    abs_expiry: absExpiry,
    idle_expiry: idleExpiry,
    last_activity: lastActivity,
    last_where: lastWhere,
    origin,
    holders,
    dead_at: num(raw.dead_at),
    dead_reason: DEAD_REASONS.has(raw.dead_reason) ? (raw.dead_reason as NsDeadReason) : null,
    auto_renew: typeof raw.auto_renew === 'boolean' ? raw.auto_renew : null,
    last_event: parseLastEvent(raw.last_event),
    lock,
  }
}

export function isNsSessionsSnapshot(raw: unknown): raw is NsSessionsSnapshot {
  if (!isObj(raw) || !Array.isArray(raw.entries)) return false
  if (raw.ok === false) return false
  return true
}

/** Sanitizes a list/SSE payload into a clean `NsSessionsSnapshot` with only known metadata fields. */
export function sanitizeNsSessionsSnapshot(raw: unknown): NsSessionsSnapshot {
  if (!isObj(raw)) return { entries: [], notify: {} }
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map(parseNsSessionEntry).filter((e): e is NsSessionEntry => e !== null)
    : []
  const notify: Record<string, boolean> = {}
  if (isObj(raw.notify)) {
    for (const [k, v] of Object.entries(raw.notify)) {
      if (typeof v === 'boolean') notify[k] = v
    }
  }
  return { entries, notify }
}

/** Formats an epoch timestamp as HH:MM in the local timezone. */
export function formatClock(ms: number, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms)
}

/** Formats a positive millisecond duration concisely (`14m`, `2h45`). */
export function formatSpan(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000))
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`
}

function formatAgo(at: number, now: number, t: Translator): string {
  const diff = Math.max(0, now - at)
  if (diff < 45_000) return t('ns.justNow')
  return t('ns.ago', { span: formatSpan(diff) })
}

function formatLeft(at: number, now: number, t: Translator): string {
  if (at <= now) return t('ns.expired')
  return t('ns.left', { span: formatSpan(at - now) })
}

function formatLastEvent(ev: NsSessionLastEvent | null, lang: Lang, t: Translator): string {
  if (!ev) return '—'
  const where = ev.where?.machine ? `${ev.where.machine}/${ev.where.profile}` : ''
  let label: string
  if (ev.kind === 'published') label = where ? t('ns.event.published', { where }) : t('ns.event.publishedUnknown')
  else if (ev.kind === 'imported') label = where ? t('ns.event.imported', { where }) : t('ns.event.importedUnknown')
  else if (ev.kind === 'activity') label = where ? t('ns.event.activity', { where }) : t('ns.event.activityUnknown')
  else if (ev.kind === 'expired') label = t('ns.event.expired')
  else {
    const reason = ev.reason ? t(`ns.dead.${ev.reason}`) : ''
    if (reason) label = where ? t('ns.event.dead', { reason, where }) : t('ns.event.deadUnknown', { reason })
    else label = where ? t('ns.event.deadPlain', { where }) : t('ns.event.deadPlainUnknown')
  }
  return `${label} · ${formatClock(ev.at, lang)}`
}

/** Builds the display model for one entry row. */
export function nsSessionRow(
  entry: NsSessionEntry,
  notifyPrefs: Readonly<Record<string, boolean>>,
  now: number,
  t: Translator,
): NsSessionRowView {
  const hasPref = Object.hasOwn(notifyPrefs, entry.account)
  const notifyOn = hasPref ? notifyPrefs[entry.account] === true : entry.auto_renew === false
  const deadReason = entry.dead_reason ? t(`ns.dead.${entry.dead_reason}`) : null
  const where = entry.last_where.machine ? `${entry.last_where.machine}/${entry.last_where.profile}` : '—'
  return {
    key: `${entry.account}\u0000${entry.user ?? ''}`,
    account: entry.account,
    user: entry.user ?? t('ns.userUnknown'),
    userUnknown: entry.user === null,
    role: entry.role,
    fp: entry.fp.slice(0, 8),
    state: entry.state,
    stateLabel: t(`ns.state.${entry.state}`),
    deadReason,
    noTotp: entry.auto_renew === false,
    lockLabel:
      entry.lock && entry.lock.until > now
        ? t('ns.lockedBy', { machine: entry.lock.holder.machine, profile: entry.lock.holder.profile })
        : null,
    loginText: `${formatClock(entry.login_at, t.lang)} (${formatAgo(entry.login_at, now, t)})`,
    absExpiryText:
      entry.state === 'dead'
        ? formatClock(entry.dead_at ?? entry.abs_expiry, t.lang)
        : `${formatClock(entry.abs_expiry, t.lang)} (${formatLeft(entry.abs_expiry, now, t)})`,
    idleLeftText: entry.state === 'dead' ? '—' : formatLeft(entry.idle_expiry, now, t),
    idleLow: entry.state === 'dying',
    lastActivityText: `${formatAgo(entry.last_activity, now, t)} · ${where}`,
    holders: entry.holders,
    lastEventText: formatLastEvent(entry.last_event, t.lang, t),
    notifyOn,
    notifyIsDefault: !hasPref,
  }
}

/** Summarizes counts by state for the section header. */
export function nsSessionCounts(entries: readonly NsSessionEntry[]): { live: number; dying: number; dead: number } {
  let live = 0
  let dying = 0
  let dead = 0
  for (const e of entries) {
    if (e.state === 'live') live++
    else if (e.state === 'dying') dying++
    else dead++
  }
  return { live, dying, dead }
}
