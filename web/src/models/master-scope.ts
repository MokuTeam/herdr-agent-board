// Settings → This computer / The whole board on a node's own page (#887). The whole board shows the
// master's own settings: its payload and the writes go up the relay under /api/master/
// (src/core/master-relay.ts MASTER_SCOPE), which the master answers for the owner on an owner node
// only. This computer is the default, as Settings was before; a board without nodes never offers it.
import { MASTER_SCOPE_PREFIX } from '../../../src/core/master-relay.ts'
import { onNodePage } from './master-owned.ts'

export type SettingsScope = 'here' | 'board'

/** Whether Settings offers the switch: a node's own page, not one through its remote listeners (the relay refuses those). */
export const offersBoardScope = (
  data: { masterFlags?: unknown; nodeMaster?: unknown } | null | undefined,
  remote: boolean,
): boolean => !remote && onNodePage(data)

/** A path of this board's (`/api/settings`) as the master's own under the prefix (`/api/master/settings`). */
export const masterScoped = (path: string): string =>
  path.startsWith('/api/') ? `${MASTER_SCOPE_PREFIX}${path.slice(4)}` : path

/** Where Settings writes `path` in `scope`. */
export const scopedPath = (path: string, scope: SettingsScope): string =>
  scope === 'board' ? masterScoped(path) : path
