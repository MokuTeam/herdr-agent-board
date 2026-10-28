// Settings → Backup… (#233, services/backup.ts and services/backup-server.ts): the panel's view, and
// what it changes: the passphrase, the folder, the server's fields, Look, Apply, Undo, "Do it
// myself", Test and Back up now. For the board on this computer only: every remote listener refuses
// /api/backup (core/remote.ts localOnly), since it sets up the owner's server with the admin's
// login; the board everywhere sees the backup's line in the payload.
import { folderProblem } from '../../adapters/backup-store.ts'
import { editBackup, loadConfig } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { isTarget, problemSentence } from '../../core/backup.ts'
import { t } from '../../core/lang.ts'
import { adminConfig } from '../../core/server-admin.ts'
import { tunnelConfig } from '../../core/tunnel.ts'
import type { Config } from '../../core/types.ts'
import { backupView, resetTarget, setPassphrase, testTarget } from '../../services/backup.ts'
import type { BackupServer } from '../../services/backup-server.ts'
import { json, type Route } from '../http.ts'

export interface BackupApp {
  cfg: Config
  server: BackupServer
  /** A backup now, every active target (the web board's schedule, one at a time). */
  now(): Promise<{
    sent: { target: string; name: string }[]
    failed: { target: string; error: string }[]
    nothing?: true
  }>
  /** The view changed: the board's line goes out again. */
  changed(): void
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)

export function backupRoutes(app: BackupApp): Route[] {
  // config.json as it is now: the live config follows a change a moment later (its watcher), and
  // the answer to a change, or a Test right after it, must already see it
  const fresh = (): Config => ({ ...app.cfg, backup: loadConfig().backup })
  const view = () => {
    const v = backupView(fresh())
    // a server not set yet starts from the tunnel's: the same host and admin, most of the time
    const tunnel = tunnelConfig(app.cfg.tunnel)
    const admin = adminConfig(isRecord(app.cfg.tunnel) ? app.cfg.tunnel.admin : undefined)
    const suggest = tunnel.host
      ? { host: tunnel.host, port: tunnel.sshPort, adminUser: admin.user, adminKey: admin.key }
      : null
    return { ...v, suggest, problems: v.problems.map(p => ({ kind: p.kind, text: problemSentence(p, t) })) }
  }
  return [
    { method: 'GET', path: '/api/backup', handle: async () => json(200, view()) },
    {
      method: 'POST',
      path: '/api/backup',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const raw = await ctx.rawBody()
        const b = isRecord(raw) ? raw : {}
        const sudo = text(b.sudoPassword) || null
        const done = (body: Record<string, unknown>) => {
          app.changed()
          return json(body.ok === false ? 400 : 200, { ...body, view: view() })
        }
        switch (b.op) {
          case 'passphrase': {
            const r = await setPassphrase(text(b.passphrase) ?? '', text(b.again) ?? '')
            return done(r)
          }
          case 'folder': {
            const folder = text(b.folder)?.trim() ?? ''
            if (folder) {
              const problem = folderProblem(folder)
              if (problem) return done({ ok: false, error: t(problem, { folder }) })
            }
            const r = editBackup({ folder: folder || null })
            if (r.ok) resetTarget('folder')
            return done(r)
          }
          case 'server': {
            if (b.remove === true) {
              const r = editBackup({ server: null })
              if (r.ok) resetTarget('server')
              return done(r)
            }
            return done(
              editBackup({ server: { host: b.host, port: b.port, adminUser: b.adminUser, adminKey: b.adminKey } }),
            )
          }
          case 'test': {
            if (!isTarget(b.target)) return json(400, { ok: false, error: t('backup.cli.usage') })
            return done({ ...(await testTarget(b.target, fresh())) })
          }
          case 'now': {
            const r = await app.now()
            return done({ ok: !r.failed.length, ...r })
          }
          case 'look':
            return done({ ...(await app.server.look(sudo)) })
          case 'apply':
            return done({ ...(await app.server.apply(sudo)) })
          case 'undo':
            return done({ ...(await app.server.undo(sudo)) })
          case 'manual':
            return done({ ...(await app.server.manual()) })
          case 'manualDone':
            return done({ ...(await app.server.confirmManual()) })
          default:
            return json(400, { ok: false, error: `unknown op ${String(b.op)}` })
        }
      },
    },
  ]
}
