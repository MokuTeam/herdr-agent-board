// The master door's own routes on a node (#498, #504, docs/design/nodes 6.2): served by the door
// (server/node-listener.ts) only, never by the board's route table, so no other listener has them.
// The door has checked the Host, the Origin, the master's token and X-Board before they run.
import type { NodeLaunchAnswer } from '../../services/node/launch.ts'
import { json, type Route } from '../http.ts'

export interface NodeDoorSources {
  /** `GET /api/node/status` (services/node/status.ts); null once `node` left config.json. */
  status(): Promise<unknown>
  /** `POST /api/node/launch` (services/node/launch.ts). */
  launch(body: unknown): Promise<NodeLaunchAnswer>
}

export function nodeDoorRoutes(o: NodeDoorSources): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/node/status',
      async handle() {
        const status = await o.status()
        // `node` went from config.json meanwhile: this door is closing.
        return status === null ? json(503, { error: 'node' }) : json(200, status)
      },
    },
    {
      method: 'POST',
      path: '/api/node/launch',
      async handle(_req, ctx) {
        const r = await o.launch(await ctx.rawBody())
        return json(r.status, r.body)
      },
    },
  ]
}
