// The master's devices for `board nodes` and, later, the panel (#499, docs/design/nodes 13): the
// devices in order with their links (services/nodes/links.ts), and a link tried again at once. On
// the local board only, and only while config.json's `nodes` is on: app.ts picks these routes
// for /api/nodes itself, so the board's route table, which every remote listener and a node's door
// serve, is the same as without `nodes`.
import type { NodeLinks } from '../../services/nodes/links.ts'
import { json, type Route } from '../http.ts'

export function nodesRoutes(links: NodeLinks): Route[] {
  const off = () => json(404, { error: 'nodes' })
  return [
    { method: 'GET', path: '/api/nodes', handle: () => (links.on() ? json(200, links.view()) : off()) },
    {
      method: 'POST',
      path: '/api/nodes',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        if (!links.on()) return off()
        const body = await ctx.body()
        if (body.op !== 'retry' || typeof body.id !== 'string') return json(400, { error: 'op' })
        return links.retry(body.id) ? json(200, { ok: true }) : json(404, { error: 'device' })
      },
    },
  ]
}
