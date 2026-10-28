// The profile sync's preview and what Apply carries (the board-on-own-server spec's "Next step:
// syncing the Claude profiles"): from what each side found (its Manifest: its profiles' files and
// their hashes, the hashes of the last sync with the other side, its projects and clones, and as
// the source what it holds back), which files go and where (a project's folder renamed for the
// target), which are the same, which changed on both sides since the last sync (conflicts: the
// owner picks, the target's kept by default), which the source deleted since (applied only when
// ticked), and what is listed only: held back, rewritten, can't go, unpaired. Pure: the page
// shows the preview as it is.
import {
  byDepth,
  type CloneFact,
  type Move,
  type Pair,
  type Platform,
  type ProjectFact,
  pairProjects,
  projectKey,
  type Unpaired,
} from './paths.ts'
import { MERGED } from './secrets.ts'

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
  /** The secret files it left out (.credentials.json, copies of .claude.json). */
  secretFiles: string[]
}

/** What one side found, as the other side and the preview read it. */
export interface Manifest {
  v: 1
  platform: Platform
  home: string
  profiles: ProfileFacts[]
  projects: ProjectFact[]
  clones: CloneFact[]
  /** As the source: the secrets found in the files it would send (their kinds, never their values). */
  findings: { profile: string; rel: string; kinds: string[] }[]
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
  key: string
}

export interface Deletion {
  profile: string
  from: string
  to: string
  /** The target changed it since the last sync. */
  changedThere: boolean
  key: string
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
  held: { profile: string; what: string }[]
  cantGo: { profile: string; what: string }[]
  pairs: Pair[]
  unpaired: Unpaired[]
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
 * paired (`given`: the paths the owner gave, `<profile>/<folder>` to a path, null to leave one out).
 */
export function buildPreview(o: {
  id: string
  at: number
  direction: Direction
  source: Manifest
  target: Manifest
  given: Readonly<Record<string, string | null>>
}): Preview {
  const { source, target } = o
  const { pairs, unpaired } = pairProjects({
    source: { platform: source.platform, projects: source.projects },
    target: { platform: target.platform, projects: target.projects, clones: target.clones, folders: foldersOf(target) },
    given: o.given,
  })
  const profiles: ProfilePlan[] = []
  const items: Item[] = []
  const same: Same[] = []
  const conflicts: Conflict[] = []
  const deletions: Deletion[] = []
  const forget: Preview['forget'] = []
  const sent = new Set<string>()
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
    for (const [from, [hash, size]] of Object.entries(sp.files)) {
      const to = targetRel(from, folders)
      if (to === null) continue
      const t = there[to]
      const last = sp.synced[from]
      const changedHere = last !== hash
      const merge = MERGED.has(from)
      if (merge) {
        if (changedHere) {
          items.push({ profile: sp.name, from, to, size, kind: 'merge' })
          sent.add(`${sp.name}/${from}`)
        }
        continue
      }
      if (!t) {
        // gone there since the last sync, and changed here since: the owner picks
        if (thereSynced[to] !== undefined && changedHere)
          conflicts.push({ profile: sp.name, from, to, size, thereSize: null, key: `${sp.name}:${to}` })
        else if (thereSynced[to] === undefined || changedHere) {
          items.push({ profile: sp.name, from, to, size, kind: 'add' })
          sent.add(`${sp.name}/${from}`)
        }
        continue
      }
      const changedThere = thereSynced[to] !== t[0]
      if (!changedHere && !changedThere) continue
      if (last === undefined && thereSynced[to] === undefined && t[0] === hash) {
        same.push({ profile: sp.name, from, to, hash, there: t[0] })
        continue
      }
      if (!changedHere) continue
      if (changedThere) conflicts.push({ profile: sp.name, from, to, size, thereSize: t[1], key: `${sp.name}:${to}` })
      else {
        items.push({ profile: sp.name, from, to, size, kind: 'change' })
        sent.add(`${sp.name}/${from}`)
      }
    }
    for (const from of Object.keys(sp.synced)) {
      if (sp.files[from] || MERGED.has(from)) continue
      const to = targetRel(from, folders)
      if (to === null) continue
      const t = there[to]
      if (!t) forget.push({ profile: sp.name, from, to })
      else
        deletions.push({ profile: sp.name, from, to, changedThere: thereSynced[to] !== t[0], key: `${sp.name}:${to}` })
    }
  }
  const held = [
    ...source.profiles.flatMap(p => p.secretFiles.map(rel => ({ profile: p.name, what: rel }))),
    ...source.held,
    ...source.findings
      .filter(
        f => sent.has(`${f.profile}/${f.rel}`) || conflicts.some(c => c.profile === f.profile && c.from === f.rel),
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
    held,
    cantGo: source.cantGo,
    pairs,
    unpaired,
    moves: byDepth(pairs.filter(p => p.from !== '').map(p => ({ from: p.from, to: p.to }))),
    bytes: items.reduce((n, i) => n + i.size, 0),
  }
}

/** The owner's choices on a preview: each conflict's side (the target's when none), the deletions ticked. */
export interface Choices {
  conflicts: Readonly<Record<string, 'source' | 'target'>>
  deletions: readonly string[]
}

/** What Apply carries: the files to send (the conflicts the owner gave the source's among them), the deletions ticked, the rest recorded. */
export interface Transfer {
  profiles: ProfilePlan[]
  send: { profile: string; from: string; to: string; merge: boolean }[]
  deletions: { profile: string; from: string; to: string }[]
  same: Same[]
  forget: { profile: string; from: string; to: string }[]
  moves: Move[]
  bytes: number
}

export function transferOf(p: Preview, c: Choices): Transfer {
  const ticked = new Set(c.deletions)
  const taken = p.conflicts.filter(x => c.conflicts[x.key] === 'source')
  const send = [
    ...p.items.map(i => ({ profile: i.profile, from: i.from, to: i.to, merge: i.kind === 'merge' })),
    ...taken.map(x => ({ profile: x.profile, from: x.from, to: x.to, merge: false })),
  ]
  const used = new Set(send.map(s => s.profile))
  return {
    // a profile is made on the target only when something goes into it
    profiles: p.profiles.filter(x => !x.create || used.has(x.name)),
    send,
    deletions: p.deletions.filter(d => ticked.has(d.key)).map(d => ({ profile: d.profile, from: d.from, to: d.to })),
    same: p.same,
    forget: p.forget,
    moves: p.moves,
    bytes: p.items.reduce((n, i) => n + i.size, 0) + taken.reduce((n, x) => n + x.size, 0),
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
