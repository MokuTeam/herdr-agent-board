// The hub's admin client (#231), over the unix socket in the hub's directory:
//   bun hub/src/cli.ts [--dir D] invite create [--ttl 24h] [--note ".."]
//   bun hub/src/cli.ts [--dir D] invite list
//   bun hub/src/cli.ts [--dir D] invite revoke <id>
//   bun hub/src/cli.ts [--dir D] peers
//   bun hub/src/cli.ts [--dir D] revoke <peer-id|name>
import { DEFAULT_DIR, socketPath } from './admin.ts'

const USAGE = `usage: bun hub/src/cli.ts [--dir D] <command>
  invite create [--ttl 24h] [--note ".."]   a one-time invite code (printed once)
  invite list                               the invites and their state
  invite revoke <id>                        an invite that is still open
  peers                                     who is a member, who is online
  revoke <peer-id|name>                     shut a peer out at once`

/** `90s`, `15m`, `24h` or `7d` as seconds, or null. */
export function parseTtl(s: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(s)
  if (!m) return null
  const n = Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd']
  return n >= 1 ? n : null
}

const when = (ms: number | null): string =>
  ms === null ? '-' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

interface Out {
  log(s: string): void
  error(s: string): void
}

/** Runs one command; returns the exit code. */
export async function run(argv: string[], out: Out = console): Promise<number> {
  const args = [...argv]
  let dir = DEFAULT_DIR
  let ttl: string | undefined
  let note: string | undefined
  const rest: string[] = []
  while (args.length) {
    const a = args.shift() as string
    if (a === '--dir' || a === '--ttl' || a === '--note') {
      const v = args.shift()
      if (v === undefined) {
        out.error(`${a} needs a value`)
        return 2
      }
      if (a === '--dir') dir = v
      else if (a === '--ttl') ttl = v
      else note = v
    } else rest.push(a)
  }

  const call = async <T = { error?: string }>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T & { error?: string } } | null> => {
    try {
      const r = await fetch(`http://hub${path}`, {
        method,
        unix: socketPath(dir),
        ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      })
      return { status: r.status, data: await r.json() }
    } catch {
      out.error(`cannot reach the hub at ${socketPath(dir)}; is it running with --dir ${dir}?`)
      return null
    }
  }
  const bad = (r: { status: number; data: { error?: string } }): number => {
    out.error(r.data.error ?? `refused (${r.status})`)
    return 1
  }

  const [cmd, sub, arg] = rest
  if (cmd === 'invite' && sub === 'create' && rest.length === 2) {
    const ttl_s = ttl === undefined ? undefined : parseTtl(ttl)
    if (ttl_s === null) {
      out.error('--ttl is a number and s, m, h or d: 90s, 15m, 24h, 7d')
      return 2
    }
    const r = await call<{ code: string; id: string; expires_at: number }>('POST', '/invites', {
      ...(ttl_s !== undefined && { ttl_s }),
      ...(note !== undefined && { note }),
    })
    if (!r) return 1
    if (r.status !== 201) return bad(r)
    out.log(`invite   ${r.data.code}`)
    out.log(`id       ${r.data.id}`)
    out.log(`expires  ${when(r.data.expires_at)} UTC`)
    out.log('The code is shown once and works once.')
    return 0
  }
  if (cmd === 'invite' && sub === 'list' && rest.length === 2) {
    const r = await call<Array<{ id: string; state: string; expires_at: number; note: string | null }>>(
      'GET',
      '/invites',
    )
    if (!r) return 1
    for (const i of r.data)
      out.log(`${i.id}  ${i.state.padEnd(7)}  expires ${when(i.expires_at)}${i.note ? `  ${i.note}` : ''}`)
    if (r.data.length === 0) out.log('no invites')
    return 0
  }
  if (cmd === 'invite' && sub === 'revoke' && arg && rest.length === 3) {
    const r = await call('POST', `/invites/${encodeURIComponent(arg)}/revoke`)
    if (!r) return 1
    if (r.status !== 200) return bad(r)
    out.log(`invite ${arg} revoked`)
    return 0
  }
  if (cmd === 'peers' && rest.length === 1) {
    const r = await call<
      Array<{ id: string; name: string; status: string; online: boolean; last_seen_at: number | null }>
    >('GET', '/peers')
    if (!r) return 1
    for (const p of r.data)
      out.log(
        `${p.online ? '●' : '○'} ${p.name}  ${p.id}  ${p.status === 'revoked' ? 'revoked' : `last seen ${when(p.last_seen_at)}`}`,
      )
    if (r.data.length === 0) out.log('no peers')
    return 0
  }
  if (cmd === 'revoke' && sub && rest.length === 2) {
    const r = await call<{ id: string; name: string }>('POST', `/peers/${encodeURIComponent(sub)}/revoke`)
    if (!r) return 1
    if (r.status !== 200) return bad(r)
    out.log(`${r.data.name} (${r.data.id}) revoked`)
    return 0
  }
  out.error(USAGE)
  return 2
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)))
