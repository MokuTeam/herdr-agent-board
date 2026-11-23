// Token spend panel (#636): per-lane, per-day token spend beside Time.
// Fetches GET /api/spend only when opened; nothing runs for setups that never open it.
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { formatTokens, type SpendCounts, type SpendReport } from '../../../../src/core/spend.ts'
import { errorText, replyOf } from '../../api/client.ts'
import { useLaneFades } from '../../hooks/useLaneFades.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useSegmentThumb } from '../../hooks/useSegmentThumb.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { cellTooltip, isSpendReport, SPEND_VIEWS, type SpendView, shortDayHead, weekRange } from '../../models/spend.ts'
import { askedInTurn, dateName, dayTitle, shiftDate } from '../../models/time.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { ChevIcon } from '../icons.tsx'
import { Panel } from '../panel/Panel.tsx'

export interface SpendPanelProps {
  open: boolean
  onClose(): void
}

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function SpendPanel({ open, onClose }: SpendPanelProps) {
  const t = useT()
  const { data, dispatch } = useBoardContext()
  const latest = useLatest({ t })
  const today = data?.time?.date ?? localToday()
  const [date, setDate] = useState(today)
  const [view, setView] = useState<SpendView>('week')
  const [lane, setLane] = useState<string | null>(null)
  const [report, setReport] = useState<SpendReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const turns = useRef(askedInTurn())

  const range = view === 'day' ? { from: date, to: date, days: [date] } : weekRange(date)

  const load = useCallback(
    async (v: SpendView, d: string) => {
      const n = turns.current.ask()
      setLoading(true)
      setError(null)
      try {
        const url =
          v === 'day'
            ? `/api/spend?day=${encodeURIComponent(d)}`
            : (() => {
                const r = weekRange(d)
                return `/api/spend?from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`
              })()
        const res = await fetch(url, { cache: 'no-store' })
        const body = await replyOf(res)
        if (!turns.current.last(n)) return
        if (res.ok && isSpendReport(body)) {
          setReport(body)
          setError(null)
        } else {
          setError(String((body as { error?: unknown }).error ?? res.status))
        }
      } catch (err) {
        if (turns.current.last(n)) setError(errorText(err, latest.current.t))
      } finally {
        if (turns.current.last(n)) setLoading(false)
      }
    },
    [latest],
  )

  // Reset to today and default 7-day view each time the panel opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening and closing only
  useEffect(() => {
    if (open) {
      setDate(today)
      setLane(null)
    } else {
      setView('week')
      setError(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    void load(view, date)
  }, [open, view, date, load])

  const viewsControl = useRef<HTMLDivElement>(null)
  const viewsThumb = useRef<HTMLSpanElement>(null)
  useSegmentThumb(viewsControl, viewsThumb, view, t.lang)

  const chipsRef = useRef<HTMLDivElement>(null)
  useLaneFades(chipsRef)

  const cats = new Map((data?.categories ?? []).map(c => [c.id, c]))
  const laneTitle = (id: string) => cats.get(id)?.title ?? id
  const laneColor = (id: string) => cats.get(id)?.color ?? 'var(--label-3)'

  const shown = report && report.from === range.from && report.to === range.to ? report : null
  const lanes = shown?.lanes ?? []
  const filteredLanes = lane ? lanes.filter(l => l.lane === lane) : lanes
  const filteredSessions = (shown?.sessions ?? []).filter(s => !lane || s.lane === lane)
  const summaryCounts: SpendCounts =
    lane && filteredLanes.length === 1
      ? (filteredLanes[0]?.counts ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, responses: 0 })
      : lane
        ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, responses: 0 }
        : (shown?.total ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, responses: 0 })

  const step = (dir: number) => setDate(d => shiftDate(d, view === 'day' ? dir : dir * 7))
  const onToday = view === 'day' ? date === today : range.days.includes(today)
  const navTitle =
    view === 'day' ? dayTitle(date, t.lang) : `${dateName(range.from, t.lang)} - ${dateName(range.to, t.lang)}`

  const activeDayCols = shown?.days.filter(d => !lane || (d.byLane[lane]?.total ?? 0) > 0).map(d => d.day) ?? []

  return (
    <Panel id="spend-sheet" kind="spend" open={open} onClose={onClose} title={<h2>{t('spend.title')}</h2>}>
      <div className="sheet-body cats-body time-body spend-body">
        <div className="segmented time-views" role="tablist" aria-label={t('spend.views')} ref={viewsControl}>
          <span className="thumb" ref={viewsThumb} />
          {SPEND_VIEWS.map(v => (
            <button type="button" key={v} role="tab" data-id={v} aria-selected={v === view} onClick={() => setView(v)}>
              {t(`spend.view.${v}`)}
            </button>
          ))}
        </div>

        <div className="time-nav">
          <h3
            className="time-date"
            aria-live="polite"
            title={shown ? t('spend.zone', { zone: shown.zone }) : undefined}
          >
            {navTitle}
          </h3>
          <button
            type="button"
            className="icon-button time-step time-prev"
            title={t(view === 'day' ? 'spend.prevDay' : 'spend.prevWeek')}
            aria-label={t(view === 'day' ? 'spend.prevDay' : 'spend.prevWeek')}
            onClick={() => step(-1)}
          >
            <ChevIcon />
          </button>
          <button type="button" className="button time-today" disabled={onToday} onClick={() => setDate(today)}>
            {t('spend.today')}
          </button>
          <button
            type="button"
            className="icon-button time-step"
            title={t(view === 'day' ? 'spend.nextDay' : 'spend.nextWeek')}
            aria-label={t(view === 'day' ? 'spend.nextDay' : 'spend.nextWeek')}
            onClick={() => step(1)}
          >
            <ChevIcon />
          </button>
        </div>

        {!shown && loading && !error && <p className="sheet-meta time-empty">{t('spend.loading')}</p>}
        {error && <p className="access-problem">{t('spend.loadError', { error })}</p>}

        {shown && (lanes.length > 1 || (lane !== null && lanes.length > 0)) && (
          // biome-ignore lint/a11y/useSemanticElements: scrollable chip strip matches TimePanel
          <div className="segmented lane-picks time-chips" role="group" aria-label={t('spend.byLane')} ref={chipsRef}>
            <button type="button" aria-pressed={!lane} onClick={() => setLane(null)}>
              {t('spend.all')}
            </button>
            {lanes.map(l => (
              <button
                type="button"
                key={l.lane}
                aria-pressed={lane === l.lane}
                style={{ '--lane': laneColor(l.lane) } as CSSProperties}
                onClick={() => setLane(was => (was === l.lane ? null : l.lane))}
              >
                <span className="time-dot">{laneTitle(l.lane)}</span>
              </button>
            ))}
          </div>
        )}

        {shown && summaryCounts.total === 0 && <p className="time-empty">{t('spend.empty')}</p>}

        {shown && summaryCounts.total > 0 && (
          <>
            <div className="time-summary" style={lane ? ({ '--lane': laneColor(lane) } as CSSProperties) : undefined}>
              <p className="time-caption">
                {lane && (
                  <>
                    <span className="time-dot">{laneTitle(lane)}</span>
                    {' · '}
                  </>
                )}
                {t('spend.total')}
              </p>
              <p className="time-total">{formatTokens(summaryCounts.total)}</p>
              <p className="time-about">
                {t('spend.in')} {formatTokens(summaryCounts.input)} · {t('spend.out')}{' '}
                {formatTokens(summaryCounts.output)} · {t('spend.cache')}{' '}
                {formatTokens(summaryCounts.cacheRead + summaryCounts.cacheWrite)} ·{' '}
                {t('spend.responses', { n: summaryCounts.responses })}
              </p>
              {!lane && lanes.length > 1 && (
                <div className="time-bar" aria-hidden="true">
                  {lanes
                    .filter(l => l.counts.total > 0)
                    .map(l => (
                      <span
                        key={l.lane}
                        style={{ '--lane': laneColor(l.lane), flexGrow: l.counts.total } as CSSProperties}
                      />
                    ))}
                </div>
              )}
            </div>

            {view === 'week' ? (
              <section className="spend-section">
                <h4 className="spend-heading">{t('spend.byLaneAndDay')}</h4>
                <div className="spend-table-wrap">
                  <table className="spend-table">
                    <thead>
                      <tr>
                        <th scope="col">{t('spend.col.lane')}</th>
                        {activeDayCols.map(d => (
                          <th scope="col" key={d} className="num">
                            <button
                              type="button"
                              className="spend-day-btn"
                              onClick={() => {
                                setDate(d)
                                setView('day')
                              }}
                            >
                              {shortDayHead(d, t.lang)}
                            </button>
                          </th>
                        ))}
                        <th scope="col" className="num">
                          {t('spend.col.total')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLanes.map(l => (
                        <tr key={l.lane}>
                          <th scope="row" style={{ '--lane': laneColor(l.lane) } as CSSProperties}>
                            <button
                              type="button"
                              className="spend-lane-btn"
                              onClick={() => setLane(was => (was === l.lane ? null : l.lane))}
                            >
                              <span className="time-dot">{laneTitle(l.lane)}</span>
                            </button>
                          </th>
                          {activeDayCols.map(d => {
                            const c = l.byDay[d]
                            return (
                              <td key={d} className="num" title={c ? cellTooltip(c, t) : undefined}>
                                {c && c.total > 0 ? formatTokens(c.total) : '-'}
                              </td>
                            )
                          })}
                          <td className="num total-col" title={cellTooltip(l.counts, t)}>
                            {formatTokens(l.counts.total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {filteredLanes.length > 1 && (
                      <tfoot>
                        <tr>
                          <th scope="row">{t('spend.col.total')}</th>
                          {activeDayCols.map(d => {
                            const dayRow = shown.days.find(x => x.day === d)
                            return (
                              <td key={d} className="num" title={dayRow ? cellTooltip(dayRow.counts, t) : undefined}>
                                {dayRow && dayRow.counts.total > 0 ? formatTokens(dayRow.counts.total) : '-'}
                              </td>
                            )
                          })}
                          <td className="num total-col" title={cellTooltip(summaryCounts, t)}>
                            {formatTokens(summaryCounts.total)}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </section>
            ) : (
              <section className="spend-section">
                <h4 className="spend-heading">{t('spend.byLane')}</h4>
                <div className="spend-table-wrap">
                  <table className="spend-table">
                    <thead>
                      <tr>
                        <th scope="col">{t('spend.col.lane')}</th>
                        <th scope="col" className="num">
                          {t('spend.col.in')}
                        </th>
                        <th scope="col" className="num">
                          {t('spend.col.out')}
                        </th>
                        <th scope="col" className="num">
                          {t('spend.col.cache')}
                        </th>
                        <th scope="col" className="num">
                          {t('spend.col.total')}
                        </th>
                        <th scope="col" className="num">
                          {t('spend.col.sessions')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLanes.map(l => (
                        <tr key={l.lane}>
                          <th scope="row" style={{ '--lane': laneColor(l.lane) } as CSSProperties}>
                            <button
                              type="button"
                              className="spend-lane-btn"
                              onClick={() => setLane(was => (was === l.lane ? null : l.lane))}
                            >
                              <span className="time-dot">{laneTitle(l.lane)}</span>
                            </button>
                          </th>
                          <td className="num">{formatTokens(l.counts.input)}</td>
                          <td className="num">{formatTokens(l.counts.output)}</td>
                          <td className="num">{formatTokens(l.counts.cacheRead + l.counts.cacheWrite)}</td>
                          <td className="num total-col" title={cellTooltip(l.counts, t)}>
                            {formatTokens(l.counts.total)}
                          </td>
                          <td className="num">{l.sessions}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {filteredSessions.length > 0 && (
              <section className="spend-section">
                <h4 className="spend-heading">{t('spend.topSessions')}</h4>
                <ul className="spend-sessions">
                  {filteredSessions.map(s => {
                    const live = data?.items.some(i => i.key === s.key)
                    return (
                      <li
                        key={s.key}
                        className="spend-session-row"
                        style={{ '--lane': laneColor(s.lane) } as CSSProperties}
                        title={cellTooltip(s.counts, t)}
                      >
                        <div className="spend-session-main">
                          {live ? (
                            <button
                              type="button"
                              className="spend-session-link"
                              onClick={() => dispatch({ type: 'open', key: s.key })}
                            >
                              <span className="time-dot">{s.name}</span>
                            </button>
                          ) : (
                            <span className="spend-session-name">
                              <span className="time-dot">{s.name}</span>
                            </span>
                          )}
                          {s.agent !== 'claude' && <span className="spend-agent">{s.agent}</span>}
                        </div>
                        <div className="spend-session-nums">
                          <strong>{formatTokens(s.counts.total)}</strong>
                          <span className="spend-session-sub">
                            {t('spend.in')} {formatTokens(s.counts.input)} · {t('spend.out')}{' '}
                            {formatTokens(s.counts.output)} · {t('spend.cache')}{' '}
                            {formatTokens(s.counts.cacheRead + s.counts.cacheWrite)}
                          </span>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            <p className="time-zone">{t('spend.zone', { zone: shown.zone })}</p>
          </>
        )}
      </div>
    </Panel>
  )
}
