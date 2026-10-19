// The board's data: the latest payload, and the event stream that pushes each new one.
import type { BoardState } from '../board-state.ts'
import { jsonText, type Route } from '../http.ts'
import type { Broadcaster } from '../sse.ts'

export function boardRoutes(board: Pick<BoardState, 'payload'>, events: Broadcaster): Route[] {
  return [
    { method: 'GET', path: '/api/board', handle: () => jsonText(board.payload()) },
    { method: 'GET', path: '/api/events', handle: req => events.response(req) },
  ]
}
