// The hub's admin surface (#231): HTTP and JSON on a unix socket in the hub's directory, mode
// 0600, never on the network. Whoever can open the socket may mint invites and revoke peers; the
// file's permissions are the whole of its auth.
//   POST /invites {ttl_s?, note?}   GET /invites   POST /invites/:id/revoke
//   POST /prune                     delete what is older than keep-days now, answers the counts
//   GET /peers                      POST /peers/:ref/revoke   (ref: peer id or name)
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HubDb } from './db.ts'
import type { Clock, Hub } from './hub.ts'

export const DEFAULT_DIR = join(homedir(), '.local', 'state', 'hab-hub')
export const DEFAULT_INVITE_TTL_S = 24 * 3600
export const MAX_INVITE_TTL_S = 90 * 24 * 3600

export const socketPath = (dir: string): string => join(dir, 'hub.sock')

export interface Admin {
  path: string
  stop(): void
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status })

export function startAdmin(opts: { dir: string; db: HubDb; hub: Hub; clock: Clock }): Admin {
  const { db, hub, clock } = opts
  const path = socketPath(opts.dir)
  if (existsSync(path)) unlinkSync(path)

  const handle = async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url)
    const now = clock.now()
    if (req.method === 'GET' && pathname === '/invites')
      return json(
        db.invites(now).map(i => ({
          id: i.id,
          note: i.note,
          state: i.state,
          created_at: i.created_at,
          expires_at: i.expires_at,
          used_by: i.used_by,
        })),
      )
    if (req.method === 'POST' && pathname === '/invites') {
      const b = (await req.json().catch(() => ({}))) as { ttl_s?: unknown; note?: unknown }
      const ttl = b.ttl_s === undefined ? DEFAULT_INVITE_TTL_S : b.ttl_s
      if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > MAX_INVITE_TTL_S)
        return json({ error: 'ttl_s must be 1..7776000' }, 400)
      if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 200))
        return json({ error: 'note' }, 400)
      const inv = db.createInvite(now, ttl * 1000, (b.note as string | undefined) ?? null)
      db.audit(now, null, 'invite_create', { id: inv.id, ttl_s: ttl })
      return json({ code: inv.code, id: inv.id, expires_at: inv.expiresAt }, 201)
    }
    const inv = /^\/invites\/([0-9a-f]{8})\/revoke$/.exec(pathname)
    if (req.method === 'POST' && inv) {
      if (!db.revokeInvite(inv[1] as string, now)) return json({ error: 'no open invite with that id' }, 404)
      db.audit(now, null, 'invite_revoke', { id: inv[1] })
      return json({ ok: true })
    }
    if (req.method === 'POST' && pathname === '/prune') return json(hub.prune())
    if (req.method === 'GET' && pathname === '/peers')
      return json(
        db.peers().map(p => ({
          id: p.id,
          name: p.name,
          status: p.status,
          online: hub.online(p.id),
          created_at: p.created_at,
          last_seen_at: p.last_seen_at,
          revoked_at: p.revoked_at,
        })),
      )
    const peer = /^\/peers\/([^/]+)\/revoke$/.exec(pathname)
    if (req.method === 'POST' && peer) {
      const row = hub.revoke(decodeURIComponent(peer[1] as string))
      return row
        ? json({ id: row.id, name: row.name, status: row.status })
        : json({ error: 'no active peer with that id or name' }, 404)
    }
    return json({ error: 'not found' }, 404)
  }

  // The socket file is born with the process's umask; make that 0600 from the start.
  const umask = process.platform === 'win32' ? undefined : process.umask(0o177)
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      unix: path,
      fetch: req => handle(req).catch(e => json({ error: e instanceof Error ? e.message : String(e) }, 500)),
    })
  } finally {
    if (umask !== undefined) process.umask(umask)
  }
  if (process.platform !== 'win32') chmodSync(path, 0o600)
  return { path, stop: () => void server.stop(true) }
}
