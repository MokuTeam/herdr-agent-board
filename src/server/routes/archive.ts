// The archive (services/archive.ts): its list, and archiving, bringing back or removing sessions,
// one or many. Archiving closes panes and Return starts sessions: like a launch, only from this
// page (origin), and through herdr only on fresh data; removing needs neither. The entries that
// wait with a session (#295): one dropped for good, or moved to a session on the board, as
// `board unschedule <id>` and `board schedule --move <id> --session <s>` do.
import { readArchiveLog } from '../../adapters/archive-store.ts'
import { publicRecord } from '../../core/archive.ts'
import { translator } from '../../core/i18n/translator.ts'
import { t } from '../../core/lang.ts'
import type { Item } from '../../core/types.ts'
import { scheduleZone } from '../../core/when.ts'
import {
  askArchive,
  bringBack,
  closeDue,
  dropHeld,
  dueAgain,
  forgetArchived,
  getArchived,
  heldEntry,
  listArchive,
  moveHeld,
  profileDoubt,
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
      handle: () => {
        const now = Date.now()
        const zone = scheduleZone(deps.cfg.time)
        return json(200, {
          records: listArchive().map(r =>
            publicRecord(r, {
              returning: !!r.returning && returningOn(app.launches, r.returning),
              due: e => dueAgain(e, now, zone),
            }),
          ),
          undoMs: undoMs(deps.cfg),
        })
      },
    },
    {
      method: 'POST',
      path: '/api/archive/held',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const body = await ctx.body()
        if (body.op !== 'drop' && body.op !== 'move') return json(400, { error: `unknown op ${body.op}` })
        const key = String(body.key ?? '')
        const id = String(body.id ?? '').toLowerCase()
        const found = id ? heldEntry(id) : null
        if (!found || found.record.key !== key) return json(404, { ok: false, error: t('archive.err.heldGone') })
        // Return is putting its entries back right now: they go with it.
        if (found.record.state === 'restoring')
          return json(409, { ok: false, error: t('archive.err.heldReturning', { name: found.record.name }) })
        if (body.op === 'drop') {
          const [e] = dropHeld(key, id)
          if (!e) return json(404, { ok: false, error: t('archive.err.heldGone') })
          app.refresh()
          return json(200, { ok: true, id: e.id })
        }
        // To a session on the board, as the board command moves one; not to one in the archive.
        const to = app.find(String(body.to ?? ''))
        if (!to) return json(409, { ok: false, error: t('err.gone') })
        if (getArchived(to.key))
          return json(409, { ok: false, error: t('archive.err.heldArchived', { name: to.name }) })
        const zone = scheduleZone(deps.cfg.time)
        if (dueAgain(found.entry, Date.now(), zone) === null)
          return json(409, { ok: false, error: t('archive.err.heldEnded') })
        let moved: ReturnType<typeof moveHeld>
        try {
          moved = moveHeld(id, { key: to.key, name: to.name, pane: to.pane, ...(to.cwd && { cwd: to.cwd }) }, zone)
        } catch (err) {
          // What the schedule said (that session's entries full, a lock held too long), as the board command says it.
          return json(409, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
        if (!moved) return json(404, { ok: false, error: t('archive.err.heldGone') })
        deps.log(`archive: entry ${moved.id} of ${found.record.name} moved to ${to.name}`)
        app.refresh()
        return json(200, { ok: true, id: moved.id, next: moved.next, name: to.name })
      },
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
        const immediate = body.immediate === true
        const grace = immediate ? 0 : undoMs(deps.cfg)
        const tr = immediate ? translator('en') : t
        const done: Done[] = []
        const failed: Failed[] = []
        for (const key of keys) {
          if (body.op === 'archive') {
            const item = app.find(key)
            if (!item) {
              failed.push({ key, error: tr('err.gone') })
              continue
            }
            const r = await askArchive(deps, item, { by: immediate ? 'agent' : 'user', grace, tr })
            if (r.ok) {
              if (immediate) {
                const { closed } = await closeDue(deps, { keys: [key] })
                if (!getArchived(key)) {
                  const kept = readArchiveLog(20).find(e => e.key === key && e.result === 'kept')
                  const detail =
                    kept?.why === 'archive.why.profile'
                      ? (profileDoubt(item, deps.profiles(), tr) ?? kept.detail ?? '')
                      : (kept?.detail ?? '')
                  const why = kept ? tr(kept.why ?? '', { why: detail }) : 'it is not in the archive'
                  failed.push({ key, name: item.name, ...(kept?.why && { why: kept.why }), error: why })
                } else {
                  done.push({ key, name: item.name, held: r.held, closeAt: r.record.closeAt, closed })
                }
              } else {
                done.push({ key, name: item.name, held: r.held, closeAt: r.record.closeAt })
              }
            } else {
              failed.push({
                key,
                name: item.name,
                why: r.why,
                error: tr(r.why, { name: item.name, why: r.detail ?? '' }),
              })
            }
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
