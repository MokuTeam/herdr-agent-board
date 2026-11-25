// `board` on a node for what is the master's (#786, epic #763 T4b): another machine's session
// (sleep, archive, fork) and Devices (board nodes, board update). These go to this computer's own
// board, whose relay hands them to the master (core/master-relay.ts); this computer's own sessions
// stay with the commands' own code, as before. Nothing here runs on a board without `node`.
import { parseNodeKey } from '../core/node-key.ts'

/** Whether one of `targets` is a session of another machine than `self` (`@<device>:<key>`). */
export function foreignTargets(targets: readonly string[], self: string): boolean {
  return targets.some(t => {
    const at = parseNodeKey(t)
    return !!at && at.device !== self
  })
}

/** The answer of this computer's board, or null when none answered. */
export async function boardCall(
  port: unknown,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; ms?: number } = {},
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const base = `http://127.0.0.1:${typeof port === 'number' ? port : 12422}`
  try {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.ms ?? 30_000),
    })
    const body: unknown = await res.json().catch(() => null)
    return {
      status: res.status,
      body: typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {},
    }
  } catch {
    return null
  }
}

/** The relay's own refusal as one plain line (the master away, or its owner turned this computer off). */
export function relayLine(r: { status: number; body: Record<string, unknown> }): string | null {
  if (r.body.error === 'node-master-offline') return "the board's computer is not reachable from here now"
  if (
    typeof r.body.error === 'string' &&
    r.body.error.startsWith('master-relay-') &&
    typeof r.body.message === 'string'
  )
    return r.body.message
  return null
}

/** A session of the master's `board agents --json` (core/agent-send.ts AgentView), as far as it is read here. */
interface ForeignView {
  key: string
  names: string[]
  device: string | null
}

const viewsOf = (raw: unknown): ForeignView[] =>
  Array.isArray(raw)
    ? raw.flatMap(v => {
        if (typeof v !== 'object' || v === null) return []
        const r = v as Record<string, unknown>
        if (typeof r.key !== 'string' || !r.key) return []
        const names = [r.name, ...(Array.isArray(r.names) ? r.names : [])].filter(
          (n): n is string => typeof n === 'string' && n !== '',
        )
        return [{ key: r.key, names, device: typeof r.device === 'string' && r.device ? r.device : null }]
      })
    : []

/**
 * Another machine's session that `target` names (#798), among the master's `board agents --json`
 * views: by its key or session id (with or without the device's prefix), else by its name, as
 * `board archive` finds one of this computer's. Its key in this node's terms: `@<device>:<key>`,
 * the master's own sessions under the master's id (`masterId`). This node's own sessions (`self`)
 * are not among them: they were looked for here first. null when none fits; an error when several do
 * or the master's own one fits and its id is not known.
 */
export function foreignMatch(
  raw: unknown,
  target: string,
  self: string,
  masterId: string,
): { key: string } | { error: string } | null {
  const want = target.toLowerCase()
  const views = viewsOf(raw).filter(v => v.device !== self)
  const bare = (v: ForeignView): string => (parseNodeKey(v.key)?.key ?? v.key).toLowerCase()
  let found = views.filter(v => v.key.toLowerCase() === want || bare(v) === want)
  if (!found.length) found = views.filter(v => v.names.some(n => n.toLowerCase() === want))
  if (found.length > 1)
    return {
      error: `"${target}" fits ${found.length} sessions of other machines (${found.map(v => v.key).join(', ')}); give its key`,
    }
  const one = found[0]
  if (!one) return null
  if (one.device !== null) return { key: parseNodeKey(one.key) ? one.key : `@${one.device}:${one.key}` }
  if (!masterId)
    return { error: `"${target}" is a session of the board's computer, whose id this computer does not know yet` }
  return { key: `@${masterId}:${one.key}` }
}
