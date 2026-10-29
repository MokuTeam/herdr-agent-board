// The profile sync's path rules: "this folder on the PC is that folder on the server". A project
// under a rule's folder on one side lands at the same path below the rule's folder on the other
// (C:\migo\x\y ↔ /home/agent/migo/x/y), both ways; the longest folder wins. A pair by git remote
// (a clone there) wins over a rule, and the owner's own path for a project (or "leave out") over
// both (paths.ts pairProjects). The rules are the local board's, per server board (config.json
// `tunnel.syncPaths`, by the server's host): not secret. A rule is suggested from the projects
// left without a pair: their deepest common folder (not a drive or `/` alone) to that folder's
// name in the target's home, or, without one, one per top folder. Pure.
import { givenPath, nativePath, type Pair, type Platform, pathKey, type RuleMove, type Unpaired } from './paths.ts'

/** A rule: a folder on this computer (the PC) and the server's folder it stands for. */
export interface PathRule {
  pc: string
  server: string
}

/** A rule suggested for the projects without a pair, and how many of them it would place. */
export interface Suggestion {
  rule: PathRule
  projects: number
}

/** The most rules kept for one server. */
export const MOST_RULES = 100

/** The rules as one sync moves the source's paths (up: the PC's folders to the server's; down: back), the longest folder first. */
export function ruleMoves(rules: readonly PathRule[], direction: 'up' | 'down', from: Platform): RuleMove[] {
  return rules
    .map((r, rule) => (direction === 'up' ? { from: r.pc, to: r.server, rule } : { from: r.server, to: r.pc, rule }))
    .sort((a, b) => pathKey(b.from, from).length - pathKey(a.from, from).length || a.rule - b.rule)
}

/** The rules as the owner gave them, each folder absolute as its side writes one; one PC folder once (the first). Null when one is not. */
export function cleanRules(raw: unknown, pc: Platform, server: Platform): PathRule[] | null {
  if (!Array.isArray(raw) || raw.length > MOST_RULES) return null
  const out: PathRule[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') return null
    const { pc: a, server: b } = r as Record<string, unknown>
    const p = typeof a === 'string' ? givenPath(a, pc) : null
    const s = typeof b === 'string' ? givenPath(b, server) : null
    if (p === null || s === null) return null
    if (!out.some(x => pathKey(x.pc, pc) === pathKey(p, pc))) out.push({ pc: p, server: s })
  }
  return out
}

/** The rules a config holds for a server (`tunnel.syncPaths[host]`), those that read as rules. */
export function rulesIn(tunnel: unknown, host: string): PathRule[] {
  const all = tunnel && typeof tunnel === 'object' ? (tunnel as Record<string, unknown>).syncPaths : null
  const list = all && typeof all === 'object' ? (all as Record<string, unknown>)[host] : null
  return Array.isArray(list)
    ? list.flatMap(r =>
        r && typeof r === 'object' && typeof r.pc === 'string' && typeof r.server === 'string'
          ? [{ pc: r.pc, server: r.server }]
          : [],
      )
    : []
}

/** A path in parts as its side writes it: its root (C: on Windows, '' for /) and the folders below it. */
function partsOf(p: string, platform: Platform): { root: string; parts: string[] } {
  const [root = '', ...rest] = nativePath(p, platform).replace(/\\/g, '/').split('/')
  return { root, parts: rest.filter(x => x !== '') }
}

const same = (a: string, b: string, platform: Platform): boolean =>
  platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

/** The deepest folder holding every path (its root and folders, as the first path spells them); null across roots. */
function common(paths: readonly string[], platform: Platform): { root: string; parts: string[] } | null {
  const [first, ...rest] = paths.map(p => partsOf(p, platform))
  if (!first) return null
  let n = first.parts.length
  for (const q of rest) {
    if (!same(q.root, first.root, platform)) return null
    let i = 0
    while (i < n && i < q.parts.length && same(q.parts[i] as string, first.parts[i] as string, platform)) i++
    n = i
  }
  return { root: first.root, parts: first.parts.slice(0, n) }
}

const pathOf = (c: { root: string; parts: string[] }, platform: Platform): string =>
  platform === 'win32' ? `${c.root}\\${c.parts.join('\\')}` : `/${c.parts.join('/')}`

/**
 * Rules for the source's paths of projects without a pair: their deepest common folder, unless it
 * is a drive or `/` alone or above the source's home (C:\Users), to that folder's name in the
 * target's home (C:\migo → /home/agent/migo); a folder in the source's home to the same place in
 * the target's (C:\Users\me\code → /home/agent/code). With no such folder for them all, one per
 * top folder (the home's projects as one). Each with how many of the paths it holds.
 */
export function suggestMoves(
  paths: readonly string[],
  from: { platform: Platform; home: string },
  to: { platform: Platform; home: string },
): { from: string; to: string; projects: number }[] {
  const home = partsOf(from.home, from.platform)
  const inHome = (c: { root: string; parts: string[] }): boolean =>
    same(c.root, home.root, from.platform) &&
    c.parts.length >= home.parts.length &&
    home.parts.every((x, i) => same(x, c.parts[i] as string, from.platform))
  const aboveHome = (c: { root: string; parts: string[] }): boolean =>
    same(c.root, home.root, from.platform) &&
    c.parts.length < home.parts.length &&
    c.parts.every((x, i) => same(x, home.parts[i] as string, from.platform))
  const useful = (c: { root: string; parts: string[] } | null): c is { root: string; parts: string[] } =>
    c !== null && c.parts.length > 0 && !aboveHome(c)
  const sep = to.platform === 'win32' ? '\\' : '/'
  const base = to.home.replace(/[\\/]+$/, '')
  const ruleFor = (c: { root: string; parts: string[] }, list: readonly string[]) => ({
    from: pathOf(c, from.platform),
    to: inHome(c)
      ? [base, ...c.parts.slice(home.parts.length)].join(sep)
      : `${base}${sep}${c.parts[c.parts.length - 1] as string}`,
    projects: list.length,
  })
  const list = paths.filter(p => givenPath(p, from.platform) !== null)
  if (list.length === 0) return []
  const all = common(list, from.platform)
  if (useful(all)) return [ruleFor(all, list)]
  const groups = new Map<string, string[]>()
  for (const p of list) {
    const q = partsOf(p, from.platform)
    const top = q.parts[0]
    const key = inHome(q)
      ? '~'
      : top === undefined
        ? ''
        : pathKey(pathOf({ root: q.root, parts: [top] }, from.platform), from.platform)
    if (key === '') continue
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  return [...groups.values()]
    .flatMap(g => {
      const c = common(g, from.platform)
      return useful(c) ? [ruleFor(c, g)] : []
    })
    .sort((a, b) => a.from.localeCompare(b.from))
}

/** The rules suggested for a sync's projects without a pair (those a rule could place), as PC ↔ server folders. */
export function suggestRules(
  unpaired: readonly Unpaired[],
  direction: 'up' | 'down',
  from: { platform: Platform; home: string },
  to: { platform: Platform; home: string },
): Suggestion[] {
  const paths = unpaired.flatMap(u =>
    u.path !== null && (u.why === 'noRemote' || u.why === 'noClone' || u.why === 'worktree' || u.why === 'gone')
      ? [u.path]
      : [],
  )
  return suggestMoves(paths, from, to).map(m => ({
    rule: direction === 'up' ? { pc: m.from, server: m.to } : { pc: m.to, server: m.from },
    projects: m.projects,
  }))
}

/** How a project lands on the target, as the preview groups them. */
export type PlaceKind = 'rule' | 'remote' | 'same' | 'chosen' | 'left' | 'none'

/** A project as the preview shows where it lands: `there`, whether its folder is on the target (null: not known). */
export interface Placed {
  profile: string
  folder: string
  from: string | null
  to: string | null
  there: boolean | null
  /** Why it has no pair, for `none`. */
  why?: Unpaired['why']
}

export interface PlaceGroup {
  kind: PlaceKind
  /** For `rule`: the rule and its place among the rules. */
  rule?: PathRule
  index?: number
  list: Placed[]
}

/**
 * The projects grouped by how they land: each rule (in its order, one with none too), by git
 * remote, the same path, the owner's own path, left out, and those without a pair; empty groups
 * but the rules' left out.
 */
export function placeGroups(p: {
  rules: readonly PathRule[]
  pairs: readonly Pair[]
  unpaired: readonly Unpaired[]
  there: Readonly<Record<string, boolean>>
}): PlaceGroup[] {
  const placed = (x: Pair): Placed => ({
    profile: x.profile,
    folder: x.folder,
    from: x.from || null,
    to: x.to,
    there: x.to in p.there ? (p.there[x.to] as boolean) : null,
  })
  const unplaced = (u: Unpaired): Placed => ({
    profile: u.profile,
    folder: u.folder,
    from: u.path,
    to: null,
    there: null,
    why: u.why,
  })
  const of = (how: Pair['how']): Placed[] => p.pairs.filter(x => x.how === how).map(placed)
  const groups: PlaceGroup[] = [
    ...p.rules.map((rule, index) => ({
      kind: 'rule' as const,
      rule,
      index,
      list: p.pairs.filter(x => x.how === 'rule' && x.rule === index).map(placed),
    })),
    { kind: 'remote', list: of('remote') },
    { kind: 'same', list: of('same') },
    { kind: 'chosen', list: of('owner') },
    { kind: 'left', list: p.unpaired.filter(u => u.why === 'left').map(unplaced) },
    { kind: 'none', list: p.unpaired.filter(u => u.why !== 'left').map(unplaced) },
  ]
  return groups.filter(g => g.kind === 'rule' || g.list.length > 0)
}
