// The Time panel (#233): one day by client, as it will be billed, read only. From the top: the day
// with the day before and after and Today; the clients of that day as chips (All, then each with
// its billed hours, in its lane's color); then each client's billed lines, a line's entries under
// it with their times on this browser's clock, the description, the project and who logged it;
// the held entries (a tag the config leaves out) apart; the day's totals. Asked when it opens,
// when the day changes, and again whenever the board's time line says the store changed. On a
// phone (the full-height sheet) a horizontal swipe changes the day: the list follows the finger
// and settles back, or goes to the day it was swiped to; with reduced motion, it only changes.
import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react'
import { errorText, replyOf } from '../../api/client.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { reducedMotion } from '../../models/spring.ts'
import {
  byText,
  dateName,
  entryTimes,
  hm,
  hoursText,
  isTimeDay,
  lineLabel,
  ruleText,
  shiftDate,
  swipeDay,
  type TimeDay,
} from '../../models/time.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { Panel } from '../panel/Panel.tsx'

export interface TimePanelProps {
  open: boolean
  onClose(): void
  /** The client the panel opened on (a lane's total); null: all of them. */
  client: string | null
  onClient(client: string | null): void
}

export function TimePanel({ open, onClose, client, onClient }: TimePanelProps) {
  const t = useT()
  const { data, toast, dispatch } = useBoardContext()
  const latest = useLatest({ t, toast })
  const today = data?.time?.date ?? new Date().toISOString().slice(0, 10)
  const seq = data?.time?.seq ?? 0
  const [date, setDate] = useState(today)
  const [day, setDay] = useState<TimeDay | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ask = useCallback(
    async (d: string) => {
      try {
        const res = await fetch(`/api/time?date=${encodeURIComponent(d)}`, { cache: 'no-store' })
        const value = await replyOf(res)
        if (res.ok && isTimeDay(value)) {
          setDay(value)
          setError(null)
        } else setError(String((value as { error?: unknown }).error ?? res.status))
      } catch (err) {
        setError(errorText(err, latest.current.t))
      }
    },
    [latest],
  )

  // Opened on today; a new day of the board's (past midnight) follows while it shows today.
  const shownToday = useRef(today)
  useEffect(() => {
    if (date === shownToday.current) setDate(today)
    shownToday.current = today
  }, [today, date])
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the store's seq moves
  useEffect(() => {
    if (open) void ask(date)
  }, [open, date, seq, ask])

  const go = (days: number) => setDate(d => shiftDate(d, days))
  const swipe = useSwipe(go)
  const lang = t.lang
  const entries = new Map((day?.entries ?? []).map(e => [e.id, e]))
  const days = (day?.days ?? []).filter(d => !client || d.client === client)
  const cats = new Map((data?.categories ?? []).map(c => [c.id, c]))
  const title = (id: string) => cats.get(id)?.title ?? id
  const color = (id: string) => cats.get(id)?.color ?? 'var(--label-3)'
  const total = days.reduce((n, d) => n + d.billedSeconds, 0)
  const raw = days.reduce((n, d) => n + d.seconds, 0)

  return (
    <Panel
      id="time-sheet"
      kind="time"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('time.title')}</h2>
          <p className="sheet-meta">{t('time.about')}</p>
        </>
      }
    >
      <div className="sheet-body cats-body time-body">
        <div className="time-nav">
          <button type="button" className="button time-step" aria-label={t('time.prev')} onClick={() => go(-1)}>
            ‹
          </button>
          <span className="time-date">{dateName(date, lang)}</span>
          <button type="button" className="button time-step" aria-label={t('time.next')} onClick={() => go(1)}>
            ›
          </button>
          <button type="button" className="button" disabled={date === today} onClick={() => setDate(today)}>
            {t('time.today')}
          </button>
        </div>
        {day && <p className="sheet-meta time-zone">{t('time.zone', { zone: day.zone })}</p>}
        {day && day.days.length > 0 && (
          <div className="time-chips">
            <button
              type="button"
              aria-pressed={!client}
              className={classNames('time-chip', !client && 'on')}
              onClick={() => onClient(null)}
            >
              {t('time.all')}{' '}
              <span>
                {hoursText(
                  day.days.reduce((n, d) => n + d.billedSeconds, 0),
                  t,
                )}
              </span>
            </button>
            {day.days.map(d => (
              <button
                type="button"
                aria-pressed={client === d.client}
                key={d.client}
                className={classNames('time-chip', client === d.client && 'on')}
                style={{ '--lane': color(d.client) }}
                onClick={() => onClient(d.client)}
              >
                {title(d.client)} <span>{hoursText(d.billedSeconds, t)}</span>
              </button>
            ))}
          </div>
        )}
        {error && <p className="access-problem">{t('time.loadError', { error })}</p>}
        <div className="time-days" {...swipe.handlers} style={swipe.style}>
          {day && !days.length && <p className="sheet-meta time-empty">{t('time.empty')}</p>}
          {days.map(d => (
            <section className="time-client" key={d.client} style={{ '--lane': color(d.client) }}>
              <h3 className="time-client-head">
                <span className="time-client-name">{title(d.client)}</span>
                <span className="time-figures">
                  {hm(d.seconds)} → <strong>{hoursText(d.billedSeconds, t)}</strong>
                </span>
              </h3>
              {d.lines.map(l => (
                <div className="time-line" key={l.key}>
                  <div className="time-line-head">
                    <span className="time-line-name">{lineLabel(l, t)}</span>
                    <span className="time-figures">
                      {hm(l.seconds)} → <strong>{hoursText(l.billedSeconds, t)}</strong>
                    </span>
                    <span className="sheet-meta time-rule">{ruleText(l, t)}</span>
                  </div>
                  <ul className="time-entries">
                    {l.entries.map(id => {
                      const e = entries.get(id)
                      if (!e) return null
                      return (
                        <li className="time-entry" key={id}>
                          <span className="time-when">{entryTimes(e, lang)}</span>
                          <span className="time-what">{e.description}</span>
                          <span className="sheet-meta time-who">
                            {e.project} ·{' '}
                            {typeof e.by !== 'string' &&
                            data?.items.some(i => i.key === (e.by as { key: string }).key) ? (
                              <button
                                type="button"
                                className="time-session"
                                onClick={() => dispatch({ type: 'open', key: (e.by as { key: string }).key })}
                              >
                                {byText(e, t)}
                              </button>
                            ) : (
                              byText(e, t)
                            )}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
              {d.held.length > 0 && (
                <div className="time-line time-held">
                  <div className="time-line-head">
                    <span className="time-line-name">{t('time.held')}</span>
                  </div>
                  <ul className="time-entries">
                    {d.held.map(id => {
                      const e = entries.get(id)
                      if (!e) return null
                      return (
                        <li className="time-entry" key={id}>
                          <span className="time-when">{entryTimes(e, lang)}</span>
                          <span className="time-what">{e.description}</span>
                          <span className="sheet-meta time-who">
                            {hm(e.seconds)} · #{e.tags.join(' #')}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </section>
          ))}
          {days.length > 1 && (
            <p className="time-total">
              {t('time.day')}{' '}
              <span className="time-figures">
                {hm(raw)} → <strong>{hoursText(total, t)}</strong>
              </span>
            </p>
          )}
        </div>
      </div>
    </Panel>
  )
}

/**
 * A horizontal swipe on a touch screen changes the day: the list follows the finger 1:1 once the
 * drag is clearly sideways (10 px, more across than down), and on release goes to the day before or
 * after (models/time.ts swipeDay) or settles back. A mouse does nothing here (the arrows do it).
 */
function useSwipe(go: (days: number) => void) {
  const [dx, setDx] = useState(0)
  const [settling, setSettling] = useState(false)
  const from = useRef<{ x: number; y: number; at: number; id: number; sideways: boolean | null } | null>(null)
  const width = useRef(360)
  const end = (e: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const f = from.current
    from.current = null
    if (!f?.sideways) return
    const moved = e.clientX - f.x
    const which = cancelled ? 0 : swipeDay(moved, e.timeStamp - f.at, width.current)
    setSettling(!reducedMotion.matches)
    setDx(0)
    if (which) go(which)
  }
  return {
    style: dx
      ? { transform: `translateX(${dx}px)`, transition: 'none' }
      : settling
        ? { transition: 'transform 0.3s cubic-bezier(0.2, 0.9, 0.3, 1)' }
        : undefined,
    handlers: {
      onPointerDown(e: PointerEvent<HTMLDivElement>) {
        if (e.pointerType !== 'touch') return
        width.current = e.currentTarget.getBoundingClientRect().width || 360
        from.current = { x: e.clientX, y: e.clientY, at: e.timeStamp, id: e.pointerId, sideways: null }
        setSettling(false)
      },
      onPointerMove(e: PointerEvent<HTMLDivElement>) {
        const f = from.current
        if (!f || f.id !== e.pointerId) return
        const x = e.clientX - f.x
        const y = e.clientY - f.y
        if (f.sideways === null && Math.hypot(x, y) > 10) {
          f.sideways = Math.abs(x) > Math.abs(y) * 1.5
          if (f.sideways) e.currentTarget.setPointerCapture(e.pointerId)
        }
        if (f.sideways && !reducedMotion.matches) setDx(x)
      },
      onPointerUp: (e: PointerEvent<HTMLDivElement>) => end(e, false),
      onPointerCancel: (e: PointerEvent<HTMLDivElement>) => end(e, true),
    },
  }
}
