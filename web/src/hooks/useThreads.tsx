// Threads on the page (#392): the list the toolbar's pill, the card chips, the sheet's fold and the
// panel share, read from GET /api/threads while the payload says threads are on and again each
// time its revision moves; and which thread the panel shows. With threads off nothing is read and
// the context is null, so every part that asks for it draws nothing.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api } from '../api/client.ts'
import { remotePage, threadsPage } from '../models/remote-page.ts'
import { askedInTurn } from '../models/time.ts'
import type { ThreadRow, ThreadView } from '../models/work-threads.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'

export interface Threads {
  rows: readonly ThreadRow[]
  /** Every key the list knows: what text turns into links. */
  known: ReadonlySet<string>
  /** The revision the list was read at. */
  rev: number
  /** Opens the panel on a thread (null: on the list). */
  open(key: string | null): void
  /** The thread the panel was asked for and its count: two asks for one thread tell apart. */
  asked: { key: string | null; n: number } | null
  /** Whether the panel is open. */
  shown: boolean
  setShown(shown: boolean): void
}

/** The threads while they are on (exported for the tests' own values). */
export const ThreadsContext = createContext<Threads | null>(null)

/** The threads while they are on, else null. */
export const useThreadsContext = (): Threads | null => useContext(ThreadsContext)

const isList = (v: unknown): v is { rev: number; threads: ThreadRow[] } =>
  typeof v === 'object' && v !== null && Array.isArray((v as { threads?: unknown }).threads)

/**
 * The threads' stylesheet (web/styles/threads.css), linked once threads are on and before the
 * Terminal look's sheet, which stays last: a page with threads off loads exactly what it did.
 */
export function linkThreadsSheet(doc: Document = document): void {
  if (doc.getElementById('threads-css')) return
  const link = doc.createElement('link')
  link.id = 'threads-css'
  link.rel = 'stylesheet'
  link.href = 'styles/threads.css'
  const look = doc.querySelector('link[href$="look-terminal.css"]')
  if (look?.parentNode) look.parentNode.insertBefore(link, look)
  else doc.head.append(link)
}

/** Around the page always; while the payload carries no `threads` it reads nothing and gives null. */
export function ThreadsProvider({ children }: { children: ReactNode }) {
  const { data } = useBoardContext()
  // A remote page only for the owner's own login (its routes refuse every other one).
  const on = !!data?.threads && (!remotePage() || threadsPage())
  const rev = data?.threads?.rev ?? 0
  const [list, setList] = useState<{ rev: number; rows: ThreadRow[] }>({ rev: -1, rows: [] })
  const [asked, setAsked] = useState<{ key: string | null; n: number } | null>(null)
  const [shown, setShown] = useState(false)
  const turn = useRef(askedInTurn())

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new revision is when to read again
  useEffect(() => {
    if (!on) return
    const n = turn.current.ask()
    const ctl = new AbortController()
    api
      .get('/api/threads?closed=1', isList, { cache: 'no-store', signal: ctl.signal })
      .then(r => {
        if (turn.current.last(n)) setList({ rev: r.rev, rows: r.threads })
      })
      .catch(() => {})
    return () => ctl.abort()
  }, [on, rev])

  const open = useCallback((key: string | null) => {
    setShown(true)
    setAsked(prev => ({ key, n: (prev?.n ?? 0) + 1 }))
  }, [])
  // The same keys keep the same set: text already linked is not walked again for every revision.
  const keys = list.rows
    .map(r => r.key)
    .sort()
    .join(' ')
  const known = useMemo(() => new Set(keys ? keys.split(' ') : []), [keys])
  const value = useMemo<Threads | null>(
    () => (on ? { rows: list.rows, known, rev: list.rev, open, asked, shown: shown && on, setShown } : null),
    [on, list, known, open, asked, shown],
  )
  return <ThreadsContext.Provider value={value}>{children}</ThreadsContext.Provider>
}

const isView = (v: unknown): v is ThreadView & { rev: number } =>
  typeof v === 'object' && v !== null && typeof (v as { head?: unknown }).head === 'object'

/** One thread with its whole feed, read again when the revision moves; null while it comes or when it is gone. */
export function useThreadView(key: string | null, rev: number): { view: ThreadView | null; gone: boolean } {
  const [state, setState] = useState<{ key: string | null; view: ThreadView | null; gone: boolean }>({
    key: null,
    view: null,
    gone: false,
  })
  const turn = useRef(askedInTurn())
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new revision is when to read again
  useEffect(() => {
    if (!key) return
    const n = turn.current.ask()
    const ctl = new AbortController()
    api
      .get(`/api/threads/${encodeURIComponent(key)}?full=1`, isView, { cache: 'no-store', signal: ctl.signal })
      .then(view => {
        if (turn.current.last(n)) setState({ key, view, gone: false })
      })
      .catch(err => {
        if (turn.current.last(n) && err instanceof ApiError && err.status === 404)
          setState({ key, view: null, gone: true })
      })
    return () => ctl.abort()
  }, [key, rev])
  return state.key === key ? { view: state.view, gone: state.gone } : { view: null, gone: false }
}
