// Links that open a thread (#392, docs/design/threads 8), while threads are on: the address of a page
// opened for one (#thread=<key>, from `board thread link`, a chat or the phone), shown once the
// board is in, and the same address followed in a tab that has the page open already; the stream's `thread-open` (`board thread open`, web-open.ts --thread) while the page
// is open; and a click on a link to this page's own #thread= or #session= anywhere in it (an entry,
// a bubble, a key turned into a link), which stays on the page instead of going to the browser.
import { useEffect, useRef } from 'react'
import { boardLinkOf, threadInHash } from '../models/work-threads.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'
import { useThreadsContext } from './useThreads.tsx'

export function useThreadLinks(): void {
  const { threadOpen, dispatch } = useBoardContext()
  const threads = useThreadsContext()
  const latest = useLatest({ threads, dispatch })
  const onLoad = useRef<string | null>(null)

  // The page opened for a thread: its address says which (read as the page starts)…
  useEffect(() => {
    onLoad.current = threadInHash(location.hash)
  }, [])
  // …shown once threads are in, and the address forgets it.
  useEffect(() => {
    const key = onLoad.current
    if (!threads || !key) return
    onLoad.current = null
    history.replaceState(history.state, '', location.pathname + location.search)
    threads.open(key)
  }, [threads])

  // Told while open: each ask once, by its count.
  const asked = threadOpen?.n ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once, by its count
  useEffect(() => {
    if (threadOpen) latest.current.threads?.open(threadOpen.key)
  }, [asked])

  const on = !!threads
  // A link to this page followed in the same tab: only its address changes.
  useEffect(() => {
    if (!on) return
    const onHash = () => {
      const key = threadInHash(location.hash)
      if (!key) return
      history.replaceState(history.state, '', location.pathname + location.search)
      latest.current.threads?.open(key)
    }
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [on, latest])
  useEffect(() => {
    if (!on) return
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null
      const link = a && boardLinkOf(a.href, location)
      if (!link) return
      e.preventDefault()
      e.stopPropagation()
      if ('thread' in link) latest.current.threads?.open(link.thread)
      else latest.current.dispatch({ type: 'open', key: link.session })
    }
    // Before the board's own link handling (hooks/useFileLinks.ts), which sends links to the browser.
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [on, latest])
}
