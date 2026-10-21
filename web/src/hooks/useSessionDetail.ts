// The open session's detail (models/detail-resource.ts over GET /api/session/<key>): read when
// the sheet opens it, read again when its card says something new, when the board's data is fresh
// again, when the connection is back or when a session that was gone returns; dropped once the
// sheet closes. A finished result read here counts as viewed.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { ApiError, api, type BoardPayload, type SessionDetail } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { resultToken } from '../models/attention.ts'
import { type DetailValue, detailResource } from '../models/detail-resource.ts'
import { detailOnBoard } from '../models/sheet.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'

export type DetailSnapshot = DetailValue<SessionDetail>

export const emptyDetail = (key: string | null): DetailSnapshot => ({
  key,
  data: null,
  status: 'idle',
  error: '',
  at: null,
})

export interface SessionDetailApi {
  /** The detail of the session the sheet shows, as read so far. */
  value: DetailSnapshot
  /** Reads it again, while it is the open session and on the board (Retry, a message sent). */
  load(key: string): void
}

/** A refusal reads as the server words it, else "Session unavailable"; a 404 says the session is gone. */
async function readDetail(key: string, signal: AbortSignal, t: Translator): Promise<SessionDetail> {
  try {
    return await api.session(key, signal)
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    throw Object.assign(new Error(err.message || t('err.unavailable')), { missing: err.status === 404 })
  }
}

// What a session no longer on the board compares as (its result token is that of an empty one).
const NO_ITEM = { key: '', column: '' }

const itemIn = (data: BoardPayload | null, key: string) => data?.items.find(i => i.key === key)

/**
 * A read again of the conversation on screen says "Refreshing" only once it takes this long: it
 * comes with every step of a working session and is done in a few ms most times (#169). Under the
 * board's refresh (2 s), so a slow read still says so before the next one.
 */
export const REFRESH_QUIET_MS = 1000

/** `shown`: the session the sheet shows (the open one, else the one it showed last). */
export function useSessionDetail(shown: string | null): SessionDetailApi {
  const t = useT()
  const board = useBoardContext()
  const { ui, data, connected, dispatch } = board
  const latest = useLatest({ board, t })
  const [snapshot, setSnapshot] = useState(() => emptyDetail(null))
  const current = useRef(snapshot)
  // What the card said when the detail was last asked for; '' right after opening.
  const stamp = useRef('')

  const [resource] = useState(() =>
    detailResource<SessionDetail>({
      read: (key, signal) => readDetail(key, signal, latest.current.t),
      quietMs: REFRESH_QUIET_MS,
      changed(value) {
        const { board } = latest.current
        if (board.ui.open !== value.key || value.key === null) return
        current.current = value
        setSnapshot(value)
        const read = value.data?.item
        const now = itemIn(board.data, value.key) ?? NO_ITEM
        if (value.status === 'ready' && read && board.data && !board.data.stale && read.column === 'done')
          if (resultToken(read) === resultToken(now)) dispatch({ type: 'viewed', item: read })
      },
    }),
  )

  const load = useCallback(
    (key: string) => {
      const { board } = latest.current
      if (board.ui.open === key && itemIn(board.data, key)) void resource.load(key)
    },
    [latest, resource],
  )

  // Opened (or opened again): from the start; closed: whatever was on its way is dropped.
  const { open, opened } = ui
  // biome-ignore lint/correctness/useExhaustiveDependencies: an opening is when to start over, not something it reads
  useLayoutEffect(() => {
    if (open === null) return resource.cancel()
    resource.reset(open)
    const fresh = resource.snapshot()
    current.current = fresh
    setSnapshot(fresh)
    stamp.current = ''
    load(open)
  }, [open, opened, resource, load])

  // A new board: the session gone, or its detail read again (models/sheet.ts detailOnBoard).
  const before = useRef<BoardPayload | null>(null)
  useEffect(() => {
    const previous = before.current
    before.current = data
    const key = latest.current.board.ui.open
    if (!data || key === null) return
    const step = detailOnBoard({
      before: previous,
      board: data,
      key,
      stamp: stamp.current,
      status: current.current.status,
    })
    if (step?.kind === 'missing') resource.missing()
    else if (step?.kind === 'load') {
      stamp.current = step.stamp
      load(key)
    }
  }, [data, latest, resource, load])

  // The connection is back.
  const wasConnected = useRef(connected)
  useEffect(() => {
    const returned = connected && !wasConnected.current
    wasConnected.current = connected
    const key = latest.current.board.ui.open
    if (returned && key !== null) load(key)
  }, [connected, latest, load])

  return { value: snapshot.key === shown ? snapshot : emptyDetail(shown), load }
}
