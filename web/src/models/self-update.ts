// Settings → Updates… (#617) as the page has it: GET /api/self-update's view read with a guard, and
// the lines worked out of it. The rules are the board's (src/core/self-update.ts); the page shows them.
import type { AutoUpdateConfig, UpdateRecord, UpdateState } from '../../../src/core/self-update.ts'
import type { Translator } from '../../../src/core/types.ts'
import { shortWhen } from '../../../src/core/when-format.ts'

export interface UpdatesView {
  config: AutoUpdateConfig
  state: UpdateState
  /** How the updates stand, in the board's language; null while off with nothing done. */
  standing: { level: 'ok' | 'warn' | 'error'; text: string } | null
  /** The checkout's branch (null: a detached HEAD) and commit; null: not a git checkout. */
  checkout: { branch: string | null; commit: string } | null
  node: boolean
  masterId?: string
  canRestart: boolean
  running: boolean
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function isUpdatesView(v: unknown): v is UpdatesView {
  return (
    isObject(v) &&
    isObject(v.config) &&
    typeof v.config.on === 'boolean' &&
    isObject(v.state) &&
    (v.standing === null || isObject(v.standing)) &&
    (v.checkout === null || isObject(v.checkout)) &&
    typeof v.node === 'boolean' &&
    (v.masterId === undefined || typeof v.masterId === 'string')
  )
}

/** Where the checkout is: its branch and commit, or why there is none to update. */
export function whereLine(v: UpdatesView, t: Translator): string {
  if (v.node) return t('selfUpdate.nodeNote')
  if (!v.checkout) return t('selfUpdate.noCheckout')
  return t('selfUpdate.on', { branch: v.checkout.branch ?? 'HEAD', commit: v.checkout.commit.slice(0, 8) })
}

/** "Last check 5 min ago", or null before the first. */
export function lastCheckLine(s: UpdateState, t: Translator, now = Date.now()): string | null {
  return s.last ? t('selfUpdate.lastCheck', { when: shortWhen(s.last.at, t, now) }) : null
}

/** What came in with the last update: its heading and titles; null before the first. */
export function cameIn(s: UpdateState, t: Translator, now = Date.now()): { head: string; titles: string[] } | null {
  const u: UpdateRecord | undefined = s.lastUpdate
  if (!u) return null
  return { head: t('selfUpdate.came', { when: shortWhen(u.at, t, now) }), titles: u.came ?? [] }
}
