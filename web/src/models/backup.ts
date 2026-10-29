// Settings → Backup… (#233) as the page has it: GET /api/backup's view read with a guard, and the
// panel's lines worked out of it (a target's state, the server's Look). The rules themselves are
// the board's (src/core/backup.ts); the page only shows them.
import type { BackupConfig, Target, TargetState } from '../../../src/core/backup.ts'
import { type BackupLook, lookIsSet, type RunOutcome } from '../../../src/core/backup-server.ts'
import type { Translator } from '../../../src/core/types.ts'
import { shortWhen } from '../../../src/core/when-format.ts'

export interface BackupPanelView {
  needed: boolean
  config: BackupConfig
  key: { made: number } | null
  states: Partial<Record<Target, TargetState>>
  problems: { kind: string; text: string }[]
  damaged: string | null
  dropKey: boolean
  /** The tunnel's server and admin, for a server not set yet; null without a tunnel. */
  suggest: { host: string; port: number; adminUser: string; adminKey: string } | null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function isBackupView(v: unknown): v is BackupPanelView {
  return (
    isObject(v) &&
    typeof v.needed === 'boolean' &&
    isObject(v.config) &&
    isObject(v.states) &&
    Array.isArray(v.problems) &&
    (v.key === null || isObject(v.key))
  )
}

/** What a POST answered beside its view: a Look, a run, a Test, "Do it myself"'s script, a backup's targets. */
export interface BackupReply {
  ok?: boolean
  error?: string
  view?: unknown
  look?: BackupLook
  run?: RunOutcome
  test?: { ok: boolean; name?: string; error?: string }
  name?: string
  file?: string
  script?: string
  sent?: { target: Target; name: string }[]
  failed?: { target: Target; error: string }[]
}

/** The toolbar note's words for the payload's short code (no error text reaches a remote page). */
export function backupNoteText(p: { kind: string; target?: string | undefined }, t: Translator): string {
  return t(`backup.short.${p.kind}`, { target: p.target ? t(`backup.target.${p.target}`) : '' })
}

/** A target's line: its last good snapshot, or nothing yet; and its last try's error. */
export function stateLine(
  s: TargetState | undefined,
  t: Translator,
  now = Date.now(),
): { line: string; error: string | null } {
  const line = s?.lastOk ? t('backup.state.ok', { when: shortWhen(s.lastOk, t, now) }) : t('backup.state.never')
  return { line, error: s?.error ? t('backup.state.error', { error: s.error }) : null }
}

/** The newest good backup over the targets, for the panel's head. */
export function lastGood(states: BackupPanelView['states']): number | null {
  let last: number | null = null
  for (const s of Object.values(states)) if (s?.lastOk && (last === null || s.lastOk > last)) last = s.lastOk
  return last
}

/** What Look found, a line each, in the order a person reads them. */
export function lookLines(l: BackupLook, t: Translator): string[] {
  const lines = [t('backup.look.ssh', { v: l.ssh || '?' }), t(`backup.look.user.${l.user}`)]
  if (lookIsSet(l)) lines.push(t('backup.look.set'))
  lines.push(t(l.include ? 'backup.look.fence.file' : 'backup.look.fence.block'))
  if (l.snapshots.count) lines.push(t('backup.look.snapshots', { n: l.snapshots.count, kb: l.snapshots.kb }))
  if (l.freeKb !== null) lines.push(t('backup.look.free', { mb: Math.floor(l.freeKb / 1024) }))
  if (l.candidate === 'ok' && l.sshdNow === 'ok') lines.push(t('backup.look.ok'))
  return lines
}
