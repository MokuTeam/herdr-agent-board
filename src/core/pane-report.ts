// What herdr's panes hold, for `board doctor` (#243): how many run an agent, sleep in their pane,
// are herdr-sidebar's or something else, with the memory their processes take, and how many of the
// sidebars and the others are a bare shell (nothing runs in front of it): a sidebar pane herdr
// restored after it started over without its sidebar, a terminal left open. A laptop that gathers
// idle shells shows it here without a count by hand.
//
// Panes labelled asleep that wake has no record of are named on their own: wake neither wakes them
// nor gives their pane back (a record dropped, as the takeover from herdr-wake drops one older than
// 7 days). Only while the board's wake runs (or is starting): the herdr-wake plugin labels its
// sleepers the same way and keeps its records elsewhere, and while it holds the line, or the board's
// wake is off, crashed or not answering, wake's records say nothing of what is asleep now.
//
// Pure: adapters/pane-facts.ts reads herdr, the process table and wake's files.
import type { SetupCheck } from './setup.ts'
import type { Translator } from './types.ts'
import { isSidebar } from './wake/freed.ts'
import type { WakeState } from './wake/status.ts'

/** Whether wake's records say what is asleep now: the board's wake runs, or is starting. */
export const wakeKeepsSleepers = (state: WakeState | undefined): boolean => state === 'running' || state === 'starting'

/** What a pane holds: only its shell (null: herdr did not say), and its processes' memory in bytes (null: not read). */
export interface PaneHeld {
  bare: boolean | null
  bytes: number | null
}

export interface PaneFacts {
  panes: readonly { pane_id: string; agent?: string; label?: string; tokens?: Record<string, unknown> }[]
  /** By pane id. */
  held: ReadonlyMap<string, PaneHeld>
  /** The panes wake keeps a sleeper in (its and pi's records); null unless the board's wake runs (wakeKeepsSleepers). */
  sleepers: ReadonlySet<string> | null
}

/** A pane wake labels asleep: `💤 <name>`. */
const ASLEEP = /^💤\s/

const GB = 2 ** 30
const MB = 2 ** 20

/** Bytes as a reader takes them in: GB with one decimal from 1 GB, else whole MB; '?' when none was read. */
function amount(bytes: number | null, t: Translator): string {
  if (bytes === null) return '?'
  return bytes >= GB
    ? t('setup.panes.gb', { n: (bytes / GB).toFixed(1) })
    : t('setup.panes.mb', { n: Math.round(bytes / MB) })
}

/** A group's count, the memory of the panes whose memory was read (null when none was), and how many are a bare shell. */
interface Group {
  n: number
  bytes: number | null
  bare: number
  bareBytes: number | null
}

const add = (sum: number | null, bytes: number | null): number | null => (bytes === null ? sum : (sum ?? 0) + bytes)

/** The checks: what the panes hold, and the panes labelled asleep that wake does not know, if any. */
export function paneChecks(f: PaneFacts, t: Translator): SetupCheck[] {
  const groups: Record<'agents' | 'asleep' | 'sidebars' | 'other', Group> = {
    agents: { n: 0, bytes: null, bare: 0, bareBytes: null },
    asleep: { n: 0, bytes: null, bare: 0, bareBytes: null },
    sidebars: { n: 0, bytes: null, bare: 0, bareBytes: null },
    other: { n: 0, bytes: null, bare: 0, bareBytes: null },
  }
  let total: number | null = null
  const unknown: string[] = []
  for (const p of f.panes) {
    const held = f.held.get(p.pane_id) ?? { bare: null, bytes: null }
    const asleep = !p.agent && ASLEEP.test(p.label ?? '')
    const g = groups[p.agent ? 'agents' : asleep ? 'asleep' : isSidebar(p) ? 'sidebars' : 'other']
    g.n++
    g.bytes = add(g.bytes, held.bytes)
    if (held.bare) {
      g.bare++
      g.bareBytes = add(g.bareBytes, held.bytes)
    }
    total = add(total, held.bytes)
    if (asleep && f.sleepers && !f.sleepers.has(p.pane_id)) unknown.push(`${p.label} (${p.pane_id})`)
  }
  const { agents, asleep, sidebars, other } = groups
  const parts = [
    t('setup.panes.agents', { n: agents.n, mem: amount(agents.bytes, t) }),
    t('setup.panes.asleep', { n: asleep.n, mem: amount(asleep.bytes, t) }),
    t(sidebars.bare ? 'setup.panes.sidebarsBare' : 'setup.panes.sidebars', {
      n: sidebars.n,
      mem: amount(sidebars.bytes, t),
      bare: sidebars.bare,
      bareMem: amount(sidebars.bareBytes, t),
    }),
    t(other.bare ? 'setup.panes.otherBare' : 'setup.panes.other', {
      n: other.n,
      mem: amount(other.bytes, t),
      bare: other.bare,
    }),
  ]
  const checks: SetupCheck[] = [
    {
      id: 'panes',
      level: 'ok',
      title: t('setup.panes.title'),
      detail: `${t('setup.panes.total', { n: f.panes.length, mem: amount(total, t) })}: ${parts.join(' · ')}`,
      fix: '',
      code: '',
    },
  ]
  if (unknown.length)
    checks.push({
      id: 'panes-unknown',
      level: 'warn',
      title: t('setup.panes.unknown', { n: unknown.length }),
      detail: unknown.join(', '),
      fix: t('setup.panes.unknownFix'),
      code: '',
    })
  return checks
}
