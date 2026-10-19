// The archive (services/archive.ts): its list, and archiving, bringing back or removing sessions,
// one or many. Archiving closes panes and Return starts sessions: like a launch, only from this
// page (origin), and through herdr only on fresh data; removing needs neither.
import { publicRecord } from '../../core/archive.ts'
import { t } from '../../core/lang.ts'
import type { Item } from '../../core/types.ts'
import {
  askArchive,
  bringBack,
  forgetArchived,
  listArchive,
  type ReturnApp,
  returningOn,
  undoMs,
} from '../../services/archive.ts'
import type { Deps } from '../../services/deps.ts'
import { json, type Route } from '../http.ts'

export interface ArchiveApp extends ReturnApp {
  deps: Deps
  find(key: string): Item | undefined
  refresh(): void
}

const OPS: ReadonlySet<unknown> = new Set(['archive', 'return', 'remove'])

type Done = Record<string, unknown> & { key: string }
type Failed = { key: string; error: string; name?: string; why?: string }

export function archiveRoutes(app: ArchiveApp): Route[] {
  const { deps } = app
  return [
    {
      method: 'GET',
      path: '/api/archive',
      handle: () =>
        json(200, {
          records: listArchive().map(r =>
            publicRecord(r, { returning: !!r.returning && returningOn(app.launches, r.returning) }),
          ),
          undoMs: undoMs(deps.cfg),
        }),
    },
    {
      method: 'POST',
      path: '/api/archive',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const body = await ctx.body()
        const keys = [...new Set((Array.isArray(body.keys) ? body.keys : []).map(String))].slice(0, 200)
        if (!OPS.has(body.op)) return json(400, { error: `unknown op ${body.op}` })
        // Archiving and bringing back go through herdr: fresh data first, as for a message.
        if (body.op !== 'remove') {
          const refused = ctx.refuse('fresh-data')
          if (refused) return refused
        }
        const grace = undoMs(deps.cfg)
        const done: Done[] = []
        const failed: Failed[] = []
        for (const key of keys) {
          if (body.op === 'archive') {
            const item = app.find(key)
            if (!item) {
              failed.push({ key, error: t('err.gone') })
              continue
            }
            const r = await askArchive(deps, item, { by: 'user', grace })
            if (r.ok) done.push({ key, name: item.name, held: r.held, closeAt: r.record.closeAt })
            else
              failed.push({
                key,
                name: item.name,
                why: r.why,
                error: t(r.why, { name: item.name, why: r.detail ?? '' }),
              })
          } else if (body.op === 'return') {
            const r = await bringBack(deps, app, key)
            if (r.ok) done.push({ key, ...r })
            else failed.push({ key, error: r.error })
          } else {
            const r = forgetArchived(key)
            if (r.ok) done.push({ key, name: r.record.name })
            else failed.push({ key, error: t('closing' in r ? 'archive.err.closing' : 'archive.err.gone') })
          }
        }
        if (body.op === 'archive' && done.length)
          deps.log(`archive: ${done.length} asked, their panes close in ${grace / 1000} s`)
        app.refresh()
        return json(done.length || !failed.length ? 200 : 409, {
          ok: !failed.length,
          done,
          failed,
          ...(failed[0] && { error: failed[0].error }),
        })
      },
    },
  ]
}
