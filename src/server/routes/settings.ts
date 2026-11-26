// Settings, categories and profiles, written to config.json; the config watcher reloads it,
// switches the language and pushes the new board. And Install into one profile's settings.json.
import { type EditResult, editCategories, editFeatures, editSettings } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { t } from '../../core/lang.ts'
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

/**
 * Before and after the schedule's route, as main had them. The limits on agent starts (#815) are
 * written on this computer only: through a remote listener (a paired device, the owner's login) an
 * edit that names them is refused, the rest of the body with it.
 */
export const settingsRoute = (): Route => ({
  method: 'POST',
  path: '/api/settings',
  guard: ['board-header'],
  async handle(_req, ctx) {
    const body = await ctx.rawBody()
    if (ctx.remote && isRecord(body) && body.spawnLimits !== undefined)
      return json(403, { ok: false, error: t('err.spawnLimitsLocal') })
    const r = editSettings(body)
    return json(r.ok ? 200 : 409, r)
  },
})
export const categoriesRoute = (): Route => edit('/api/categories', editCategories)
/**
 * Settings → Watches, Decisions and Away journal (#596), { watches?, decisions?, decisionsDefaults?,
 * journal? } (editFeatures). On this computer only (core/remote.ts localOnly), as Settings → Threads,
 * and its refusals answer 400 as that one's do.
 */
export const featureSettingsRoute = (): Route => ({
  method: 'POST',
  path: '/api/feature-settings',
  guard: ['board-header'],
  // A refusal answers 400, as Settings → Threads' does.
  async handle(_req, ctx) {
    const r = editFeatures(await ctx.rawBody())
    return json(r.ok ? 200 : 400, r)
  },
})
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
