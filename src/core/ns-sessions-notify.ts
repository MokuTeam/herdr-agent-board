// Per-account notification preferences and once-per-death notice planning (#897, core/ns-sessions.ts):
// metadata only, never a cookie value. Accounts without auto-renew (`auto_renew === false`) default
// to notify ON; an explicit owner toggle overrides any account.
import type { NsMeta } from './ns-sessions.ts'
import { nsAccount } from './ns-sessions.ts'
import type { Translator } from './types.ts'

export interface NsNotifyPrefs {
  accounts: Record<string, boolean>
}

export const NO_NS_NOTIFY_PREFS: NsNotifyPrefs = { accounts: {} }
export const NS_NOTIFY_MAX_ACCOUNTS = 500

export interface NsNotice {
  id: string
  key: string
  account: string
  user: string | null
  state: 'dying' | 'dead'
  endsAt: number
  title: string
  body: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validates persisted notification preferences field by field. */
export function isNsNotifyPrefs(v: unknown): v is NsNotifyPrefs {
  if (!isRecord(v) || !isRecord(v.accounts)) return false
  const entries = Object.entries(v.accounts)
  if (entries.length > NS_NOTIFY_MAX_ACCOUNTS) return false
  return entries.every(([k, val]) => nsAccount(k) === k && typeof val === 'boolean')
}

/** Whether notifications should fire for `account`: explicit owner setting, else on when `autoRenew === false`. */
export function shouldNotifyAccount(account: string, autoRenew: boolean | null, prefs: NsNotifyPrefs): boolean {
  if (Object.hasOwn(prefs.accounts, account)) return prefs.accounts[account] === true
  return autoRenew === false
}

/** Returns updated preferences with `account` set to `value` (or removed to restore default when `null`). */
export function setAccountNotify(prefs: NsNotifyPrefs, account: string, value: boolean | null): NsNotifyPrefs {
  const next: Record<string, boolean> = { ...prefs.accounts }
  if (value === null) {
    delete next[account]
    return { accounts: next }
  }
  if (!Object.hasOwn(next, account) && Object.keys(next).length >= NS_NOTIFY_MAX_ACCOUNTS) {
    const oldest = Object.keys(next)[0]
    if (oldest !== undefined) delete next[oldest]
  }
  next[account] = value
  return { accounts: next }
}

/** Deduplication key for one session lifetime: `dying -> dead` keeps the same `fp`, so it fires once. */
export const nsNoticeKey = (e: Pick<NsMeta, 'account' | 'user' | 'fp'>): string =>
  `${e.account}\u0000${e.user ?? ''}\u0000${e.fp}`

/** Formats the title and body for a dying or dead NetSuite session notice. */
export function formatNsNotice(
  e: Pick<NsMeta, 'account' | 'user' | 'state' | 'abs_expiry' | 'idle_expiry' | 'dead_at' | 'abs_expiry_estimated'>,
  zone: string,
  t: Translator,
): { title: string; body: string; endsAt: number } {
  const endsAt =
    e.state === 'dead' ? (e.dead_at ?? Math.min(e.abs_expiry, e.idle_expiry)) : Math.min(e.abs_expiry, e.idle_expiry)
  const time = new Intl.DateTimeFormat(t.lang === 'ru' ? 'ru-RU' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: zone,
  }).format(endsAt)
  const title = t('ns.notice.title', { account: e.account })
  const dyingAbout = e.state === 'dying' && e.abs_expiry_estimated && e.abs_expiry <= e.idle_expiry
  const body =
    e.state === 'dead'
      ? t('ns.notice.dead', { account: e.account, time })
      : t(dyingAbout ? 'ns.notice.dyingAbout' : 'ns.notice.dying', { account: e.account, time })
  return { title, body, endsAt }
}

/** Plans notices for entries that are dying or dead and have not yet notified for their current `fp`. */
export function planNsNotices(
  entries: readonly NsMeta[],
  prefs: NsNotifyPrefs,
  notified: ReadonlySet<string>,
  zone: string,
  t: Translator,
): { notices: NsNotice[]; activeKeys: Set<string> } {
  const notices: NsNotice[] = []
  const activeKeys = new Set<string>()
  for (const e of entries) {
    const key = nsNoticeKey(e)
    activeKeys.add(key)
    if (e.state !== 'dying' && e.state !== 'dead') continue
    if (notified.has(key)) continue
    if (!shouldNotifyAccount(e.account, e.auto_renew, prefs)) continue
    const { title, body, endsAt } = formatNsNotice(e, zone, t)
    const slug = e.account.toLowerCase().replace(/[^a-z0-9_]/g, '')
    notices.push({
      id: `ns-${slug}-${e.fp}`,
      key,
      account: e.account,
      user: e.user,
      state: e.state,
      endsAt,
      title,
      body,
    })
  }
  return { notices, activeKeys }
}
