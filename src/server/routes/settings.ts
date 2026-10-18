// Settings, categories and profiles, written to config.json; the config watcher reloads it,
// switches the language and pushes the new board.
import { type EditResult, editCategories, editProfiles, editSettings } from '../../adapters/config-file.ts'
import { json, type Route } from '../http.ts'

// The edits take any body (main's read it with ?.), a null one included.
const edit = (path: string, change: (body: unknown) => EditResult): Route => ({
  method: 'POST',
  path,
  guard: ['board-header'],
  async handle(_req, ctx) {
    const r = change(await ctx.rawBody())
    return json(r.ok ? 200 : 409, r)
  },
})

/** Before and after the schedule's route, as main had them. */
export const settingsRoute = (): Route => edit('/api/settings', editSettings)
export const categoriesRoute = (): Route => edit('/api/categories', editCategories)
/** The Profiles panel's renames, colors, show/hide and folders added (this computer's home folder). */
export const profilesRoute = (): Route => edit('/api/profiles', body => editProfiles(body))
