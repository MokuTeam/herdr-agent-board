// Shows a session a notification was about (src/entrypoints/web-open.ts): its sheet, and its card
// in view. Asked through the event stream while the page is open (api/useBoard.ts `reveal`), or by
// the address of a page opened for it (#session=<key>), shown once the board is in.
import { useEffect, useRef } from 'react'
import { revealStep, sessionInHash } from '../models/reveal.ts'
import { reducedMotion } from '../models/spring.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'

export function useReveal(): void {
  const { data, reveal, ui, dispatch } = useBoardContext()
  const latest = useLatest({ data, open: ui.open, dispatch })
  const onLoad = useRef<string | null>(null)

  // The page opened for a session: its address says which (read as the page starts)…
  useEffect(() => {
    onLoad.current = sessionInHash(location.hash)
  }, [])
  // …shown once the board is in, and the address forgets it.
  useEffect(() => {
    const key = onLoad.current
    if (!data || !key) return
    onLoad.current = null
    history.replaceState(history.state, '', location.pathname + location.search)
    show(latest.current, key)
  }, [data, latest])

  // Told while open.
  useEffect(() => {
    if (reveal) show(latest.current, reveal.key)
  }, [reveal, latest])
}

type Board = Pick<ReturnType<typeof useBoardContext>, 'data' | 'dispatch'> & { open: string | null }

function show({ data, open, dispatch }: Board, key: string): void {
  const step = revealStep(key, data?.items ?? [], open)
  if (!step) return
  if (step.openSheet) dispatch({ type: 'open', key })
  document
    .querySelector(`.card[data-key="${CSS.escape(key)}"]`)
    ?.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' })
}
