// Settings → MokuPilot…: where a call starts (core/mokupilot-mode.ts). GET says the mode, whether
// MokuPilot is found on this computer, and where a call by the browser that asks would start now
// (under `auto` and under the mode set), with the branch that decided; POST { mode } saves it to
// config.json (adapters/config-file.ts editMokupilot), which the config watcher picks up.
import { editMokupilot } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { mokupilotCommand } from '../../adapters/setup-facts.ts'
import { mokupilotMode, resolveMode } from '../../core/mokupilot-mode.ts'
import type { Config } from '../../core/types.ts'
import { ownAddresses } from '../../services/tunnel.ts'
import { json, type Route } from '../http.ts'

export interface MokupilotRouteOptions {
  /** This computer's own addresses; services/tunnel.ts ownAddresses by default. */
  own?: () => readonly string[]
  /** How the board would start MokuPilot here; adapters/setup-facts.ts mokupilotCommand by default. */
  find?: (cfg: Partial<Config>) => { state: string; file?: string }
}

export function mokupilotRoutes(
  cfg: Partial<Config>,
  { own = ownAddresses, find = c => mokupilotCommand(c) }: MokupilotRouteOptions = {},
): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/mokupilot',
      handle(req, ctx) {
        const set = cfg.mokupilot
        const mode = mokupilotMode(set)
        const viewer = { peer: ctx.peer(), forwardedFor: req.headers.get('x-forwarded-for') }
        const addresses = own()
        const auto = resolveMode('auto', viewer, addresses)
        const now = resolveMode(mode, viewer, addresses)
        // MokuPilot on this computer, whatever the mode: what `local` would start.
        const here = find({ ...cfg, mokupilot: { ...(isRecord(set) ? set : {}), mode: 'local' } })
        return json(200, {
          ok: true,
          mode,
          off: set === false,
          here: here.state === 'ok' ? 'ok' : 'missing',
          ...(here.file && { hereFile: here.file }),
          resolved: now.resolved,
          why: now.why,
          auto: { resolved: auto.resolved, why: auto.why, viewer: auto.viewer ?? '' },
        })
      },
    },
    {
      method: 'POST',
      path: '/api/mokupilot',
      // It decides whether the board starts a program here: only from this board's own page.
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const r = editMokupilot(await ctx.rawBody())
        return json(r.ok ? 200 : 409, r)
      },
    },
  ]
}
