// The Time panel's week and month (#241): the figure to bill for the days on show (all clients',
// or the one picked), the time worked and not yet entered under it, the clients' shares as a bar;
// each client's total; then the days. A week is a list of its seven days, each with its billed
// figure, a bar against the week's longest day in its clients' colours, each client's figure and
// its marks. A month is the Calendar's month grid (#329: its weekday heads and day cells, its
// quieter days of other months, today in red), each day with its figure, its bar and a mark, a
// legend under it. A mark says a weekday that went by with no time at all, or billed time not yet
// entered in a client's systems. A tap on any day opens it in the Day view. Every duration in the
// panel's one form; a month's cell lets "7 h" and "30 min" take a line each where it is narrow.
import type { CSSProperties } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import { dayHead, weekdayHeads } from '../../models/calendar.ts'
import { dayTitle, durationText } from '../../models/time.ts'
import {
  dayFigures,
  dayMarks,
  durationParts,
  type Figures,
  spanTotals,
  type TimeSpan,
  tallest,
  when,
} from '../../models/time-span.ts'
import { classNames } from '../class-names.ts'
import { ChevIcon } from '../icons.tsx'

export interface TimeSpanViewProps {
  view: 'week' | 'month'
  /** The days on show: a week's seven, or a month's whole weeks. */
  dates: string[]
  /** A date in the month on show: the month's other days are quieter. */
  date: string
  span: TimeSpan
  client: string | null
  today: string
  weekStart: number
  title(id: string): string
  color(id: string): string
  onDay(date: string): void
}

export function TimeSpanView({
  view,
  dates,
  date,
  span,
  client,
  today,
  weekStart,
  title,
  color,
  onDay,
}: TimeSpanViewProps) {
  const t = useT()
  const lang = t.lang
  const dur = (seconds: number) => durationText(seconds, t)
  const byDate = new Map(span.days.map(d => [d.date, d]))
  const shown = dates.flatMap(d => byDate.get(d) ?? [])
  // a month's figures are its own days', not the days of the months around it its grid shows
  const counted = view === 'month' ? shown.filter(d => d.date.slice(0, 7) === date.slice(0, 7)) : shown
  const total = spanTotals(counted, client)
  const longest = tallest(shown, client)
  const single = client ? (total.clients[0] ?? null) : total.clients.length === 1 ? total.clients[0] : null
  const any = counted.some(d => dayFigures(d, client).clients.length > 0)

  /** What a figure leaves out, said quietly: the time worked where it differs, then the time not entered. */
  const about = (f: Pick<Figures, 'seconds' | 'billedSeconds' | 'notEntered'>) =>
    f.seconds !== f.billedSeconds || f.notEntered > 0 ? (
      <p className="time-about">
        {f.seconds !== f.billedSeconds && t('time.worked', { time: dur(f.seconds) })}
        {f.notEntered > 0 && (
          <span className="time-unentered">
            {f.seconds !== f.billedSeconds ? ' · ' : ''}
            {t('time.notEntered', { time: dur(f.notEntered) })}
          </span>
        )}
      </p>
    ) : null
  /** The clients' shares of a figure as one bar, `width` of the row (a day's against the longest). */
  const bar = (f: Figures, className: string, width?: number) =>
    f.billedSeconds > 0 ? (
      <span
        className={className}
        aria-hidden="true"
        style={width === undefined ? undefined : ({ '--share': width } as CSSProperties)}
      >
        {f.clients
          .filter(c => c.billedSeconds > 0)
          .map(c => (
            <span key={c.client} style={{ '--lane': color(c.client), flexGrow: c.billedSeconds } as CSSProperties} />
          ))}
      </span>
    ) : null
  /** A day as a screen reader says it: its name, its figures, its marks. */
  const dayLabel = (d: string) => {
    const day = byDate.get(d)
    const f = day ? dayFigures(day, client) : null
    const marks = day ? dayMarks(day, today, client) : null
    return [
      dayTitle(d, lang),
      f?.clients.length ? `${t('time.billed')} ${dur(f.billedSeconds)}` : '',
      f && f.seconds !== f.billedSeconds ? t('time.worked', { time: dur(f.seconds) }) : '',
      ...(f && !client && f.clients.length > 1 ? f.clients.map(c => `${title(c.client)} ${dur(c.billedSeconds)}`) : []),
      marks?.notEntered ? t('time.notEntered', { time: dur(marks.notEntered) }) : '',
      marks?.noTime ? t('time.noTime') : '',
    ]
      .filter(Boolean)
      .join(', ')
  }

  return (
    <>
      {any && (
        <div
          className="time-summary"
          style={single ? ({ '--lane': color(single.client) } as CSSProperties) : undefined}
        >
          <p className="time-caption">
            {single && (
              <>
                <span className="time-dot">{title(single.client)}</span>
                {' · '}
              </>
            )}
            {t('time.billed')}
          </p>
          <p className="time-total">{dur(total.billedSeconds)}</p>
          {about(total)}
          {!single && bar(total, 'time-bar')}
        </div>
      )}
      {!any && <p className="time-empty">{t(view === 'week' ? 'time.emptyWeek' : 'time.emptyMonth')}</p>}
      {!single && total.clients.length > 1 && (
        <ul className="time-span-clients">
          {total.clients.map(c => (
            <li key={c.client} className="time-span-client" style={{ '--lane': color(c.client) } as CSSProperties}>
              <span className="time-dot">{title(c.client)}</span>
              <span className="time-client-total">{dur(c.billedSeconds)}</span>
              {about(c)}
            </li>
          ))}
        </ul>
      )}
      {view === 'week' ? (
        <ul className="time-week">
          {dates.map(d => {
            const day = byDate.get(d)
            const f = day ? dayFigures(day, client) : null
            const marks = day ? dayMarks(day, today, client) : { noTime: false, notEntered: 0 }
            const head = dayHead(d, lang)
            const has = !!f && f.clients.length > 0
            return (
              <li key={d}>
                <button
                  type="button"
                  className={classNames('time-week-day', when(d, today), marks.noTime && 'no-time')}
                  aria-label={dayLabel(d)}
                  onClick={() => onDay(d)}
                >
                  <span className="time-wd" aria-hidden="true">
                    <span className="time-wd-name">{head.weekday}</span>
                    <span className="time-wd-num">{head.day}</span>
                  </span>
                  <span className="time-week-main" aria-hidden="true">
                    {has && f && bar(f, 'time-day-bar', f.billedSeconds / longest)}
                    {has && f && !client && (
                      <span className="time-week-clients">
                        {f.clients.map(c => (
                          <span
                            key={c.client}
                            className="time-dot"
                            style={{ '--lane': color(c.client) } as CSSProperties}
                          >
                            {title(c.client)}{' '}
                            <span className="time-week-client-fig">
                              {c.billedSeconds || !c.seconds
                                ? dur(c.billedSeconds)
                                : t('time.worked', { time: dur(c.seconds) })}
                            </span>
                          </span>
                        ))}
                      </span>
                    )}
                    {(marks.noTime || marks.notEntered > 0) && (
                      <span className="time-week-marks">
                        {marks.noTime && <span className="time-flag time-flag-none">{t('time.noTime')}</span>}
                        {marks.notEntered > 0 && (
                          <span className="time-flag time-flag-open">
                            {t('time.notEntered', { time: dur(marks.notEntered) })}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="time-week-figure" aria-hidden="true">
                    {has && f && <strong>{dur(f.billedSeconds)}</strong>}
                    {has && f && f.seconds !== f.billedSeconds && (
                      <span className="time-week-worked">{t('time.worked', { time: dur(f.seconds) })}</span>
                    )}
                  </span>
                  <span className="time-week-chev" aria-hidden="true">
                    <ChevIcon />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <>
          <div className="cal-month time-month" style={{ '--weeks': dates.length / 7 } as CSSProperties}>
            <div className="cal-month-head" aria-hidden="true">
              {weekdayHeads(weekStart, lang).map(w => (
                <span key={w}>{w}</span>
              ))}
            </div>
            <div className="cal-month-days">
              {dates.map(d => {
                const day = byDate.get(d)
                const f = day ? dayFigures(day, client) : null
                const marks = day ? dayMarks(day, today, client) : { noTime: false, notEntered: 0 }
                const has = !!f && f.clients.length > 0
                return (
                  <button
                    type="button"
                    key={d}
                    className={classNames(
                      'cal-month-day',
                      'time-month-day',
                      d.slice(0, 7) !== date.slice(0, 7) && 'other',
                      d === today && 'today',
                      when(d, today),
                      marks.noTime && 'no-time',
                      marks.notEntered > 0 && 'open',
                    )}
                    aria-label={dayLabel(d)}
                    onClick={() => onDay(d)}
                  >
                    <span className="cal-month-dn" aria-hidden="true">
                      {Number(d.slice(8, 10))}
                    </span>
                    {(marks.noTime || marks.notEntered > 0) && <span className="time-month-mark" aria-hidden="true" />}
                    {has && f && (
                      <span className="time-month-fig" aria-hidden="true">
                        {durationParts(f.billedSeconds, t).map(p => (
                          <span key={p}>{p} </span>
                        ))}
                      </span>
                    )}
                    {has && f && bar(f, 'time-day-bar', f.billedSeconds / longest)}
                  </button>
                )
              })}
            </div>
          </div>
          <MonthLegend
            open={shown.some(d => dayMarks(d, today, client).notEntered > 0)}
            none={shown.some(d => dayMarks(d, today, client).noTime)}
          />
        </>
      )}
    </>
  )
}

/** What a month's marks mean, for the ones it shows. */
function MonthLegend({ open, none }: { open: boolean; none: boolean }) {
  const t = useT()
  if (!open && !none) return null
  return (
    <p className="time-legend">
      {open && <span className="time-legend-open">{t('time.legend.notEntered')}</span>}
      {none && <span className="time-legend-none">{t('time.legend.noTime')}</span>}
    </p>
  )
}
