// The quick look's way through what it shows, without the DOM (the old page's files.js look,
// show, back): a stack of what was opened — a file or folder, a session checkout's changes, the
// past sessions of its project — each step loaded from the server, the last answer winning. The
// changes stay on their step (a step back from a file shows them again without git; refresh
// reads them anew), and so do a history search's query and hits.
import type { Translator } from '../../../src/core/types.ts'
import { fileName, type LookHead, type Preview } from './files.ts'

/** GET /api/session/<key>/changes (adapters/git.ts checkoutChanges). */
export interface Changes {
  available: boolean
  root?: string | undefined
  branch?: string | undefined
  status?: string | undefined
  diff?: string | undefined
  truncated?: boolean | undefined
  collectedAt?: number | undefined
}

/** One past message that matched (adapters/claude-home.ts searchHistory). */
export interface HistoryHit {
  session: string
  role: string
  text: string
  excerpt: string
  date: string | null
  title: string
}

/** GET /api/session/<key>/history?q=… */
export interface HistoryReply {
  results?: HistoryHit[] | undefined
  unavailable?: boolean | undefined
  truncated?: boolean | undefined
}

/** A search on its way, or what it found. */
export type HistoryState = { loading: true } | HistoryReply

/** What the quick look shows a step of. */
export type LookTarget =
  | { kind: 'file'; path: string; line: number | null }
  /** `cache`: the changes as last read. */
  | { kind: 'changes'; key: string; cache?: ChangesLook }
  | { kind: 'history'; key: string; cwd: string; query?: string; result?: HistoryState }

/** A file or folder, with the line it was opened at. */
export type FileLook = Preview & { line: number | null }

/** A checkout's changes as shown: its branch for a name, its root for a path. */
export type ChangesLook = Changes & { kind: 'changes'; name: string; path: string; error: 'unavailable' | null }

/** The past sessions of a project: its folder for a path. */
export interface HistoryLook {
  kind: 'history'
  name: string
  path: string
}

export type LookData = FileLook | ChangesLook | HistoryLook

const ids = new WeakMap<object, number>()
let lastId = 0

/**
 * A number for a step or an answer while it lives: steps and answers are objects of their own, and
 * the parts drawn from them start afresh when they are new (React keys).
 */
export function idOf(thing: object): number {
  const id = ids.get(thing) ?? ++lastId
  ids.set(thing, id)
  return id
}

/** A file or folder carries the line it was opened at; changes say whether git could read them. */
export const isFileLook = (d: LookData): d is FileLook => 'line' in d
export const isChangesLook = (d: LookData): d is ChangesLook => 'available' in d

export type LookMode = 'view' | 'source'

/** What the quick look draws from. */
export interface LookView {
  hidden: boolean
  /** It shrinks back into where it came from. */
  closing: boolean
  /** How many steps deep (Back shows from two). */
  depth: number
  top: LookTarget | null
  head: LookHead
  /** What was loaded last (it stays while the next step loads, as the old page's did). */
  data: LookData | null
  /** The step on show is being loaded. */
  loading: boolean
  /** Markdown as rendered or as source. */
  mode: LookMode
}

export interface QuickLookDeps {
  t(): Translator
  preview(path: string): Promise<Preview>
  changes(key: string): Promise<Changes>
  history(key: string, query: string): Promise<HistoryReply>
  changed(view: LookView): void
}

export interface QuickLookNav {
  view(): LookView
  /** Opens on `target`: the stack starts over. */
  open(target: LookTarget): void
  /** A step further, from what is on show. */
  push(target: LookTarget): void
  /** A step back; false when there is none to go back to. */
  back(): boolean
  /** The step on show read anew (the changes). */
  refresh(): void
  setMode(mode: LookMode): void
  /** A history search: two characters at least. */
  search(query: string): void
  /** It began shrinking away. */
  closing(): void
  /** It is gone: nothing loaded is kept. */
  closed(): void
}

export function quickLookNav(deps: QuickLookDeps): QuickLookNav {
  let hidden = true
  let closing = false
  let stack: LookTarget[] = []
  let head: LookHead = {}
  let data: LookData | null = null
  let loading = false
  let mode: LookMode = 'view'
  let seq = 0

  const view = (): LookView => ({
    hidden,
    closing,
    depth: stack.length,
    top: stack.at(-1) ?? null,
    head,
    data,
    loading,
    mode,
  })
  const changed = () => deps.changed(view())

  function shown(next: LookData): void {
    data = next
    head = next
    loading = false
    changed()
  }

  async function show(fresh = false): Promise<void> {
    const target = stack.at(-1)
    if (!target) return
    const at = ++seq
    if (target.kind === 'changes') return showChanges(target, at, fresh)
    if (target.kind === 'history') return shown({ kind: 'history', name: deps.t()('history.title'), path: target.cwd })
    head = { path: target.path, name: fileName(target.path), kind: 'file' }
    loading = true
    changed()
    const d = await deps.preview(target.path)
    if (at !== seq) return
    if (d.kind !== 'markdown') mode = 'view'
    shown({ ...d, line: target.line })
  }

  async function showChanges(target: Extract<LookTarget, { kind: 'changes' }>, at: number, fresh: boolean) {
    if (target.cache && !fresh) return shown(target.cache)
    const t = deps.t()
    head = { kind: 'changes', name: t('changes.title'), path: target.cache?.path ?? '' }
    loading = true
    changed()
    let d: Changes = { available: false }
    try {
      d = await deps.changes(target.key)
    } catch {}
    if (at !== seq) return
    target.cache = {
      ...d,
      kind: 'changes',
      name: d.branch || t('changes.title'),
      path: d.root ?? '',
      error: d.available ? null : 'unavailable',
    }
    shown(target.cache)
  }

  async function search(target: Extract<LookTarget, { kind: 'history' }>, query: string): Promise<void> {
    target.query = query
    target.result = { loading: true }
    changed()
    const at = ++seq
    let d: HistoryReply = { unavailable: true }
    try {
      d = await deps.history(target.key, query)
    } catch {}
    if (at !== seq || stack.at(-1) !== target) return
    target.result = d
    changed()
  }

  return {
    view,
    open(target) {
      stack = [target]
      hidden = false
      closing = false
      void show()
    },
    push(target) {
      stack.push(target)
      void show()
    },
    back() {
      if (stack.length < 2) return false
      stack.pop()
      void show()
      return true
    },
    refresh: () => void show(true),
    setMode(next) {
      if (!data) return
      mode = next
      changed()
    },
    search(query) {
      const target = stack.at(-1)
      if (target?.kind === 'history' && query.length >= 2) void search(target, query)
    },
    closing() {
      closing = true
      changed()
    },
    closed() {
      hidden = true
      closing = false
      data = null
      loading = false
      changed()
    },
  }
}
