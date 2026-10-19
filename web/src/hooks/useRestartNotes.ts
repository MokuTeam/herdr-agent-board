// How the restarts asked for on this page went, once each, as a toast (models/schedule.ts
// restartNotes): the board's log of runs says it; what was there when the page opened is old news.
import { useEffect, useRef } from 'react'
import { useT } from '../i18n/I18nProvider.tsx'
import { restartNotes } from '../models/schedule.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'

export function useRestartNotes(): void {
  const t = useT()
  const { data, toast } = useBoardContext()
  const latest = useLatest({ data, t, toast })
  const seen = useRef<Set<string> | null>(null)
  const log = data?.scheduleLog
  useEffect(() => {
    const { data, t, toast } = latest.current
    if (!data) return
    const r = restartNotes(log ?? [], seen.current, key => data.items.find(i => i.key === key)?.name, t)
    seen.current = r.seen
    for (const note of r.toasts) toast(note.text, note.error)
  }, [log, latest])
}
