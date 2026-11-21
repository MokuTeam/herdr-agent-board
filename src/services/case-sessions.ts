// Where the sessions of a case are now (#488, services/work-cases.ts CaseResolvers), as the board
// sees them: on the board and up or asleep (its items, which ask herdr and wake), in the archive (its
// record), or gone; a node's session by the master's card of it, else not known here (never gone);
// and their open reminders, from the schedule and those parked with an archived
// session. Used by the `board` command and spawn-agent; the server reads its own items.
import { getArchived } from '../adapters/archive-store.ts'
import { listEntries } from '../adapters/schedule-store.ts'
import { parseNodeKey } from '../core/node-key.ts'
import type { DeviceView } from '../core/nodes.ts'
import type { ScheduleEntry } from '../core/schedule-rules.ts'
import type { Item } from '../core/types.ts'
import type { CaseReminder, SessionLive } from '../core/work-cases.ts'
import type { CaseResolvers } from './work-cases.ts'

/** The board's items as far as a case needs them. */
export type Known = Pick<Item, 'key' | 'name' | 'cwd'> & {
  session?: string | null
  sleeping?: boolean
  autoName?: string
  /** A node's card while the master does not hear the node: when its copy is from, null when not known. */
  seenAt?: number | null
}

/** A device as the master's payload lists it, as far as whether it is heard now. */
type Heard = Pick<DeviceView, 'id' | 'kind' | 'link' | 'payloadAt'>

/**
 * The cards a master reads a case's sessions from: its own, then the nodes' (services/nodes/aggregate.ts
 * part). A node's card of a device it does not hear now (its link not online, or not listed) is its
 * offline copy: it carries when that copy is from (the last payload, else the last byte the link
 * heard), so it is never read as up now.
 */
export function caseItems(
  own: readonly Known[],
  part: { items: readonly (Known & { device?: string | null })[]; devices: readonly Heard[] } | null,
): Known[] {
  if (!part) return [...own]
  const heard = new Map(part.devices.map(d => [d.id, d]))
  const remote = part.items.map(it => {
    const d = it.device ? heard.get(it.device) : undefined
    if (d && (d.kind === null || d.link?.state === 'online')) return it
    return { ...it, seenAt: d?.payloadAt ?? d?.link?.heardAt ?? null }
  })
  return [...own, ...remote]
}

/** What the board knows of these sessions now; without items (herdr not answering) a session not archived is unknown. */
export function liveOf(keys: readonly string[], items: readonly Known[] | null): Map<string, SessionLive> {
  const out = new Map<string, SessionLive>()
  for (const key of keys) {
    // A node's session (#508): the master knows it by its card in the nodes' items, when it has them.
    const device = parseNodeKey(key)?.device
    const it = items?.find(i => i.key === key || i.session === key)
    // A node's card from its offline copy: what it was then, with when; with no time, not known.
    if (it && device && it.seenAt === null) {
      out.set(key, { state: 'unknown', device })
      continue
    }
    if (it) {
      const name = it.name || it.autoName || ''
      out.set(key, {
        state: it.sleeping ? 'asleep' : 'up',
        ...(device && typeof it.seenAt === 'number' && { seenAt: it.seenAt }),
        ...(name && { name }),
        ...(it.cwd && { cwd: it.cwd }),
        ...(device && { device }),
      })
      continue
    }
    // Not among them: not known here, which is not gone (the node may be off line, or this is no master).
    if (device) {
      out.set(key, { state: 'unknown', device })
      continue
    }
    const rec = getArchived(key)
    if (rec && rec.state !== 'restoring') {
      out.set(key, {
        state: 'archived',
        ...(rec.name && { name: rec.name }),
        ...(rec.cwd && { cwd: rec.cwd }),
      })
      continue
    }
    out.set(key, { state: items ? 'gone' : 'unknown' })
  }
  return out
}

/** A schedule entry that is a reminder of the session's own (not a thread or team notice, a sleep or a restart). */
const isReminder = (e: Pick<ScheduleEntry, 'by' | 'kind'>): boolean =>
  e.by !== 'threads' && e.by !== 'team' && e.by !== 'asks' && e.kind !== 'sleep' && e.kind !== 'restart'

const reminderOf = (e: ScheduleEntry, parked: boolean): CaseReminder => ({
  session: e.key,
  id: e.id,
  next: e.next,
  text: e.text ?? '',
  ...(e.cron && { cron: e.cron }),
  ...(parked && { parked: true }),
})

/** The open reminders of these sessions: in the schedule, and parked with one in the archive. */
export function remindersOf(keys: readonly string[]): CaseReminder[] {
  const set = new Set(keys)
  const out = listEntries()
    .filter(e => set.has(e.key) && isReminder(e))
    .map(e => reminderOf(e, false))
  for (const key of keys) for (const e of getArchived(key)?.held ?? []) if (isReminder(e)) out.push(reminderOf(e, true))
  return out
}

/** The names of these sessions, lowercased, as `board thread` and messages find a session by name. */
export const namesOf = (items: readonly Known[]): Set<string> =>
  new Set(items.flatMap(i => [i.name, i.autoName].filter((n): n is string => !!n).map(n => n.toLowerCase())))

/** The resolvers for a command: the board's items asked for once, and only when a case has sessions. */
export function boardResolvers(items: () => Promise<readonly Known[]>): CaseResolvers {
  return {
    live: async keys => liveOf(keys, await items().catch(() => null)),
    reminders: keys => remindersOf(keys),
    names: async () => namesOf(await items().catch(() => [])),
  }
}
