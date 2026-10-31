// The edge log (adapters/edge-log.ts), for an audit outside the board: GET /api/links/log?since=<n>
// answers the lines numbered after n (0: from the first), at most `limit` (1 to 1000), and the
// number to ask after next time. For the board on this computer only: every remote listener
// refuses it (core/remote.ts localOnly).
import { READ_LIMIT } from '../../adapters/edge-log.ts'
import type { BoardState } from '../board-state.ts'
import { json, type Route } from '../http.ts'

/** A query's whole non-negative number, or `fallback`. */
const count = (v: string | null, fallback: number): number => (v && /^\d{1,15}$/.test(v) ? Number(v) : fallback)

export function linksRoutes(board: Pick<BoardState, 'edges'>): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/links/log',
      handle: (_req, { url }) => {
        const since = count(url.searchParams.get('since'), 0)
        const limit = Math.min(READ_LIMIT, Math.max(1, count(url.searchParams.get('limit'), READ_LIMIT)))
        return json(200, board.edges(since, limit))
      },
    },
  ]
}
