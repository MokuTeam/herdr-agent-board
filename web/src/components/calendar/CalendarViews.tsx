// The Calendar panel's views (#328): the hours of a day or a week, the month, the agenda, and an
// event's card. They draw items placed by core/calendar-layout.ts and know nothing of where an
// event came from beyond its colour and label (models/calendar.ts), so other things can go on the
// same grid later (time entries, #241).
//
// Day and week: the days' heads, a strip of bars for what lasts all day (or a day and more), then
// the hours, each day a column whose timed events sit side by side where they overlap; the red line
// is now. Month: six weeks at most, each day with its first events and how many more (a tap opens
// that day). Agenda: two weeks from the day on show, day by day, each event a row. A call with a
// join link has it one tap away on its block or row; a tap anywhere else on an event opens its card.
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
import type { CalEvent } from '../../../../src/core/calendar.ts'
import { bars, clip, columns } from '../../../../src/core/calendar-layout.ts'
import { addDays } from '../../../../src/core/time.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  agendaDay,
  callSoon,
  clockText,
  datesOf,
  dayHead,
  eventTone,
  firstHour,
  hourCycle,
  hourSize,
  hourText,
  isBar,
  joinProvider,
  localDate,
  midnight,
  minuteIn,
  spanOf,
  untilText,
  weekdayHeads,
} from '../../models/calendar.ts'
import {
  type DayShiftNote,
  dayDstShifts,
  type GutterZone,
  gutterRowsFor,
  popoverZoneLines,
} from '../../models/calendar-zones.ts'
import { classNames } from '../class-names.ts'
import { CloseIcon, VideoIcon } from '../icons.tsx'

/** How an event is marked: its source's colour and label. */
export interface Marks {
  color(e: CalEvent): string
  label(e: CalEvent): string
}

/** An event picked: it and where it was on screen, for its card. */
export type Pick = (e: CalEvent, from: HTMLElement) => void

const HOURS = Array.from({ length: 24 }, (_, h) => h)

/** The join link as a button of its own: it opens the call, and the event's card stays shut. */
function JoinButton({ url, compact = false, label }: { url: string; compact?: boolean; label?: string }) {
  const t = useT()
  const provider = joinProvider(url)
  const name = provider ? t('cal.joinVia', { provider }) : t('cal.join')
  return (
    <a
      className={classNames('cal-join', compact && 'compact')}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={name}
      aria-label={label ? `${name}: ${label}` : name}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => e.stopPropagation()}
    >
      <VideoIcon />
      {!compact && <span>{provider || t('cal.join')}</span>}
    </a>
  )
}

/** Enter or Space on an event opens its card, as a tap does. */
const openKeys = (open: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    open()
  }
}

// ------------------------------------------------------------------ day and week

export function TimeGrid({
  days,
  events,
  marks,
  now,
  lang,
  zones,
  primaryZone,
  phone = false,
  onSwapZone,
  onPick,
  onDay,
}: {
  days: string[]
  events: CalEvent[]
  marks: Marks
  now: number
  lang: string
  /** Shown time zones in left-to-right gutter order (primary last); empty or length <= 1 leaves the gutter unchanged. */
  zones?: readonly GutterZone[] | undefined
  /** Primary IANA time zone when multi-zone is active; undefined uses the browser's own clock. */
  primaryZone?: string | undefined
  /** Narrow/phone layout: extra gutter columns fold away while remaining in the event popover. */
  phone?: boolean | undefined
  /** Click a secondary zone header to make it primary without touching any event. */
  onSwapZone?: ((zone: string) => void) | undefined
  onPick: Pick
  /** A day's head tapped: that day on its own. */
  onDay?: (date: string) => void
}) {
  const t = useT()
  const scroller = useRef<HTMLDivElement>(null)
  const cycle = hourCycle()
  const multiZone = (zones?.length ?? 0) > 1
  const shownZones = useMemo(() => {
    if (!multiZone || !zones) return []
    return phone ? zones.filter(z => z.primary) : zones
  }, [multiZone, zones, phone])
  const activePrimary = primaryZone ?? shownZones.find(z => z.primary)?.zone
  const today = localDate(now, activePrimary)
  const timed = events.filter(e => !isBar(e))
  const strip = bars(events.filter(isBar), days, e => datesOf(e, activePrimary))
  const stripRows = strip.reduce((n, b) => Math.max(n, b.row + 1), 0)
  const dstShifts = useMemo(
    () =>
      multiZone && days.length > 1 && activePrimary && zones
        ? dayDstShifts(days, activePrimary, zones)
        : new Map<string, DayShiftNote[]>(),
    [multiZone, days, activePrimary, zones],
  )
  const zoneRows = useMemo(() => {
    if (!multiZone || !activePrimary) return null
    return new Map(shownZones.map(z => [z.zone, gutterRowsFor(days, activePrimary, z.zone, lang, cycle)]))
  }, [multiZone, shownZones, days, activePrimary, lang, cycle])
  // Twelve hours fill the grid's room under its head (#339): an hour grows with the panel, so a tall
  // one still has the day to scroll through. Set on the element before the scroll below reads an
  // hour's height; a resize keeps the hour at the top where it was. The room above and below the
  // lines (their labels') is not the hours'.
  useLayoutEffect(() => {
    const el = scroller.current
    const top = el?.querySelector<HTMLElement>('.cal-top')
    const lines = el?.querySelector<HTMLElement>('.cal-hours')
    if (!el) return
    let hour = 0
    const fit = () => {
      const style = lines ? getComputedStyle(lines) : null
      const around = style
        ? (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
        : 0
      const next = hourSize(el.clientHeight - (top?.offsetHeight ?? 0) - around)
      if (next === hour) return
      const at = hour ? el.scrollTop / hour : null
      hour = next
      el.style.setProperty('--cal-hour', `${next}px`)
      if (at !== null) el.scrollTop = at * next
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(fit)
    watch.observe(el)
    if (top) watch.observe(top)
    return () => watch.disconnect()
  }, [])
  // the hours open at what matters: an hour before now on today, else the first event
  const key = `${days[0]}:${days.length}:${activePrimary ?? ''}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the days or primary zone change, not on every answer
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const hour = el.querySelector<HTMLElement>('.cal-hour-row')?.offsetHeight ?? 44
    el.scrollTop = firstHour(days, timed, Date.now(), activePrimary) * hour
  }, [key])
  const cols = (
    multiZone ? { '--days': days.length, '--gutters': shownZones.length } : { '--days': days.length }
  ) as CSSProperties
  return (
    <div
      className={classNames('cal-grid', multiZone && 'has-zones', multiZone && phone && 'zones-folded')}
      ref={scroller}
    >
      <div className="cal-top">
        <div className="cal-grid-head" style={cols}>
          {multiZone ? (
            <div className="cal-gutter cal-gutter-heads" data-gutters={shownZones.length}>
              {shownZones.map(z => {
                const zoneName = z.zone.replaceAll('_', ' ')
                const tip = z.primary
                  ? t('cal.zone.primary', { label: z.label, zone: zoneName, offset: z.offsetText })
                  : t('cal.zone.swap', { label: z.label, zone: zoneName, offset: z.offsetText })
                const inner = (
                  <>
                    <span className="cal-zone-label">{z.label}</span>
                    <span className="cal-zone-offset">{z.offsetText}</span>
                  </>
                )
                return !z.primary && onSwapZone ? (
                  <button
                    type="button"
                    key={z.zone}
                    className="cal-zone-head cal-zone-swap cal-zone-extra"
                    data-zone={z.zone}
                    title={tip}
                    aria-label={tip}
                    onClick={() => onSwapZone(z.zone)}
                  >
                    {inner}
                  </button>
                ) : (
                  <span
                    key={z.zone}
                    className={classNames('cal-zone-head', z.primary ? 'primary' : 'cal-zone-extra')}
                    data-zone={z.zone}
                    title={tip}
                  >
                    {inner}
                  </span>
                )
              })}
            </div>
          ) : (
            <span className="cal-gutter" />
          )}
          {days.map(d => {
            const h = dayHead(d, lang)
            const shifts = dstShifts.get(d)
            const body = (
              <>
                <span className="cal-wd">{h.weekday}</span>
                <span className="cal-dn">{h.day}</span>
                {shifts && (
                  <span
                    className="cal-dst-note"
                    title={shifts
                      .map(s => t('cal.zone.dstShift', { label: s.label, offset: s.offsetText }))
                      .join(' · ')}
                  >
                    {shifts.map(s => `${s.label} ${s.offsetText.replace(/^UTC/, '') || 'UTC'}`).join(' ')}
                  </span>
                )}
              </>
            )
            return onDay && days.length > 1 ? (
              <button
                type="button"
                key={d}
                className={classNames('cal-day-head', d === today && 'today')}
                onClick={() => onDay(d)}
                aria-label={agendaDay(d, today, lang, t)}
              >
                {body}
              </button>
            ) : (
              <span key={d} className={classNames('cal-day-head', d === today && 'today')}>
                {body}
              </span>
            )
          })}
        </div>
        {stripRows > 0 && (
          <div className="cal-strip" style={{ ...cols, '--rows': stripRows } as CSSProperties}>
            <span className="cal-gutter cal-allday-label">{t('cal.allDay')}</span>
            {strip.map(b => (
              <EventBar
                key={`${b.item.source}/${b.item.id}`}
                e={b.item}
                marks={marks}
                onPick={onPick}
                style={{
                  gridColumn: `${b.from + 2} / ${b.to + 3}`,
                  gridRow: b.row + 1,
                }}
                cut={{ before: b.before, after: b.after }}
              />
            ))}
          </div>
        )}
      </div>
      <div className="cal-hours" style={cols}>
        {multiZone && zoneRows ? (
          <div className="cal-gutter cal-gutter-cols" aria-hidden="true">
            {shownZones.map(z => (
              <div
                key={z.zone}
                className={classNames(
                  'cal-hour-labels',
                  z.primary ? 'primary' : 'cal-zone-extra',
                  z.relativeShift && days.length > 1 && 'shifted',
                )}
                data-zone={z.zone}
              >
                {(zoneRows.get(z.zone) ?? []).map(r => (
                  <div key={r.hour} className={classNames('cal-hour-row', r.midnight && 'midnight')}>
                    {r.text && <span title={r.title || undefined}>{r.text}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="cal-gutter cal-hour-labels" aria-hidden="true">
            {HOURS.map(h => (
              <div key={h} className="cal-hour-row">
                {h > 0 && <span>{hourText(h, lang)}</span>}
              </div>
            ))}
          </div>
        )}
        {days.map(d => {
          const from = midnight(d, activePrimary)
          const to = midnight(addDays(d, 1), activePrimary)
          const placed = columns(
            timed.filter(e => clip(spanOf(e, activePrimary), from, to)),
            e => clip(spanOf(e, activePrimary), from, to) as { start: number; end: number },
          )
          return (
            <div key={d} className={classNames('cal-col', d === today && 'today')}>
              {HOURS.map(h => (
                <div key={h} className="cal-hour-row" />
              ))}
              {placed.map(p => {
                const s = spanOf(p.item, activePrimary)
                const top = p.start <= from ? 0 : minuteIn(p.start, activePrimary)
                const bottom = p.end >= to ? 24 * 60 : Math.max(top + 1, minuteIn(p.end, activePrimary) || 24 * 60)
                return (
                  <EventBlock
                    key={`${p.item.source}/${p.item.id}`}
                    e={p.item}
                    marks={marks}
                    now={now}
                    lang={lang}
                    primaryZone={activePrimary}
                    onPick={onPick}
                    clippedTop={s.start < from}
                    style={
                      {
                        '--top': top,
                        '--len': Math.max(bottom - top, 15),
                        '--col': p.col,
                        '--cols': p.cols,
                        '--span': p.span,
                      } as CSSProperties
                    }
                  />
                )
              })}
              {d === today && (
                <div
                  className="cal-now"
                  style={{ '--top': minuteIn(now, activePrimary) } as CSSProperties}
                  aria-hidden="true"
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function EventBlock({
  e,
  marks,
  now,
  lang,
  primaryZone,
  onPick,
  style,
  clippedTop,
}: {
  e: CalEvent
  marks: Marks
  now: number
  lang: string
  primaryZone?: string | undefined
  onPick: Pick
  style: CSSProperties
  clippedTop: boolean
}) {
  const s = spanOf(e, primaryZone)
  const label = marks.label(e)
  const cycle = hourCycle()
  const time = `${clockText(s.start, lang, cycle, primaryZone)} - ${clockText(s.end, lang, cycle, primaryZone)}`
  const minutes = (s.end - s.start) / 60_000
  const open = (el: HTMLElement) => onPick(e, el)
  return (
    // biome-ignore lint/a11y/useSemanticElements: a button cannot hold the join link, itself a link
    <div
      role="button"
      tabIndex={0}
      className={classNames(
        'cal-event',
        `tone-${eventTone(e)}`,
        minutes <= 30 && 'short',
        Number((style as Record<string, unknown>)['--cols']) > 1 && 'stacked',
        callSoon(e, now) && 'soon',
        s.end <= now && 'past',
        clippedTop && 'cut-top',
      )}
      style={{ ...style, '--ev': marks.color(e) } as CSSProperties}
      data-ev={`${e.source}/${e.id}`}
      title={`${e.title}\n${time} · ${label}`}
      aria-label={`${e.title}, ${time}, ${label}`}
      onClick={(ev: MouseEvent<HTMLDivElement>) => open(ev.currentTarget)}
      onKeyDown={openKeys(() => open(document.activeElement as HTMLElement))}
    >
      <span className="cal-ev-title">{e.title || '…'}</span>
      <span className="cal-ev-meta">
        <span className="cal-ev-time">{minutes <= 30 ? clockText(s.start, lang, cycle, primaryZone) : time}</span>
        <span className="cal-mark-label">{label}</span>
      </span>
      {e.join && s.end > now && <JoinButton url={e.join} compact label={e.title} />}
    </div>
  )
}

function EventBar({
  e,
  marks,
  onPick,
  style,
  cut,
}: {
  e: CalEvent
  marks: Marks
  onPick: Pick
  style: CSSProperties
  cut: { before: boolean; after: boolean }
}) {
  const label = marks.label(e)
  return (
    <button
      type="button"
      className={classNames('cal-bar', `tone-${eventTone(e)}`, cut.before && 'cut-before', cut.after && 'cut-after')}
      style={{ ...style, '--ev': marks.color(e) } as CSSProperties}
      title={`${e.title} · ${label}`}
      onClick={ev => onPick(e, ev.currentTarget)}
    >
      <span className="cal-ev-title">{e.title || '…'}</span>
    </button>
  )
}

// ------------------------------------------------------------------ month

/** How many events a day of the month shows before "+n". */
const MONTH_SHOWN = 3

export function MonthGrid({
  days,
  month,
  events,
  marks,
  now,
  lang,
  weekStart,
  primaryZone,
  onPick,
  onDay,
}: {
  days: string[]
  /** A date in the month on show: the others are quieter. */
  month: string
  events: CalEvent[]
  marks: Marks
  now: number
  lang: string
  weekStart: number
  primaryZone?: string | undefined
  onPick: Pick
  onDay: (date: string) => void
}) {
  const t = useT()
  const cycle = hourCycle()
  const today = localDate(now, primaryZone)
  const byDay = new Map<string, CalEvent[]>()
  for (const e of events) {
    const { first, last } = datesOf(e, primaryZone)
    for (let d = first; d <= last; d = addDays(d, 1)) {
      if (d < (days[0] as string) || d > (days.at(-1) as string)) continue
      byDay.set(d, [...(byDay.get(d) ?? []), e])
    }
  }
  return (
    <div className="cal-month" style={{ '--weeks': days.length / 7 } as CSSProperties}>
      <div className="cal-month-head" aria-hidden="true">
        {weekdayHeads(weekStart, lang).map(w => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="cal-month-days">
        {days.map(d => {
          const list = (byDay.get(d) ?? [])
            .slice()
            .sort(
              (a, b) =>
                Number(isBar(b)) - Number(isBar(a)) || spanOf(a, primaryZone).start - spanOf(b, primaryZone).start,
            )
          const more = list.length - MONTH_SHOWN
          return (
            <div
              key={d}
              className={classNames(
                'cal-month-day',
                d.slice(0, 7) !== month.slice(0, 7) && 'other',
                d === today && 'today',
              )}
            >
              <button
                type="button"
                className="cal-month-dn"
                onClick={() => onDay(d)}
                aria-label={agendaDay(d, today, lang, t)}
              >
                {Number(d.slice(8, 10))}
              </button>
              {list.slice(0, more > 0 ? MONTH_SHOWN - 1 : MONTH_SHOWN).map(e => (
                <button
                  type="button"
                  key={`${e.source}/${e.id}`}
                  className={classNames('cal-month-ev', isBar(e) ? 'cal-whole' : 'cal-timed', `tone-${eventTone(e)}`)}
                  style={{ '--ev': marks.color(e) } as CSSProperties}
                  data-ev={`${e.source}/${e.id}`}
                  title={`${e.title} · ${marks.label(e)}`}
                  onClick={ev => onPick(e, ev.currentTarget)}
                >
                  {!isBar(e) && (
                    <span className="cal-ev-time">
                      {clockText(spanOf(e, primaryZone).start, lang, cycle, primaryZone)}
                    </span>
                  )}
                  <span className="cal-ev-title">{e.title || '…'}</span>
                </button>
              ))}
              {more > 0 && (
                <button type="button" className="cal-month-more" onClick={() => onDay(d)}>
                  {t('cal.more', { n: more + 1 })}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ agenda

export function Agenda({
  days,
  events,
  marks,
  now,
  lang,
  primaryZone,
  onPick,
}: {
  days: string[]
  events: CalEvent[]
  marks: Marks
  now: number
  lang: string
  primaryZone?: string | undefined
  onPick: Pick
}) {
  const t = useT()
  const cycle = hourCycle()
  const today = localDate(now, primaryZone)
  const groups = days
    .map(d => ({
      d,
      list: events.filter(e => {
        const { first, last } = datesOf(e, primaryZone)
        return first <= d && last >= d
      }),
    }))
    .filter(g => g.list.length || g.d === today)
  if (!groups.length) return <p className="cal-empty">{t('cal.noEvents')}</p>
  return (
    <div className="cal-agenda">
      {groups.map(g => (
        <section key={g.d} className={classNames('cal-agenda-day', g.d === today && 'today')}>
          <h4>{agendaDay(g.d, today, lang, t)}</h4>
          {!g.list.length && <p className="cal-empty">{t('cal.nothingToday')}</p>}
          {g.list.length > 0 && (
            <ul>
              {g.list.map(e => {
                const s = spanOf(e, primaryZone)
                const label = marks.label(e)
                const soon = callSoon(e, now)
                const open = (el: HTMLElement) => onPick(e, el)
                return (
                  <li
                    key={`${e.source}/${e.id}`}
                    className={classNames(
                      'cal-row',
                      `tone-${eventTone(e)}`,
                      soon && 'soon',
                      !isBar(e) && s.end <= now && 'past',
                    )}
                    style={{ '--ev': marks.color(e) } as CSSProperties}
                  >
                    {/* biome-ignore lint/a11y/useSemanticElements: the row holds the join link, itself a link */}
                    <div
                      role="button"
                      tabIndex={0}
                      className="cal-row-main"
                      data-ev={`${e.source}/${e.id}`}
                      onClick={ev => open(ev.currentTarget)}
                      onKeyDown={openKeys(() => open(document.activeElement as HTMLElement))}
                    >
                      <span className="cal-row-time">
                        {isBar(e) ? (
                          t('cal.allDay')
                        ) : (
                          <>
                            <span>{clockText(s.start, lang, cycle, primaryZone)}</span>
                            <span className="to">{clockText(s.end, lang, cycle, primaryZone)}</span>
                          </>
                        )}
                      </span>
                      <span className="cal-row-text">
                        <span className="cal-ev-title">{e.title || '…'}</span>
                        <span className="cal-row-meta">
                          <span className="cal-mark-label">{label}</span>
                          {soon && <span className="cal-soon">{untilText(s.start, s.end, now, t)}</span>}
                          {e.location && e.location !== e.join && <span className="cal-place">{e.location}</span>}
                        </span>
                      </span>
                    </div>
                    {e.join && !isBar(e) && s.end > now && <JoinButton url={e.join} label={e.title} />}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ an event's card

/** Where the card goes: beside what was tapped, inside the window. */
export function cardPlace(
  from: { left: number; right: number; top: number; bottom: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  const gap = 8
  const room = { right: view.width - from.right, left: from.left }
  let left: number
  if (room.right >= size.width + gap) left = from.right + gap
  else if (room.left >= size.width + gap) left = from.left - gap - size.width
  else left = Math.min(Math.max(gap, from.left), view.width - size.width - gap)
  const beside = room.right >= size.width + gap || room.left >= size.width + gap
  let top = beside ? from.top : from.bottom + gap
  if (top + size.height > view.height - gap)
    top = beside ? view.height - gap - size.height : from.top - gap - size.height
  return { left: Math.max(gap, left), top: Math.max(gap, top) }
}

export function EventCard({
  e,
  from,
  marks,
  now,
  lang,
  sourceLine,
  zones,
  primaryZone,
  onClose,
}: {
  e: CalEvent
  from: HTMLElement
  marks: Marks
  now: number
  lang: string
  /** How its source's sync stands, in words. */
  sourceLine: string
  /** Shown time zones (#646): when more than one, start and end are shown in every zone. */
  zones?: readonly GutterZone[] | undefined
  primaryZone?: string | undefined
  onClose(): void
}) {
  const t = useT()
  const card = useRef<HTMLDivElement>(null)
  const cycle = hourCycle()
  const multiZone = !e.allDay && (zones?.length ?? 0) > 1
  const activePrimary = primaryZone ?? zones?.find(z => z.primary)?.zone
  const s = spanOf(e, activePrimary)
  useLayoutEffect(() => {
    const el = card.current
    if (!el) return
    const r = from.getBoundingClientRect()
    const p = cardPlace(
      r,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: innerWidth, height: innerHeight },
    )
    el.style.left = `${p.left}px`
    el.style.top = `${p.top}px`
    el.focus({ preventScroll: true })
  }, [from])
  useEffect(() => {
    const away = (ev: PointerEvent) => {
      if (card.current && !card.current.contains(ev.target as Node) && !from.contains(ev.target as Node)) onClose()
    }
    const key = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        onClose()
        from.focus({ preventScroll: true })
      }
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [from, onClose])
  const dateText = new Intl.DateTimeFormat(lang, {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    ...(activePrimary ? { timeZone: activePrimary } : {}),
  }).format(new Date(s.start))
  const when = e.allDay
    ? e.end === addDays(e.start, 1)
      ? `${dateText} · ${t('cal.allDay')}`
      : `${dateText} - ${new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', ...(activePrimary ? { timeZone: activePrimary } : {}) }).format(new Date(midnight(addDays(e.end, -1), activePrimary)))}`
    : multiZone
      ? dateText
      : `${dateText} · ${clockText(s.start, lang, cycle, activePrimary)} - ${clockText(s.end, lang, cycle, activePrimary)}`
  const zoneLines = multiZone && zones ? popoverZoneLines(s.start, s.end, zones, lang, cycle) : []
  const currentZone = activePrimary ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const showSourceZone =
    !e.allDay && e.zone && (multiZone ? !zones?.some(z => z.zone === e.zone) : e.zone !== currentZone)
  const answer =
    e.status === 'cancelled'
      ? t('cal.cancelled')
      : e.response === 'declined'
        ? t('cal.declined')
        : e.response === 'needsAction'
          ? t('cal.notAnswered')
          : e.response === 'tentative' || e.status === 'tentative'
            ? t('cal.tentative')
            : ''
  const live = !e.allDay && s.end > now
  return (
    <div
      className="cal-card"
      ref={card}
      role="dialog"
      aria-label={e.title}
      tabIndex={-1}
      style={{ '--ev': marks.color(e) } as CSSProperties}
    >
      <div className="cal-card-head">
        <span className="cal-chip">
          <span className="cal-mark" />
          {marks.label(e)}
        </span>
        <button type="button" className="icon-button cal-card-close" aria-label={t('cal.close')} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <h3 className={classNames('cal-card-title', eventTone(e) === 'declined' && 'struck')}>{e.title || '…'}</h3>
      <p className="cal-card-when">
        {when}
        {showSourceZone && <span className="cal-card-zone"> · {e.zone}</span>}
      </p>
      {zoneLines.length > 0 && (
        <ul className="cal-card-zones" aria-label={t('cal.set.zones')}>
          {zoneLines.map(line => (
            <li
              key={line.zone}
              className={classNames('cal-card-zone-row', line.primary && 'primary')}
              data-zone={line.zone}
            >
              <span className="cal-card-zone-who">
                <span className="cal-card-zone-label">{line.label}</span>
                <span className="cal-card-zone-off">{line.offsetText}</span>
              </span>
              <span className="cal-card-zone-time">
                {line.timeText}
                {line.dateNote && line.endDateNote && (
                  <span className="cal-card-zone-day">
                    {' '}
                    · {line.dateNote} - {line.endDateNote}
                  </span>
                )}
                {line.dateNote && !line.endDateNote && <span className="cal-card-zone-day"> · {line.dateNote}</span>}
                {!line.dateNote && line.endDateNote && <span className="cal-card-zone-day"> ({line.endDateNote})</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(answer || (live && callSoon(e, now, 60 * 60_000))) && (
        <p className="cal-card-state">
          {[answer, live && callSoon(e, now, 60 * 60_000) ? untilText(s.start, s.end, now, t) : '']
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {e.join && live && <JoinButton url={e.join} label={e.title} />}
      <dl className="cal-card-facts">
        {e.location && e.location !== e.join && (
          <>
            <dt>{t('cal.where')}</dt>
            <dd>{e.location}</dd>
          </>
        )}
        {e.attendees ? (
          <>
            <dt>{t('cal.guests')}</dt>
            <dd>{t('cal.invited', { n: e.attendees })}</dd>
          </>
        ) : null}
        {e.note && (
          <>
            <dt>{t('cal.note')}</dt>
            <dd>{e.note}</dd>
          </>
        )}
        {e.by && (
          <>
            <dt>{t('cal.addedBy')}</dt>
            <dd>{e.by}</dd>
          </>
        )}
      </dl>
      <p className="cal-card-foot">
        <span>{sourceLine}</span>
        {e.link && (
          <a href={e.link} target="_blank" rel="noopener noreferrer">
            {t('cal.openThere')}
          </a>
        )}
      </p>
    </div>
  )
}
