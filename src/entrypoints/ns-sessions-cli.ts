// `board ns-sessions list [--json]` (#860): the NetSuite session store's entries as the board
// this computer runs answers them (on a node, relayed from its master): metadata only. The store
// never answers a value here, and this command prints only the fields it knows, whatever comes.
import { isRecord } from '../adapters/json-store.ts'
import { type NsMeta, nsListLine } from '../core/ns-sessions.ts'

export const NS_USAGE = 'usage: board ns-sessions list [--json]'

/** The fields an entry shows, picked one by one: nothing else of what came is printed. */
function metaOf(raw: unknown): NsMeta | null {
  if (!isRecord(raw)) return null
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const origin = isRecord(raw.origin) ? raw.origin : {}
  const last = isRecord(raw.last_activity) ? raw.last_activity : {}
  const lock = isRecord(raw.lock) ? raw.lock : null
  const state = raw.state === 'live' || raw.state === 'dying' || raw.state === 'dead' ? raw.state : null
  if (!state || !s(raw.account)) return null
  return {
    account: s(raw.account),
    user: s(raw.user),
    role: typeof raw.role === 'string' ? raw.role : null,
    host: s(raw.host),
    state,
    dead_reason: (typeof raw.dead_reason === 'string' ? raw.dead_reason : null) as NsMeta['dead_reason'],
    dead_matched: (typeof raw.dead_matched === 'string' ? raw.dead_matched : null) as NsMeta['dead_matched'],
    fp: /^[0-9a-f]{8}$/.test(s(raw.fp)) ? s(raw.fp) : '',
    generation: n(raw.generation),
    origin: { machine: s(origin.machine), profile: s(origin.profile) },
    login_at: n(raw.login_at),
    abs_expiry: n(raw.abs_expiry),
    idle_expiry: n(raw.idle_expiry),
    last_activity: { at: n(last.at), where: s(last.where) },
    holders: Array.isArray(raw.holders) ? raw.holders.filter((h): h is string => typeof h === 'string') : [],
    lock: lock ? { holder: s(lock.holder), until: n(lock.until) } : null,
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
  if (!res.ok || !Array.isArray(body)) {
    const code = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
    throw new Error(`ns-sessions list: ${code}`)
  }
  const list = body.map(metaOf).filter((m): m is NsMeta => m !== null)
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
