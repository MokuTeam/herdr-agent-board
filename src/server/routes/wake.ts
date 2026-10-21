// Settings → Sleep and wake… (#119): wake's state and settings, its switches, Start, Start again,
// Log and Switch over… (services/wake/control.ts), Install claude-tg (adapters/launchers.ts), and
// the note of what the takeover at wake's first start did, seen (adapters/wake-files.ts). For the board
// on this computer only: every remote listener refuses these routes (core/remote.ts localOnly);
// a phone reads the state line in the payload.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type EditResult, editWake } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { installLaunchers } from '../../adapters/launchers.ts'
import { wakeTakeoverSeen } from '../../adapters/wake-files.ts'
import { t } from '../../core/lang.ts'
import type { WakeControl } from '../../services/wake/control.ts'
import { json, type Route } from '../http.ts'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** claude-tg into ~/.local/bin, beside `board`: the folder, or why not (someone else's is never written over). */
function launcher(): Response {
  const dir = join(homedir(), '.local', 'bin')
  try {
    const { foreign } = installLaunchers(dir, { onlyWhereThere: false })
    if (foreign.length) return json(409, { ok: false, error: t('err.launcherForeign', { files: foreign.join(', ') }) })
    return json(200, { ok: true, dir })
  } catch (err) {
    return json(409, { ok: false, error: messageOf(err) })
  }
}

/** The reaper's fields the panel sends, those it sent only. */
function reaperOf(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(['enabled', 'idleMinutes', 'exclude'].filter(k => k in body).map(k => [k, body[k]]))
}

export function wakeRoutes(wake: WakeControl): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/wake',
      async handle() {
        const [view, settings] = await Promise.all([wake.view(), wake.settings()])
        return json(200, { view, settings })
      },
    },
    {
      // { op: 'on' | 'off' | 'reaper' | 'telegram' | 'start' | 'again' | 'log' | 'launcher' | 'switch' | 'seen', … }:
      // they change config.json, start programs, write claude-tg and (Switch over…) uninstall the
      // separate herdr-wake plugin and move its hooks, so a page of another origin is refused, as
      // for Install.
      method: 'POST',
      path: '/api/wake',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        let r: EditResult
        switch (body.op) {
          case 'on':
          case 'off':
            r = await wake.turn(body.op === 'on')
            break
          case 'reaper':
            r = editWake({ reaper: reaperOf(body) })
            break
          case 'telegram':
            r = editWake({ telegram: body.mode ?? null })
            break
          case 'start':
            r = await wake.start()
            break
          case 'again':
            r = await wake.again()
            break
          case 'log':
            return json(200, { ok: true, text: wake.logTail() })
          case 'launcher':
            return launcher()
          case 'switch': {
            const switched = await wake.switchOver()
            return json(switched.ok ? 200 : 409, switched)
          }
          case 'seen':
            // The panel showed what the takeover at wake's first start did: not said again.
            try {
              wakeTakeoverSeen()
              r = { ok: true }
            } catch (err) {
              r = { ok: false, error: messageOf(err) }
            }
            break
          default:
            r = { ok: false, error: `unknown op ${String(body.op)}` }
        }
        return json(r.ok ? 200 : 409, r)
      },
    },
  ]
}
