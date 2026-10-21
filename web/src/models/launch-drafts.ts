// A launch draft is one whole form, scoped to the place that opened it. Nothing
// is persisted to disk or sent by restoring it; drafts live in this page for ten minutes.

/** Where the window was opened: a card's folder and lane, else the folder or lane it was asked for. */
export interface DraftPlace {
  item?: { cwd?: string | null | undefined; category?: string | null | undefined } | null | undefined
  cwd?: string | null | undefined
  category?: string | null | undefined
  newWorkspace?: boolean | null | undefined
}

/** The key of the drafts of a place: its folder (case folded for Windows paths), its lane, a new workspace. */
export function launchContext(ctx: DraftPlace, filter = 'all'): string {
  let path = String(ctx.item?.cwd ?? ctx.cwd ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  if (/^[A-Za-z]:\//.test(path) || path.startsWith('//')) path = path.toLowerCase()
  return JSON.stringify([
    path,
    ctx.item?.category ?? ctx.category ?? (filter === 'all' ? '' : filter),
    !!ctx.newWorkspace,
  ])
}

/** The whole form as a draft keeps it (the workspace by its label, or the name of a new one). */
export interface LaunchDraft {
  name: string
  cwd: string
  category: string
  message: string
  workspace: string
  newWorkspace: boolean
  worktree: { branch: string } | null
  /** The agent picked in it (models/launch-agent.ts); none while it followed the board's default. */
  agent?: string
}

export interface DraftBookOptions {
  now?: () => number
  /** ms a draft is kept. */
  lifetime?: number
  /** Drafts kept at most; the oldest go first. */
  limit?: number
}

export interface DraftBook<T> {
  read(key: string): T | null
  /** Keeps `form` for `key`; returns its version (the same while the form does not change). */
  write(key: string, form: T): number
  /** Drops the draft of `key` if it is still the version that was sent. */
  clear(key: string, version: number): void
}

export function launchDraftBook<T = LaunchDraft>({
  now = Date.now,
  lifetime = 600_000,
  limit = 20,
}: DraftBookOptions = {}): DraftBook<T> {
  const entries = new Map<string, { form: T; at: number; version: number }>()
  let serial = 0
  function prune(): void {
    for (const [key, entry] of entries) if (now() - entry.at >= lifetime) entries.delete(key)
    while (entries.size > limit) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
  }
  return {
    read(key) {
      prune()
      const entry = entries.get(key)
      return entry ? structuredClone(entry.form) : null
    },
    write(key, form) {
      prune()
      const previous = entries.get(key)
      const version = previous && JSON.stringify(previous.form) === JSON.stringify(form) ? previous.version : ++serial
      entries.delete(key)
      entries.set(key, { form: structuredClone(form), at: now(), version })
      prune()
      return version
    },
    clear(key, version) {
      if (entries.get(key)?.version === version) entries.delete(key)
    },
  }
}
