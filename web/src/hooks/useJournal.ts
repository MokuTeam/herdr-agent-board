// The away journal's strip on the page (#489): the payload's strip of the last return until it is
// dismissed (on every page: POST /api/journal), and the same list opened again from the toolbar's
// "Since 23:56" (GET /api/journal, up to now), which closes on this page only.
import { useCallback, useState } from 'react'
import type { JournalList } from '../../../src/core/journal.ts'
import { api } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { isJournalList, journalButton, stripTitle } from '../models/journal.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'

export interface JournalView {
  /** What the strip shows now: its title and list; null while it is closed. */
  shown: { title: string; list: JournalList } | null
  /** The toolbar button's words, null while there is no return to open again. */
  button: string | null
  /** The toolbar's button: closes the strip on show, else opens the last return's list since it began. */
  toggle(): void
  close(): void
  /** A row: its card's sheet, while the card is on the board. */
  open(key: string): void
  onBoard(key: string): boolean
}

const isAnswer = (v: unknown): v is { journal: JournalList } =>
  typeof v === 'object' && v !== null && isJournalList((v as { journal?: unknown }).journal)

export function useJournal(): JournalView {
  const t = useT()
  const { data, dispatch, toast, now } = useBoardContext()
  const strip = data?.journal?.strip ?? null
  const last = data?.journal?.last ?? null
  // The return dismissed here, before the payload says so.
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [again, setAgain] = useState<{ from: number; list: JournalList } | null>(null)
  const items = data?.items

  const close = useCallback(() => {
    if (again) return setAgain(null)
    if (!strip) return
    setDismissed(strip.to)
    api.post('/api/journal', { op: 'dismiss' }).catch(() => setDismissed(null))
  }, [again, strip])

  const toggle = useCallback(() => {
    if (again) return setAgain(null)
    // The return's own strip on show: the pill closes it on this page (the X dismisses it everywhere).
    if (strip && dismissed !== strip.to) return setDismissed(strip.to)
    if (!last) return
    const from = last.from
    api
      .get(`/api/journal?since=${from}`, isAnswer, { cache: 'no-store' })
      .then(r => setAgain({ from, list: r.journal }))
      .catch(() => toast(t('journal.failed'), true))
  }, [again, strip, dismissed, last, toast, t])

  const onBoard = useCallback((key: string) => !!items?.some(i => i.key === key), [items])
  const open = useCallback(
    (key: string) => {
      if (onBoard(key)) dispatch({ type: 'open', key })
      else toast(t('journal.gone'))
    },
    [onBoard, dispatch, toast, t],
  )

  const shown = again
    ? { title: stripTitle(again.from, null, t, now), list: again.list }
    : strip && dismissed !== strip.to
      ? { title: stripTitle(strip.from, strip.to, t, now), list: strip }
      : null
  return { shown, button: journalButton(last, t, now), toggle, close, open, onBoard }
}
