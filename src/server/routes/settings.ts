// Settings and categories, written to config.json; the config watcher reloads it, switches the
// language and pushes the new board.
import { type EditResult, editCategories, editSettings } from '../../adapters/config-file.ts'
import { type Body, json, type Route } from '../http.ts'

const edit = (path: string, change: (body: Body) => EditResult): Route => ({
  method: 'POST',
  path,
  guard: ['board-header'],
  async handle(_req, ctx) {
    const r = change(await ctx.body())
    return json(r.ok ? 200 : 409, r)
  },
})

/** Before and after the schedule's route, as main had them. */
export const settingsRoute = (): Route => edit('/api/settings', editSettings)
export const categoriesRoute = (): Route => edit('/api/categories', editCategories)
