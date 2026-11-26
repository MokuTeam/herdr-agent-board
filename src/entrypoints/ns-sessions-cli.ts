// `board ns-sessions list [--json]` (#860): the NetSuite session store's entries as the board
// this computer runs answers them (on a node, relayed from its master): metadata only. The store
// never answers a value here, and this command prints only the fields it knows, whatever comes.
import { isRecord } from '../adapters/json-store.ts'
import {
  isNsDeadReason,
  type NsEventKind,
  type NsLastEvent,
  type NsMeta,
  type NsWhere,
  nsListLine,
} from '../core/ns-sessions.ts'

export const NS_USAGE = 'usage: board ns-sessions list [--json]'

const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const whereOf = (v: unknown): NsWhere =>
  isRecord(v) ? { machine: s(v.machine), profile: s(v.profile) } : { machine: '', profile: '' }
const EVENT_KINDS: ReadonlySet<unknown> = new Set<NsEventKind>(['published', 'imported', 'activity', 'dead', 'expired'])

function lastEventOf(v: unknown): NsLastEvent | null {
  if (!isRecord(v) || !EVENT_KINDS.has(v.kind) || typeof v.at !== 'number' || !Number.isFinite(v.at)) return null
  return {
    kind: v.kind as NsEventKind,
    at: v.at,
    where: isRecord(v.where) ? whereOf(v.where) : null,
    ...(v.reason !== undefined && { reason: isNsDeadReason(v.reason) ? v.reason : null }),
  }
}

/** The fields an entry shows, picked one by one: nothing else of what came is printed. */
function metaOf(raw: unknown): NsMeta | null {
  if (!isRecord(raw)) return null
  const lock = isRecord(raw.lock) ? raw.lock : null
  const state = raw.state === 'live' || raw.state === 'dying' || raw.state === 'dead' ? raw.state : null
  if (!state || !s(raw.account)) return null
  const loginAt = typeof raw.login_at === 'number' && Number.isFinite(raw.login_at) ? raw.login_at : null
  const firstSeen =
    typeof raw.first_seen === 'number' && Number.isFinite(raw.first_seen)
      ? raw.first_seen
      : (loginAt ?? n(raw.last_activity))
  return {
    account: s(raw.account),
    user: typeof raw.user === 'string' ? raw.user : null,
    host: s(raw.host),
    role: typeof raw.role === 'string' ? raw.role : null,
    fp: /^[0-9a-f]{8}$/.test(s(raw.fp)) ? s(raw.fp) : '',
    state,
    generation: n(raw.generation),
    login_at: loginAt,
    first_seen: firstSeen,
    abs_expiry: n(raw.abs_expiry),
    abs_expiry_estimated: typeof raw.abs_expiry_estimated === 'boolean' ? raw.abs_expiry_estimated : loginAt === null,
    idle_expiry: n(raw.idle_expiry),
    last_activity: n(raw.last_activity),
    last_where: whereOf(raw.last_where),
    origin: whereOf(raw.origin),
    holders: Array.isArray(raw.holders) ? raw.holders.filter((h): h is string => typeof h === 'string') : [],
    dead_at: typeof raw.dead_at === 'number' && Number.isFinite(raw.dead_at) ? raw.dead_at : null,
    dead_reason: (typeof raw.dead_reason === 'string' ? raw.dead_reason : null) as NsMeta['dead_reason'],
    auto_renew: typeof raw.auto_renew === 'boolean' ? raw.auto_renew : null,
    last_event: lastEventOf(raw.last_event),
    lock: lock
      ? {
          holder: { ...whereOf(lock.holder), run_id: s(isRecord(lock.holder) ? lock.holder.run_id : '') },
          until: n(lock.until),
        }
      : null,
  }
}

export async function nsSessionsCommand(
  argv: readonly string[],
  port: unknown,
  o: { fetch?: typeof fetch; print?: (line: string) => void; now?: () => number } = {},
): Promise<number> {
  const print = o.print ?? ((line: string) => console.log(line))
  const words = argv.filter(a => a !== '--json')
  if (words.length !== 1 || words[0] !== 'list') throw new Error(NS_USAGE)
  const asJson = argv.includes('--json')
  let res: Response
  try {
    res = await (o.fetch ?? fetch)(`http://127.0.0.1:${Number(port) || 12422}/api/ns-sessions/list`, {
      headers: { 'x-board': '1' },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error('the board does not answer on this computer')
  }
  if (res.status === 503) {
    print('no store: the master board is not reachable now')
    return 1
  }
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok || !isRecord(body) || body.ok !== true || !Array.isArray(body.entries)) {
    const code = isRecord(body) && typeof body.code === 'string' ? body.code : `HTTP ${res.status}`
    throw new Error(`ns-sessions list: ${code}`)
  }
  const list = body.entries.map(metaOf).filter((m): m is NsMeta => m !== null)
  if (asJson) {
    print(JSON.stringify(list, null, 2))
    return 0
  }
  if (!list.length) {
    print('no NetSuite sessions in the store')
    return 0
  }
  const t = (o.now ?? Date.now)()
  for (const m of list) print(nsListLine(m, t))
  return 0
}
