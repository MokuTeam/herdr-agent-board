// New sessions: what the window offers, starting one, and its tab, folder trust and failure.
// They start programs: a browser must also say the request comes from this page (origin). main
// read the body before it looked at the data's age, so those routes check fresh-data after it.
import type { Item } from '../../core/types.ts'
import type { Launches } from '../../services/launch/launches.ts'
import { json, type Route } from '../http.ts'

export function launchRoutes(launches: Launches, items: () => Item[]): Route[] {
  const guard: Route['guard'] = ['board-header', 'origin']
  return [
    { method: 'GET', path: '/api/launch/options', handle: async () => json(200, await launches.options()) },
    {
      method: 'POST',
      path: '/api/launch',
      guard,
      async handle(_req, ctx) {
        const body = await ctx.body()
        const refused = ctx.refuse('fresh-data')
        if (refused) return refused
        const r = await launches.start(body, items())
        return json(r.ok ? 200 : 400, r)
      },
    },
    {
      method: 'POST',
      path: /^\/api\/launch\/([\w-]+)\/dismiss$/,
      guard,
      async handle(_req, ctx) {
        await ctx.body()
        const r = launches.dismiss(ctx.params[0] ?? '')
        return json(r.ok ? 200 : 404, r)
      },
    },
    // Going to its tab, trusting its folder, closing its tab: all through herdr.
    {
      method: 'POST',
      path: /^\/api\/launch\/([\w-]+)\/(focus|trust|close)$/,
      guard,
      async handle(_req, ctx) {
        await ctx.body()
        const refused = ctx.refuse('fresh-data')
        if (refused) return refused
        const [id = '', what] = ctx.params
        const r = await (what === 'focus'
          ? launches.focus(id)
          : what === 'trust'
            ? launches.trust(id)
            : launches.closeTab(id))
        return json(r.ok ? 200 : 409, r)
      },
    },
    // Anything else that starts with /api/launch, /api/launcher included.
    {
      method: 'POST',
      path: /^\/api\/launch/,
      guard,
      async handle(_req, ctx) {
        await ctx.body()
        return json(404, { error: 'not found' })
      },
    },
  ]
}
