// Limits on agent starts (#815, epic #812): which sessions may start sessions, how many of the
// sessions a session started may run at once, how deep a chain of starts may go, and how many starts
// a session makes in an hour. The rules only, without I/O: the ledger of who started whom is
// adapters/spawn-ledger.ts, spawn-agent's gate services/launch/spawn-gate.ts.
//
// They hold for a session that starts a session (spawn-agent run in its pane, the CLI child the
// board's MCP runs for it) and never for the owner: the web page, a terminal outside any session,
// the board's own launcher and an MCP call that names no session are not counted.
//
// config.json's `spawnLimits` (Settings → Board & Agents), every field optional:
//   { "agents": false }   sessions on this computer start no sessions
//   { "children": 10 }    live sessions a session started, at most (0: no limit)
//   { "depth": 3 }        levels of starts below a session the owner started (0: no limit)
//   { "perHour": 30 }     starts by one session in the last hour (0: no limit)
// The defaults stay out of the owner's way: a master session runs about five at once and starts
// dozens a day.

export interface SpawnLimits {
  /** Sessions on this computer may start sessions. */
  agents: boolean
  /** Live sessions one session started, at most; 0 for no limit. */
  children: number
  /** How many levels of agent starts below a session the owner started; 0 for no limit. */
  depth: number
  /** Starts by one session in the last hour, at most; 0 for no limit. */
  perHour: number
}

export const SPAWN_DEFAULTS: SpawnLimits = { agents: true, children: 10, depth: 3, perHour: 30 }

/** What Settings offers for each number (0: no limit); config.json may hold any other. */
export const SPAWN_CHOICES = {
  children: [3, 5, 10, 20, 50, 0],
  depth: [1, 2, 3, 5, 0],
  perHour: [10, 30, 60, 120, 0],
} as const

export type SpawnNumber = keyof typeof SPAWN_CHOICES
export const SPAWN_NUMBERS: readonly SpawnNumber[] = ['children', 'depth', 'perHour']

/** The largest number a limit may hold. */
export const SPAWN_MAX = 1000

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= SPAWN_MAX
/** A number config.json holds: one past the largest is the largest, a wrong one the default. */
const countOf = (v: unknown, fallback: number): number =>
  isCount(v) ? v : typeof v === 'number' && Number.isInteger(v) && v > SPAWN_MAX ? SPAWN_MAX : fallback

/** config.json's `spawnLimits` with the defaults for what it does not say or says wrongly. */
export function spawnLimitsOf(raw: unknown): SpawnLimits {
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    agents: typeof r.agents === 'boolean' ? r.agents : SPAWN_DEFAULTS.agents,
    children: countOf(r.children, SPAWN_DEFAULTS.children),
    depth: countOf(r.depth, SPAWN_DEFAULTS.depth),
    perHour: countOf(r.perHour, SPAWN_DEFAULTS.perHour),
  }
}

/**
 * An edit of `spawnLimits` from Settings (POST /api/settings): the fields given replace the saved
 * ones, a default is not written, and nothing left takes the key out. Null when a value is wrong.
 */
export function editedSpawnLimits(saved: unknown, body: unknown): Record<string, unknown> | undefined | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const keys = Object.keys(b)
  if (!keys.length || keys.some(k => k !== 'agents' && !SPAWN_NUMBERS.includes(k as SpawnNumber))) return null
  if (b.agents !== undefined && typeof b.agents !== 'boolean') return null
  if (SPAWN_NUMBERS.some(k => b[k] !== undefined && !isCount(b[k]))) return null
  const own: Record<string, unknown> =
    typeof saved === 'object' && saved !== null && !Array.isArray(saved)
      ? { ...(saved as Record<string, unknown>) }
      : {}
  for (const k of keys) {
    if (b[k] === SPAWN_DEFAULTS[k as keyof SpawnLimits]) delete own[k]
    else own[k] = b[k]
  }
  return Object.keys(own).length ? own : undefined
}

/** A session as the ledger names it: its session id and its herdr pane, as far as known. */
export interface SpawnParty {
  session?: string
  pane?: string
}

/** One agent start: who asked for it, when, and (once it started) the session it became. */
export interface SpawnEntry {
  id: string
  at: number
  by: SpawnParty
  name: string
  /** Set once the start went through; {} when it waits in the placer's queue or said nothing of itself. */
  child?: SpawnParty
}

/** A start that has not said what it became counts as running for this long. */
export const PENDING_MS = 10 * 60_000
/** A start counts as running for this long whatever herdr says: it may not show there yet. */
export const FRESH_MS = 2 * 60_000
/** The ledger keeps a week. */
export const KEEP_MS = 7 * 24 * 3600_000
const HOUR_MS = 3600_000

/** Whether two parties are the same session: by their session ids when both have one, else by their panes. */
export function sameParty(a: SpawnParty, b: SpawnParty): boolean {
  if (a.session && b.session) return a.session === b.session
  return !!a.pane && a.pane === b.pane
}

/** The entries a week old or older taken out. */
export const kept = (entries: readonly SpawnEntry[], now: number): SpawnEntry[] =>
  entries.filter(e => now - e.at < KEEP_MS)

/** Whether a party is a session that runs now. */
export type Alive = (p: SpawnParty) => boolean

export type SpawnRule = 'agents' | 'children' | 'depth' | 'perHour'
export type SpawnVerdict =
  | { ok: true; depth: number }
  | { ok: false; rule: SpawnRule; count: number; limit: number; line: string }

/** The latest start whose session is this one. */
function startOf(entries: readonly SpawnEntry[], p: SpawnParty): SpawnEntry | undefined {
  let found: SpawnEntry | undefined
  for (const e of entries) if (e.child && sameParty(e.child, p) && (!found || e.at > found.at)) found = e
  return found
}

/**
 * How many levels of agent starts the caller is below a session nobody in the ledger started:
 * each level a parent that still runs (`alive`). A parent gone ends the chain there, so a session
 * that restarts itself does not climb; a chain is cut at 50.
 */
export function depthOf(entries: readonly SpawnEntry[], caller: SpawnParty, alive: Alive): number {
  let depth = 0
  let cur = caller
  const seen = new Set<string>()
  while (depth < 50) {
    const e = startOf(entries, cur)
    if (!e || seen.has(e.id) || !alive(e.by)) break
    seen.add(e.id)
    depth++
    cur = e.by
  }
  return depth
}

/** The starts of the caller that still run: fresh or waiting ones, and those whose session `alive` finds. */
export function liveChildren(entries: readonly SpawnEntry[], caller: SpawnParty, now: number, alive: Alive): number {
  return entries.filter(
    e =>
      sameParty(e.by, caller) &&
      (now - e.at < FRESH_MS ||
        (e.child === undefined
          ? now - e.at < PENDING_MS
          : e.child.pane || e.child.session
            ? alive(e.child)
            : now - e.at < PENDING_MS)),
  ).length
}

const settingsWord = 'Settings → Board & Agents'
const sessions = (n: number): string => `${n} session${n === 1 ? '' : 's'}`

/**
 * Whether the caller may start one more session now, under `limits`; with `alive` saying which
 * sessions still run. Refused: the rule, the numbers and one line that says why.
 */
export function spawnVerdict(
  limits: SpawnLimits,
  entries: readonly SpawnEntry[],
  caller: SpawnParty,
  now: number,
  alive: Alive,
): SpawnVerdict {
  const no = (rule: SpawnRule, count: number, limit: number, line: string): SpawnVerdict => ({
    ok: false,
    rule,
    count,
    limit,
    line,
  })
  if (!limits.agents)
    return no(
      'agents',
      0,
      0,
      `sessions on this computer may not start sessions (${settingsWord}): ask the owner to start it`,
    )
  const hour = entries.filter(e => sameParty(e.by, caller) && now - e.at < HOUR_MS).length
  if (limits.perHour > 0 && hour >= limits.perHour)
    return no(
      'perHour',
      hour,
      limits.perHour,
      `this session started ${sessions(hour)} in the last hour, the limit is ${limits.perHour} (${settingsWord}): wait, or ask the owner`,
    )
  const live = liveChildren(entries, caller, now, alive)
  if (limits.children > 0 && live >= limits.children)
    return no(
      'children',
      live,
      limits.children,
      `${sessions(live)} this session started still ${live === 1 ? 'runs' : 'run'}, the limit is ${limits.children} (${settingsWord}): wait for one to end, or ask the owner`,
    )
  const depth = depthOf(entries, caller, alive) + 1
  if (limits.depth > 0 && depth > limits.depth)
    return no(
      'depth',
      depth,
      limits.depth,
      `a session started by this one would be ${depth} levels of agent starts deep, the limit is ${limits.depth} (${settingsWord}): ask the owner, or the session that started this one`,
    )
  return { ok: true, depth }
}

/**
 * Whether the verdict can depend on which sessions still run: with every session taken as running
 * it would refuse. False: the verdict is the same whatever herdr says, so nothing need be asked.
 */
export function needsAlive(
  limits: SpawnLimits,
  entries: readonly SpawnEntry[],
  caller: SpawnParty,
  now: number,
): boolean {
  const all = spawnVerdict(limits, entries, caller, now, () => true)
  return !all.ok && (all.rule === 'children' || all.rule === 'depth')
}

/** What a spawn line (spawn-agent's, a node's, a queued one) says of the session it started. */
export function childOfLine(line: string): SpawnParty {
  const pane = /(?:^|\s)pane=(\S+)/.exec(line)?.[1]
  const session = /(?:^|\s)session=(\S+)/.exec(line)?.[1]
  return { ...(pane && { pane }), ...(session && { session }) }
}
