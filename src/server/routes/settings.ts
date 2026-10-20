// Settings, categories and profiles, written to config.json; the config watcher reloads it,
// switches the language and pushes the new board. And Install into one profile's settings.json.
import { type EditResult, editCategories, editSettings } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { type Guard, json, type Route } from '../http.ts'

// The edits take any body (main's read it with ?.), a null one included.
const edit = (
  path: string,
  change: (body: unknown) => EditResult | Promise<EditResult>,
  guard: Guard[] = ['board-header'],
): Route => ({
  method: 'POST',
  path,
  guard,
  async handle(_req, ctx) {
    const r = await change(await ctx.rawBody())
    return json(r.ok ? 200 : 409, r)
  },
})

/** Before and after the schedule's route, as main had them. */
export const settingsRoute = (): Route => edit('/api/settings', editSettings)
export const categoriesRoute = (): Route => edit('/api/categories', editCategories)
/**
 * The Profiles panel's renames, colors, show/hide and folders added (this computer's home folder),
 * by `editProfile`, which installs into a profile it shows (services/profiles.ts); { op: 'install',
 * id } puts the board's hooks, the agents' skill and herdr's own Claude hook into that profile
 * (`install`). It writes Claude's own settings.json, so a page of another origin is refused, as for
 * the launches.
 */
export const profilesRoute = (
  install: (id: string) => Promise<EditResult>,
  editProfile: (body: unknown) => Promise<EditResult>,
): Route =>
  edit(
    '/api/profiles',
    body => (isRecord(body) && body.op === 'install' ? install(String(body.id)) : editProfile(body)),
    ['board-header', 'origin'],
  )
