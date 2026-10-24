// The session's numbers under its message box: how full its context is, the model it runs and the
// effort it thinks with. Read only: the same facts the card's sheet shows, for reading while you
// type. Changing them is Claude's own /model and /effort for now.
import { useEffect, useState } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import { api } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'

export function SessionMeter({ item, effort = '' }: { item: Item; effort?: string }) {
  const t = useT()
  // A /effort changes only the screen, and only for this session: read it while the sheet is open.
  const [live, setLive] = useState('')
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const r = await api.sessionEffort(item.key, AbortSignal.timeout(4000))
        if (!stopped && r.effort) setLive(r.effort)
      } catch {}
      if (!stopped) {
        timer = setTimeout(() => void read(), 2000)
        ;(timer as unknown as { unref?: () => void }).unref?.()
      }
    }
    void read()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [item.key])
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
        {t('meter.model')}: {item.model || t('meter.unknown')}
      </span>
      <span className="meter-fact" title={t('meter.effortHint')}>
        {t('meter.effort')}: {live || effort || item.effort || t('meter.unknown')}
      </span>
    </div>
  )
}
