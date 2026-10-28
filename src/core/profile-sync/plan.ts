// The profile sync's preview and what Apply carries (the board-on-own-server spec's "Next step:
// syncing the Claude profiles"): from what each side found (its Manifest: its profiles' files and
// their hashes, the hashes of the last sync with the other side, its projects and clones, and as
// the source what it holds back), which files go and where (a project's folder renamed for the
// target), which are the same, which changed on both sides since the last sync (conflicts: the
// owner picks, the target's kept by default; a name that differs only in case on a target that
// does not tell case apart too), which the source deleted since (applied only when ticked), each
// key a merge adds or changes (those that change how the target runs only in the groups ticked),
// session history (only when ticked), and what is listed only: held back, cut (a file a secret
// would be cut from, which the target has), rewritten, can't go, unpaired. Each file goes with the
// target's hash at Look, so the target writes or deletes nothing that changed since. Pure: the
// page shows the preview as it is.
import { claudeJsonChanges, type KeyChange, settingsChanges } from './changes.ts'
import {
  byDepth,
  type CloneFact,
  type Move,
  moved,
  type Pair,
  type Platform,
  type ProjectFact,
  pairProjects,
  projectKey,
  type Unpaired,
} from './paths.ts'
import { type PathRule, ruleMoves, type Suggestion, suggestRules } from './rules.ts'
import {
  type Allow,
  type CarryTo,
  fileGroup,
  historyFile,
  MERGED,
  RUN_GROUPS,
  type RunGroup,
  shareClaudeJson,
  shareSettings,
} from './secrets.ts'

/** Whether session history and edit history go when the owner has not said: the owner decides. */
export const DEFAULT_SYNC_HISTORY = false

/** up: this computer to the server; down: the server to this computer. */
export type Direction = 'up' | 'down'

/** A file as a side has it: its hash, its size. */
export type FileFact = [hash: string, size: number]

export interface ProfileFacts {
  /** default (~/.claude), or the <name> of ~/.claude-<name>. */
  name: string
  dir: string
  /** Each file ('/' between its parts) the sync carries; .claude.json is the profile's own wherever it lies. */
  files: Record<string, FileFact>
  /** Each file's hash at the last sync with the other side. */
  synced: Record<string, string>
  /** The secret files it left out (.credentials.json, copies of .claude.json, .env, keys). */
  secretFiles: string[]
  /** settings.json's and .claude.json's shared parts (no secret in them), for the keys a merge adds or changes. */
  views?: { settings?: Record<string, unknown>; claudeJson?: Record<string, unknown> }
  /** Its settings.json's status line is the board's: a merge keeps it. */
  boardStatusLine?: boolean
}

/** What one side found, as the other side and the preview read it. */
export interface Manifest {
  v: 1
  platform: Platform
  home: string
  profiles: ProfileFacts[]
  projects: ProjectFact[]
  clones: CloneFact[]
  /** As the source: the secrets found in the files it would send (their kinds, never their values); `whole`: a file they cannot be cut from (not text), held back. */
  findings: { profile: string; rel: string; kinds: string[]; whole?: boolean }[]
  /** As the source: what settings.json and .claude.json hold back, and what cannot go to the target. */
  held: { profile: string; what: string }[]
  cantGo: { profile: string; what: string }[]
}

export interface Item {
  profile: string
  /** Its path in the source's profile, and in the target's. */
  from: string
  to: string
  size: number
  kind: 'add' | 'change' | 'merge'
  /** The target's hash at Look; null: it had none. */
  there: string | null
  /** Session or edit history: goes only when ticked. */
  history: boolean
  /** A hook's or the status line's script: goes only when its group is ticked. */
  group?: RunGroup
}

export interface Same {
  profile: string
  from: string
  to: string
  /** Both hashes, recorded as the last sync's. */
  hash: string
  there: string
}

export interface Conflict {
  profile: string
  from: string
  to: string
  size: number
  /** The target's size; null when the target deleted it since. */
  thereSize: number | null
  /** The target's hash at Look; null when it has none. */
  there: string | null
  history: boolean
  group?: RunGroup
  /** The target has it under this name, which differs only in case (Windows, macOS). */
  caseOf?: string
  key: string
}

export interface Deletion {
  profile: string
  from: string
  to: string
  /** The target changed it since the last sync. */
  changedThere: boolean
  /** The target's hash at Look. */
  there: string
  history: boolean
  group?: RunGroup
  key: string
}

/** A key a merge of settings.json or .claude.json adds or changes on the target. */
export interface Change extends KeyChange {
  profile: string
  rel: string
}

export interface ProfilePlan {
  name: string
  /** The profile is not on the target: made there (the owner then signs in to Claude in it). */
  create: boolean
  /** Its folder on the target. */
  dir: string
}

export interface Preview {
  id: string
  direction: Direction
  at: number
  /** The source's and the target's system and home (the paths are written as each writes them). */
  from: { platform: Platform; home: string }
  to: { platform: Platform; home: string }
  profiles: ProfilePlan[]
  items: Item[]
  same: Same[]
  conflicts: Conflict[]
  deletions: Deletion[]
  /** Gone on both sides since the last sync: their hashes forgotten. */
  forget: { profile: string; from: string; to: string }[]
  /** Each key the merges add or change. */
  changes: Change[]
  held: { profile: string; what: string }[]
  /** Files a secret would be cut from, which the target has: never sent over its copy. */
  cut: { profile: string; what: string }[]
  cantGo: { profile: string; what: string }[]
  pairs: Pair[]
  unpaired: Unpaired[]
  /** The path rules in force (the local board's for this server), and those suggested for the projects without a pair. */
  rules: PathRule[]
  suggested: Suggestion[]
  /** Whether each pair's folder (`to`) is on the target, as far as it was asked (a path not here: not known). */
  there: Record<string, boolean>
  /** The projects' paths, as moved to the target's: the transcripts' `cwd`, history.jsonl, .claude.json. */
  moves: Move[]
  /** What goes, in bytes (before packing). */
  bytes: number
}

/** The folder of a profile on a side: ~/.claude, ~/.claude-<name>. */
export function profileDir(home: string, name: string, platform: Platform): string {
  const sep = platform === 'win32' ? '\\' : '/'
  return `${home.replace(/[\\/]+$/, '')}${sep}${name === 'default' ? '.claude' : `.claude-${name}`}`
}

/** A profile file's path on the target: a project's folder renamed by its pair; null for a project left out. */
export function targetRel(rel: string, folders: ReadonlyMap<string, string>): string | null {
  if (!rel.startsWith('projects/')) return rel
  const [, folder = '', ...rest] = rel.split('/')
  if (rest.length === 0) return rel
  const to = folders.get(folder)
  return to === undefined ? null : ['projects', to, ...rest].join('/')
}

/** The project folders of a manifest's profile, for pairing. */
const foldersOf = (m: Manifest): Record<string, string[]> =>
  Object.fromEntries(
    m.profiles.map(p => [
      p.name,
      [
        ...new Set(
          Object.keys(p.files).flatMap(rel => {
            const [top, folder] = rel.split('/')
            return top === 'projects' && folder && rel.split('/').length > 2 ? [folder] : []
          }),
        ),
      ],
    ]),
  )

/**
 * The preview: the source's profiles against the target's of the same name, with the projects
 * paired (`given`: the paths the owner gave, `<profile>/<folder>` to a path, null to leave one out;
 * `rules`: the path rules, PC ↔ server folders; `there`: what is known of the targets' folders).
 */
export function buildPreview(o: {
  id: string
  at: number
  direction: Direction
  source: Manifest
  target: Manifest
  given: Readonly<Record<string, string | null>>
  rules?: readonly PathRule[]
  there?: Readonly<Record<string, boolean>>
}): Preview {
  const { source, target } = o
  const rules = [...(o.rules ?? [])]
  const { pairs, unpaired } = pairProjects({
    source: { platform: source.platform, projects: source.projects },
    target: { platform: target.platform, projects: target.projects, clones: target.clones, folders: foldersOf(target) },
    given: o.given,
    rules: ruleMoves(rules, o.direction, source.platform),
  })
  const known = o.there ?? {}
  const there = Object.fromEntries(pairs.flatMap(x => (x.to in known ? [[x.to, known[x.to] as boolean]] : [])))
  const profiles: ProfilePlan[] = []
  const items: Item[] = []
  const same: Same[] = []
  const conflicts: Conflict[] = []
  const deletions: Deletion[] = []
  const forget: Preview['forget'] = []
  const changes: Change[] = []
  const cut: Preview['cut'] = []
  const wholeHeld: Preview['held'] = []
  const sent = new Set<string>()
  const moves = byDepth(pairs.filter(p => p.from !== '').map(p => ({ from: p.from, to: p.to })))
  const carry: CarryTo = {
    platform: target.platform,
    from: source.platform,
    fromHome: source.home,
    toHome: target.home,
  }
  const found = new Map(source.findings.map(f => [`${f.profile}/${f.rel}`, f]))
  // Windows and macOS tell no case apart in a file's name: a.md and A.md are one file there
  const caseBlind = target.platform === 'win32' || target.platform === 'darwin'
  for (const sp of source.profiles) {
    const tp = target.profiles.find(p => p.name === sp.name) ?? null
    profiles.push({
      name: sp.name,
      create: tp === null,
      dir: tp?.dir ?? profileDir(target.home, sp.name, target.platform),
    })
    const folders = new Map(pairs.filter(p => p.profile === sp.name).map(p => [p.folder, p.toFolder]))
    const there = tp?.files ?? {}
    const thereSynced = tp?.synced ?? {}
    const thereByCase = caseBlind ? new Map(Object.keys(there).map(k => [k.toLowerCase(), k])) : null
    const going = new Map<string, string>()
    for (const [from, [hash, size]] of Object.entries(sp.files)) {
      const to = targetRel(from, folders)
      if (to === null) continue
      const history = historyFile(from)
      const group = fileGroup(from)
      const its = group ? { history, group } : { history }
      const last = sp.synced[from]
      const changedHere = last !== hash
      if (MERGED.has(from)) {
        if (changedHere) {
          items.push({ profile: sp.name, from, to, size, kind: 'merge', there: null, ...its })
          sent.add(`${sp.name}/${from}`)
        }
        continue
      }
      const key = `${sp.name}:${to}`
      const f = found.get(`${sp.name}/${from}`)
      // the target's file of that name in another case, or one going there already
      const other =
        there[to] || !thereByCase ? undefined : (thereByCase.get(to.toLowerCase()) ?? going.get(to.toLowerCase()))
      const t = there[to] ?? (other !== undefined ? there[other] : undefined)
      /** It would go: listed instead when it cannot (held whole, a cut over the target's copy, another case). */
      const goes = (kind: 'add' | 'change' | 'conflict', thereSize: number | null): void => {
        if (f?.whole) {
          wholeHeld.push({ profile: sp.name, what: `${from}: ${f.kinds.join(', ')}` })
          return
        }
        if (f && t) {
          cut.push({ profile: sp.name, what: `${from}: ${f.kinds.join(', ')}` })
          return
        }
        if (thereByCase) going.set(to.toLowerCase(), to)
        if (other !== undefined)
          conflicts.push({
            profile: sp.name,
            from,
            to,
            size,
            thereSize,
            there: t?.[0] ?? null,
            ...its,
            caseOf: other,
            key,
          })
        else if (kind === 'conflict')
          conflicts.push({ profile: sp.name, from, to, size, thereSize, there: t?.[0] ?? null, ...its, key })
        else {
          items.push({ profile: sp.name, from, to, size, kind, there: t?.[0] ?? null, ...its })
          sent.add(`${sp.name}/${from}`)
        }
      }
      if (other !== undefined) {
        if (changedHere || thereSynced[to] === undefined) goes('conflict', t?.[1] ?? null)
        continue
      }
      if (!t) {
        // gone there since the last sync, and changed here since: the owner picks
        if (thereSynced[to] !== undefined && changedHere) goes('conflict', null)
        else if (thereSynced[to] === undefined || changedHere) goes('add', null)
        continue
      }
      const changedThere = thereSynced[to] !== t[0]
      if (!changedHere && !changedThere) continue
      if (last === undefined && thereSynced[to] === undefined && t[0] === hash) {
        same.push({ profile: sp.name, from, to, hash, there: t[0] })
        continue
      }
      if (!changedHere) continue
      goes(changedThere ? 'conflict' : 'change', t[1])
    }
    for (const from of Object.keys(sp.synced)) {
      if (sp.files[from] || MERGED.has(from)) continue
      const to = targetRel(from, folders)
      if (to === null) continue
      const t = there[to]
      if (!t) forget.push({ profile: sp.name, from, to })
      else
        deletions.push({
          profile: sp.name,
          from,
          to,
          changedThere: thereSynced[to] !== t[0],
          there: t[0],
          history: historyFile(from),
          ...(fileGroup(from) && { group: fileGroup(from) as RunGroup }),
          key: `${sp.name}:${to}`,
        })
    }
    // the keys the merges add or change, from both sides' shared parts (the source's as it goes)
    const merging = new Set(items.filter(i => i.profile === sp.name && i.kind === 'merge').map(i => i.from))
    if (merging.has('settings.json'))
      for (const c of settingsChanges(
        shareSettings(sp.views?.settings ?? {}, carry).value,
        tp?.views?.settings ?? {},
        tp?.boardStatusLine === true,
      ))
        changes.push({ profile: sp.name, rel: 'settings.json', ...c })
    if (merging.has('.claude.json'))
      for (const c of claudeJsonChanges(
        shareClaudeJson(sp.views?.claudeJson ?? {}, carry, path => moved(path, moves, source.platform, target.platform))
          .value,
        tp?.views?.claudeJson ?? {},
      ))
        changes.push({ profile: sp.name, rel: '.claude.json', ...c })
  }
  const held = [
    ...source.profiles.flatMap(p => p.secretFiles.map(rel => ({ profile: p.name, what: rel }))),
    ...source.held,
    ...wholeHeld,
    ...source.findings
      .filter(
        f =>
          !f.whole &&
          (sent.has(`${f.profile}/${f.rel}`) || conflicts.some(c => c.profile === f.profile && c.from === f.rel)),
      )
      .map(f => ({ profile: f.profile, what: `${f.rel}: ${f.kinds.join(', ')}` })),
  ]
  return {
    id: o.id,
    direction: o.direction,
    at: o.at,
    from: { platform: source.platform, home: source.home },
    to: { platform: target.platform, home: target.home },
    profiles,
    items,
    same,
    conflicts,
    deletions,
    forget,
    changes,
    held,
    cut,
    cantGo: source.cantGo,
    pairs,
    unpaired,
    rules,
    suggested: suggestRules(unpaired, o.direction, source, target),
    there,
    moves,
    bytes: items.reduce((n, i) => n + i.size, 0),
  }
}

/** Every tick, each said: a run group only when ticked, session history as the owner said (else its default). */
export type Ticks = Readonly<Record<RunGroup | 'history', boolean>>

export function ticksOf(a: Allow | null | undefined): Ticks {
  return {
    ...(Object.fromEntries(RUN_GROUPS.map(g => [g, a?.[g] === true])) as Record<RunGroup, boolean>),
    history: typeof a?.history === 'boolean' ? a.history : DEFAULT_SYNC_HISTORY,
  }
}

/** The owner's choices on a preview: each conflict's side (the target's when none), the deletions ticked, the groups ticked. */
export interface Choices {
  conflicts: Readonly<Record<string, 'source' | 'target'>>
  deletions: readonly string[]
  allow?: Allow
}

/** A file Apply sends: `expect`, the target's hash at Look (null: none there), for a file not merged. */
export interface Send {
  profile: string
  from: string
  to: string
  merge: boolean
  expect?: string | null
  history: boolean
}

/** What Apply carries: the files to send (the conflicts the owner gave the source's among them), the deletions ticked, the rest recorded. */
export interface Transfer {
  profiles: ProfilePlan[]
  send: Send[]
  deletions: { profile: string; from: string; to: string; expect: string; history: boolean }[]
  same: Same[]
  forget: { profile: string; from: string; to: string }[]
  moves: Move[]
  bytes: number
  allow: Ticks
}

export function transferOf(p: Preview, c: Choices): Transfer {
  const allow = ticksOf(c.allow)
  const goes = (x: { history: boolean; group?: RunGroup }): boolean =>
    (!x.history || allow.history) && (x.group === undefined || allow[x.group])
  const ticked = new Set(c.deletions)
  const items = p.items.filter(goes)
  const taken = p.conflicts.filter(x => c.conflicts[x.key] === 'source' && goes(x))
  const send: Send[] = [
    ...items.map(i => ({
      profile: i.profile,
      from: i.from,
      to: i.to,
      merge: i.kind === 'merge',
      ...(i.kind !== 'merge' && { expect: i.there }),
      history: i.history,
    })),
    ...taken.map(x => ({
      profile: x.profile,
      from: x.from,
      to: x.to,
      merge: false,
      expect: x.there,
      history: x.history,
    })),
  ]
  const used = new Set(send.map(s => s.profile))
  return {
    // a profile is made on the target only when something goes into it
    profiles: p.profiles.filter(x => !x.create || used.has(x.name)),
    send,
    deletions: p.deletions
      .filter(d => ticked.has(d.key) && goes(d))
      .map(d => ({ profile: d.profile, from: d.from, to: d.to, expect: d.there, history: d.history })),
    same: p.same,
    forget: p.forget,
    moves: p.moves,
    bytes: items.reduce((n, i) => n + i.size, 0) + taken.reduce((n, x) => n + x.size, 0),
    allow,
  }
}

/** Where a preview's file belongs in the list: its top folder, a project's own folder for one under projects/. */
export function areaOf(rel: string): string {
  const parts = rel.split('/')
  if (parts[0] === 'projects' && parts.length > 2) return `projects/${parts[1]}`
  return parts.length > 1 ? (parts[0] as string) : '.'
}

/** Items grouped by area, in the order the areas come, each area's count and bytes. */
export function byArea<T extends { from: string; size?: number; thereSize?: number | null }>(
  list: readonly T[],
): { area: string; list: T[]; bytes: number }[] {
  const groups = new Map<string, { area: string; list: T[]; bytes: number }>()
  for (const x of list) {
    const area = areaOf(x.from)
    const g = groups.get(area) ?? { area, list: [], bytes: 0 }
    g.list.push(x)
    g.bytes += x.size ?? 0
    groups.set(area, g)
  }
  return [...groups.values()].sort((a, b) => a.area.localeCompare(b.area))
}

/** A size in words: 512 B, 3.4 KB, 12 MB, 1.7 GB. */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`
}

/** A project key, for the page's fields. */
export { projectKey }
