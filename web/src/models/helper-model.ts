// What the page says about a session's helpers (src/core/helpers.ts) and about the sessions it
// works with (src/core/links.ts): titles, times, the order they are listed in, which session a
// name in the thread is. No DOM here, so the tests can read it.
import type { HelperStatus, PublicHelper, WorkflowRun } from '../../../src/core/helpers.ts'
import type { Item } from '../../../src/core/types.ts'

/** A helper's title: what it was asked to do in a few words, else its name or type. */
export const helperTitle = (
  h: Partial<Pick<PublicHelper, 'description' | 'name' | 'type' | 'id'>> | null | undefined,
) => h?.description || h?.name || h?.type || h?.id || ''

/** A stopwatch length: "12s", "4:05", "1:04:05". */
export function clock(ms: number | null | undefined): string {
  const s = Math.max(0, Math.floor((ms ?? 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h) return `${h}:${pad(m)}:${pad(s % 60)}`
  return m ? `${m}:${pad(s % 60)}` : `${s}s`
}

/** Tokens short: 950, 23k, 1.2M. */
export function tokens(n: number | null | undefined): string {
  if (n == null) return ''
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

export type Tone = 'run' | 'ok' | 'idle' | 'fail' | 'stop'
const TONES: Partial<Record<string, Tone>> = { running: 'run', done: 'ok', idle: 'idle', failed: 'fail' }

/** The mark's color for a status: run | ok | idle | fail | stop. */
export const toneOf = (status: string): Tone => TONES[status] ?? 'stop'

/** What took() reads of a helper or a run. */
export interface Timed {
  status: HelperStatus | string
  startedAt?: number | null
  endedAt?: number | null
  activity?: number | null
}

/** How long it ran (or runs, up to `now`). */
export function took(h: Timed | null | undefined, now = Date.now()): number | null {
  if (!h?.startedAt) return null
  const end = h.status === 'running' ? now : (h.endedAt ?? h.activity ?? h.startedAt)
  return Math.max(0, end - h.startedAt)
}

/** A helper in the list, a level further in under the helper that started it. */
export type ListedHelper = PublicHelper & { depth: number }
export type ListedRun = Omit<WorkflowRun, 'agents'> & { agents: PublicHelper[] }

export interface HelperGroups {
  running: ListedHelper[]
  teammates: ListedHelper[]
  runs: ListedRun[]
  finished: ListedHelper[]
}

/**
 * The helpers in the order the list shows them: what runs now, the workflow runs with their
 * agents, the teammates, then everything that finished, newest first. A helper another helper
 * started goes under it.
 */
export function groupHelpers(
  helpers: readonly PublicHelper[] = [],
  workflows: readonly WorkflowRun[] = [],
): HelperGroups {
  const byRun = new Map<string, PublicHelper[]>(workflows.map(w => [w.id, []]))
  const own: PublicHelper[] = []
  for (const h of helpers) {
    const run = h.workflow ? byRun.get(h.workflow) : undefined
    if (run) run.push(h)
    else own.push(h)
  }
  const recent = (a: PublicHelper, b: PublicHelper) =>
    (b.startedAt ?? b.activity ?? 0) - (a.startedAt ?? a.activity ?? 0)
  // Children follow their parent, a level further in each time.
  const ids = new Set(own.map(h => h.id))
  const kids = new Map<string, PublicHelper[]>()
  for (const h of own) if (h.parent && ids.has(h.parent)) kids.set(h.parent, [...(kids.get(h.parent) ?? []), h])
  const tree = (h: PublicHelper, depth: number, seen: Set<string>): ListedHelper[] =>
    seen.has(h.id)
      ? []
      : [
          { ...h, depth },
          ...(kids.get(h.id) ?? []).sort(recent).flatMap(k => tree(k, depth + 1, new Set([...seen, h.id]))),
        ]
  const flat = (list: PublicHelper[]) => list.sort(recent).flatMap(h => tree(h, 0, new Set()))
  const top = own.filter(h => !(h.parent && ids.has(h.parent)))
  return {
    running: flat(top.filter(h => h.status === 'running' && h.kind !== 'teammate')),
    teammates: flat(top.filter(h => h.kind === 'teammate')),
    runs: workflows
      .map(w => ({ ...w, agents: (byRun.get(w.id) ?? []).sort(recent) }))
      .sort(
        (a, b) =>
          Number(b.status === 'running') - Number(a.status === 'running') || (b.startedAt ?? 0) - (a.startedAt ?? 0),
      ),
    finished: flat(top.filter(h => h.status !== 'running' && h.kind !== 'teammate')),
  }
}

/** What a line of the thread knows of the helper it is about. */
export interface HelperLookup {
  id?: string
  /** The call that made it. */
  tool?: string | undefined
  name?: string
}

/**
 * The helper a line of the thread is about: by its id, the call that made it, or its name (a
 * teammate's first, else the newest helper of that name).
 */
export function findHelper<H extends PublicHelper>(helpers: readonly H[] = [], ref: HelperLookup = {}): H | null {
  if (ref.id) {
    const h = helpers.find(x => x.id === ref.id)
    if (h) return h
  }
  if (ref.tool) {
    const h = helpers.find(x => x.toolUseId === ref.tool)
    if (h) return h
  }
  if (!ref.name) return null
  const named = helpers
    .filter(x => x.name === ref.name || x.id === ref.name)
    .sort(
      (a, b) =>
        Number(b.kind === 'teammate') - Number(a.kind === 'teammate') || (b.startedAt ?? 0) - (a.startedAt ?? 0),
    )
  return named[0] ?? null
}

// As src/core/links.ts matches names: keep the two alike.
const norm = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * The session a name in the thread is (SendMessage's `to`, a message's sender, the name
 * spawn-agent gave): the one item that goes by it, else null. Never the session itself.
 */
export function sessionByName(items: readonly Item[] = [], name: unknown, self: string | null = null): Item | null {
  const n = norm(name)
  if (!n) return null
  const hits = items.filter(
    it => it.key !== self && !it.launchOnly && [it.name, it.autoName].some(v => v && norm(v) === n),
  )
  return hits.length === 1 ? (hits[0] ?? null) : null
}

/** Every session an item is linked with: who started it, whom it started, whom it wrote with. */
export function relatedKeys(it: Pick<Item, 'links'> | null | undefined): Set<string> {
  const l = it?.links
  if (!l) return new Set()
  return new Set(
    [l.from?.key, ...(l.started ?? []).map(x => x.key), ...(l.talks ?? []).map(x => x.key)].filter(
      (k): k is string => !!k,
    ),
  )
}

/**
 * The card's short count: the helpers at work (a workflow's agents among them), or the workflows
 * that run between two of their agents; 0 when nothing works.
 */
export const liveCount = (it: Pick<Item, 'helpers'> | null | undefined): number =>
  it?.helpers?.running || it?.helpers?.workflows || 0

/** A session this one is linked with, once (web/app.js linkedSessions). */
export interface LinkedSession {
  key: string
  /** It started this one. */
  from: boolean
  /** This one started it. */
  started: boolean
  in: number
  out: number
  at: number
}

/** Each session this one is linked with, once: who started it first, then by the latest contact. */
export function linkedSessions(it: Pick<Item, 'links'>, onBoard: (key: string) => boolean): LinkedSession[] {
  const l = it.links
  if (!l) return []
  const by = new Map<string, LinkedSession>()
  const get = (key: string): LinkedSession => {
    const known = by.get(key)
    if (known) return known
    const made = { key, from: false, started: false, in: 0, out: 0, at: 0 }
    by.set(key, made)
    return made
  }
  if (l.from) Object.assign(get(l.from.key), { from: true, at: l.from.at })
  for (const s of l.started ?? []) Object.assign(get(s.key), { started: true, at: Math.max(get(s.key).at, s.at) })
  for (const x of l.talks ?? []) Object.assign(get(x.key), { in: x.in, out: x.out, at: Math.max(get(x.key).at, x.at) })
  return [...by.values()].filter(p => onBoard(p.key)).sort((a, b) => Number(b.from) - Number(a.from) || b.at - a.at)
}
