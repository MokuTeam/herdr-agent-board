// A node's Settings for the features its master owns (#775): shown as they are on at the master
// (the payload's masterFlags), read-only, instead of this computer's own (off) values.
import type { MasterFlagsPayload } from '../../../src/core/payload.ts'
import { isPresenceMode, type PresenceMode } from '../../../src/core/presence.ts'
import type { TodoMode } from '../../../src/core/todos.ts'
import type { ThreadMode } from '../../../src/core/work-threads.ts'

export interface MasterOwnedNow {
  todos: TodoMode
  threads: ThreadMode
  threadsCases: boolean
  /** Verified done (#797); absent while threads are off there or the master does not say. */
  threadsVerify?: boolean
  /** Sharing in Team (#797); absent unless threads and Team are both on there and the master says. */
  threadsShare?: boolean
  watches: boolean
  decisions: boolean
  decisionsDefaults: boolean
  journal: boolean
  presence: PresenceMode | 'none'
}

export function masterOwnedNow(f: MasterFlagsPayload): MasterOwnedNow {
  const on = (key: string): boolean => f.on.includes(key)
  const todos: TodoMode = !on('todos')
    ? 'none'
    : f.todos?.agents === false
      ? 'mine'
      : f.todos?.autoClose
        ? 'auto'
        : 'agents'
  return {
    todos,
    threads: !on('threads') ? 'none' : f.threads?.agents === false ? 'mine' : 'agents',
    threadsCases: on('threads') && f.threads?.cases === true,
    ...(on('threads') && typeof f.threads?.verify === 'boolean' && { threadsVerify: f.threads.verify }),
    ...(on('threads') && on('team') && typeof f.threads?.share === 'boolean' && { threadsShare: f.threads.share }),
    watches: on('watches'),
    decisions: on('decisions'),
    decisionsDefaults: on('decisions') && f.decisions?.defaults !== false,
    journal: on('journal'),
    presence: !on('presence') ? 'none' : isPresenceMode(f.presenceMode) ? f.presenceMode : 'auto',
  }
}
