// The master's side of the feature flags (#775, core/master-flags.ts): which of its master-owned
// features are on, as its own readers take its config.json, for its nodes. Sent over the relay's link
// (services/nodes/master-relay.ts) when the stream opens and whenever config.json changes.
import { calendarConfig } from '../../core/calendar.ts'
import { decisionsConfig } from '../../core/decisions.ts'
import { journalConfig } from '../../core/journal.ts'
import type { MasterFlagKey, MasterFlagsWire } from '../../core/master-flags.ts'
import { presenceConfig } from '../../core/presence.ts'
import { remoteConfig } from '../../core/remote.ts'
import { teamConfig } from '../../core/team.ts'
import { timeConfig } from '../../core/time.ts'
import { todosConfig } from '../../core/todos.ts'
import { tunnelConfig } from '../../core/tunnel.ts'
import type { Config } from '../../core/types.ts'
import { watchesConfig } from '../../core/watches.ts'
import { threadsConfig } from '../../core/work-threads.ts'
import { workdeskConfig } from '../../core/workdesk.ts'

/** The master's flags: names and switches only, never a section's own values (hubs, keys, sources). */
export function masterFlagsFor(cfg: Config, master: string): MasterFlagsWire {
  const raw = cfg as unknown as Record<string, unknown>
  const threads = threadsConfig(raw.threads)
  const todos = todosConfig(raw.todos)
  const decisions = decisionsConfig(raw.decisions)
  const on: Record<MasterFlagKey, boolean> = {
    threads: threads !== null,
    time: timeConfig(raw.time) !== null,
    calendar: calendarConfig(raw.calendar) !== null,
    decisions: decisions !== null,
    journal: journalConfig(raw.journal) !== null,
    presence: presenceConfig(raw.presence) !== null,
    team: teamConfig(raw.team) !== null,
    watches: watchesConfig(raw.watches) !== null,
    todos: todos !== null,
    workdesk: workdeskConfig(raw.workdesk) !== null,
    remote: remoteConfig(raw.remote).on,
    tunnel: tunnelConfig(raw.tunnel).on,
  }
  return {
    master,
    on: (Object.keys(on) as MasterFlagKey[]).filter(k => on[k]),
    ...(threads && { threads: { agents: threads.agents, ...(threads.cases && { cases: true as const }) } }),
    ...(todos && { todos: { agents: todos.agents, ...(todos.autoClose && { autoClose: true as const }) } }),
    ...(decisions && { decisions: { defaults: decisions.defaults } }),
  }
}
