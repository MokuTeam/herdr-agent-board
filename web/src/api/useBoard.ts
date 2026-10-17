// The live board: the event stream plus an uncached snapshot (models/lifecycle.ts), suspended
// while the page is hidden or offline and resumed when it is back.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { boardConnection } from '../models/lifecycle.ts'
import { listenForReveals, type Reveal } from '../models/reveal.ts'
import { api, type BoardPayload, isBoardPayload } from './client.ts'

export interface LiveBoard {
  data: BoardPayload | null
  connected: boolean
  /** The connection dropped (or was suspended) since the page loaded: the dot says it reconnects. */
  dropped: boolean
  /** What goes through herdr (a message, going to a session, waking, sleep) also needs fresh herdr data. */
  canMutate: boolean
  /** Edits the board keeps itself (cards, lanes, language, files) need only the board. */
  canEdit: boolean
  /** Opens a new stream and snapshot, unless the page is hidden or offline. */
  resume(): void
  /**
   * The last session the board was asked to show (a notification clicked: the stream's `reveal`
   * event), one the board had; `n` tells two asks for the same session apart.
   */
  reveal: Reveal | null
}

const pageAway = () => document.hidden || navigator.onLine === false

export function useBoard(): LiveBoard {
  const [data, setData] = useState<BoardPayload | null>(null)
  const [connected, setConnected] = useState(false)
  const [dropped, setDropped] = useState(false)
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const resumeRef = useRef<() => void>(() => {})

  useEffect(() => {
    let version: string | null = null
    let started = false
    // The board as it came last, before React draws it: a `reveal` right after it goes by it.
    let latest: BoardPayload | null = null
    const connection = boardConnection({
      source: () => {
        const stream = new EventSource('/api/events')
        // A notification clicked while this page is open (entrypoints/web-open.ts through /api/reveal).
        listenForReveals(stream, () => latest, setReveal)
        return stream
      },
      snapshot: signal => api.board(signal),
      data(value) {
        if (!isBoardPayload(value)) return
        // The page's own files changed (the plugin was updated): load the new page.
        if (version && value.version && value.version !== version) return location.reload()
        version = value.version
        latest = value
        setData(value)
      },
      connected(value) {
        setConnected(value)
        // The first resume closes a stream that never was: that is no drop.
        if (!value && started) setDropped(true)
      },
    })
    const resume = () => {
      if (!pageAway()) connection.resume()
    }
    const suspend = () => connection.suspend()
    const visibility = () => (document.hidden ? suspend() : resume())
    resumeRef.current = resume
    addEventListener('pageshow', resume)
    addEventListener('online', resume)
    addEventListener('offline', suspend)
    document.addEventListener('visibilitychange', visibility)
    resume()
    started = true
    return () => {
      removeEventListener('pageshow', resume)
      removeEventListener('online', resume)
      removeEventListener('offline', suspend)
      document.removeEventListener('visibilitychange', visibility)
      started = false
      suspend()
    }
  }, [])

  const resume = useCallback(() => resumeRef.current(), [])
  const canMutate = connected && data?.stale === false && data.lastSuccessfulRefreshAt != null
  return useMemo(
    () => ({ data, connected, dropped, canMutate, canEdit: connected, resume, reveal }),
    [data, connected, dropped, canMutate, resume, reveal],
  )
}
