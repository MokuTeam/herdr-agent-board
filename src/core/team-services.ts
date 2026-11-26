// Service agents (#819): a program of the owner's that is no herdr pane and no agent harness (an
// assistant service on the same computer, say) and still writes in Team as one of the owner's
// agents. The owner names it and gives it a lane in the Team panel; config.json keeps it under
// `team.services`, beside the rest of the team's settings, so a board without a team never reads it:
//   "team": { "hub": "...", "name": "anna", "services": [{ "key": "service-juno", "name": "Juno", "lane": "home" }] }
// The board gives each a card with no pane (services/board.ts): its lane is the card's, so the agent
// lane check of an agent's post (services/team-router.ts) works for it as for any session. It calls
// the board's MCP (`/mcp`, entrypoints/mcp-http.ts) with `X-Board-Session: <key>` and is that card.
// Nothing wakes it, puts it to sleep or archives it: it has no pane and no transcript.
import { validName } from './team.ts'

export interface ServiceAgent {
  /** Its card's key, what it names itself by in X-Board-Session: `service-<word>`. */
  key: string
  /** What the board calls it, on its card and in what it posts ("anna's agent Juno"). */
  name: string
  /** Its lane (a category id): where it may talk with whom the owner shares that lane. */
  lane: string
}

export const SERVICE_PREFIX = 'service-'
/** Enough for the owner's own services; a list past it is a mistake, not a setup. */
export const MAX_SERVICES = 20

const KEY = /^service-[a-z0-9][a-z0-9-]{0,47}$/
const LANE = /^[a-z0-9_-]{1,32}$/

export const isServiceKey = (v: unknown): v is string => typeof v === 'string' && KEY.test(v)

/** The services config.json's `team` names; anything that is not one is left out. */
export function serviceAgents(team: unknown): ServiceAgent[] {
  if (typeof team !== 'object' || team === null || Array.isArray(team)) return []
  const list = (team as Record<string, unknown>).services
  if (!Array.isArray(list)) return []
  const out: ServiceAgent[] = []
  for (const s of list.slice(0, MAX_SERVICES)) {
    if (typeof s !== 'object' || s === null) continue
    const { key, name, lane } = s as Record<string, unknown>
    if (!isServiceKey(key) || !validName(name) || typeof lane !== 'string' || !LANE.test(lane)) continue
    if (out.some(o => o.key === key)) continue
    out.push({ key, name, lane })
  }
  return out
}

/** A short stable word for a name with no Latin letters or digits in it (FNV-1a). */
function hashWord(name: string): string {
  let h = 0x811c9dc5
  for (const ch of name) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** The key a new service of this name gets: `service-` and its name in lower-case Latin words, free among `taken`. */
export function serviceKeyFor(name: string, taken: readonly string[]): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  const base = `${SERVICE_PREFIX}${slug || hashWord(name)}`
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`
}

export type ServiceChange = { add: { name: unknown; lane: unknown } } | { remove: unknown }

/**
 * A change of the list from the Team panel: add one (a name not used yet, a lane there is) or remove
 * one by its key. The new list, or why not.
 */
export function changeServices(
  now: readonly ServiceAgent[],
  change: unknown,
  lanes: readonly string[],
): { ok: true; services: ServiceAgent[]; added?: ServiceAgent } | { ok: false; error: string } {
  if (typeof change !== 'object' || change === null) return { ok: false, error: 'body' }
  const c = change as Record<string, unknown>
  if (c.remove !== undefined) {
    if (!isServiceKey(c.remove) || !now.some(s => s.key === c.remove)) return { ok: false, error: 'service' }
    return { ok: true, services: now.filter(s => s.key !== c.remove) }
  }
  const add = c.add
  if (typeof add !== 'object' || add === null) return { ok: false, error: 'body' }
  const { name: rawName, lane } = add as Record<string, unknown>
  const name = typeof rawName === 'string' ? rawName.trim() : rawName
  if (!validName(name)) return { ok: false, error: 'name' }
  if (typeof lane !== 'string' || !lanes.includes(lane)) return { ok: false, error: 'lane' }
  if (now.some(s => s.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: 'taken' }
  if (now.length >= MAX_SERVICES) return { ok: false, error: 'full' }
  const added = {
    key: serviceKeyFor(
      name,
      now.map(s => s.key),
    ),
    name,
    lane,
  }
  return { ok: true, services: [...now, added], added }
}
