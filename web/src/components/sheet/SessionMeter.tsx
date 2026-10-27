// The session's numbers under its message box: how full its context is, the model it runs and the
// effort it thinks with. Read only: the same facts the card's sheet shows, for reading while you
// type. Changing them is Claude's own /model and /effort for now.
import { useEffect, useState } from 'react'
import { meterReads } from '../../../../src/core/effort.ts'
import type { Item } from '../../../../src/core/types.ts'
import { api } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'

/** asked: counts the /model and /effort messages sent from the box (Composer). */
export function SessionMeter({ item, asked = 0 }: { item: Item; asked?: number }) {
  const t = useT()
  // /model and /effort change only the screen, and only for this session. It is read when the sheet
  // opens, when the session's status moves, and after a /model or /effort sent from the box; not
  // on a timer. Only an awake Claude's screen has those lines (meterReads).
  const reads = meterReads(item)
  const [live, setLive] = useState('')
  const [liveModel, setLiveModel] = useState('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked and the status only ask for a read again.
  useEffect(() => {
    if (!reads) return
    let stopped = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const read = async () => {
      try {
        const r = await api.sessionMeter(item.key, AbortSignal.timeout(4000))
        if (!stopped) {
          if (r.effort) setLive(r.effort)
          if (r.model) setLiveModel(r.model)
        }
      } catch {}
    }
    void read()
    // A /model or /effort just sent shows on screen a moment later: read again then.
    if (asked)
      for (const ms of [1500, 4000]) {
        const timer = setTimeout(() => void read(), ms)
        ;(timer as unknown as { unref?: () => void }).unref?.()
        timers.push(timer)
      }
    return () => {
      stopped = true
      for (const timer of timers) clearTimeout(timer)
    }
  }, [item.key, reads, asked, item.status])
  const context =
    item.contextPct != null
      ? `${Math.round(item.contextPct)}%`
      : item.context
        ? `${Math.round(item.context / 1000)}k`
        : ''
  return (
    <div className="session-meter">
      <span className="meter-ctx" title={t('meter.contextHint')}>
        {context ? t('meter.ctx', { value: context }) : t('meter.ctxNone')}
      </span>
      <span className="meter-fact" title={item.model ?? undefined}>
        {t('meter.model')}: {liveModel || item.model || t('meter.unknown')}
      </span>
      <span className="meter-fact" title={t('meter.effortHint')}>
        {t('meter.effort')}: {live || item.effort || t('meter.unknown')}
      </span>
    </div>
  )
}
