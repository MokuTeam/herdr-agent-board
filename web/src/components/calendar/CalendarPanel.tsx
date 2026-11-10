// The Calendar panel (#328): every account's events in one calendar, beside the kanban in the
// side panels' place (docked or floating, resized like the others). From the top: the arrows and
// Today with the range on show, the views (day, week, month, agenda) as a segmented control; the
// sources as small marks in their colours, a tap hiding or showing one, a failing one marked; then
// the view (components/calendar/CalendarViews.tsx). The head's Sync fetches every source now;
// Settings… opens Settings → Calendar on this computer's board.
//
// Asked when it opens, when the range changes, and again whenever the board's calendar line says
// something changed (a sync, an agent's event); an answer that comes after a later question is
// dropped. The view picked and the sources hidden are this browser's. The current-time line moves
// once a minute. A week on a phone opens as the agenda: seven columns do not fit a hand.
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CalEvent } from '../../../../src/core/calendar.ts'
import { errorText, postJson, replyOf } from '../../api/client.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useMediaQuery } from '../../hooks/useMediaQuery.ts'
import { useMinute } from '../../hooks/useMinute.ts'
import { useSegmentThumb } from '../../hooks/useSegmentThumb.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  agoText,
  CAL_VIEWS,
  type CalAnswer,
  type CalView,
  isCalAnswer,
  isCalView,
  localDate,
  sourceColors,
  sourceLabel,
  stepDate,
  viewDays,
  viewTitle,
  viewWindow,
  weekStartFor,
} from '../../models/calendar.ts'
import { PHONE_QUERY } from '../../models/panel-motion.ts'
import { askedInTurn } from '../../models/time.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { storage } from '../../state/storage.ts'
import { classNames } from '../class-names.ts'
import { ChevIcon, GearIcon, RestartIcon, Turn, WarnIcon } from '../icons.tsx'
import { Panel } from '../panel/Panel.tsx'
import { Agenda, EventCard, type Marks, MonthGrid, TimeGrid } from './CalendarViews.tsx'

const VIEW_KEY = 'board.calendar.view'
const HIDDEN_KEY = 'board.calendar.hidden'

/** An event to show (#335, a reminder's Open): its day on show and its card open; `n` tells asks apart. */
export interface CalendarFocus {
  source: string
  id: string
  start: string
  n: number
}

export interface CalendarPanelProps {
  open: boolean
  /** An event to show as the panel opens, or while it is open. */
  focus?: CalendarFocus | null
  /** The event asked for is on show (its card open), or not to be found in its window: the ask is done. */
  onFocused?: (() => void) | undefined
  onClose(): void
  /** Settings → Calendar, on this computer's board only. */
  onSettings?: (() => void) | undefined
}

export function CalendarPanel({ open, focus = null, onFocused, onClose, onSettings }: CalendarPanelProps) {
  const t = useT()
  const lang = t.lang
  const { data, toast } = useBoardContext()
  const latest = useLatest({ t, toast })
  const phone = useMediaQuery(PHONE_QUERY)
  const now = useMinute(open)
  const rev = data?.calendar?.rev ?? ''
  const lanes = data?.categories ?? []
  // the week starts as the board's language has it (Monday in Russian), else as this browser's locale does
  const weekStart = useMemo(
    () => weekStartFor(lang === 'ru' || typeof navigator === 'undefined' ? lang : navigator.language),
    [lang],
  )
  const [picked, setPicked] = useState<CalView>(() => {
    const v = storage.read(VIEW_KEY)
    return isCalView(v) ? v : 'week'
  })
  const view: CalView = phone && picked === 'week' ? 'agenda' : picked
  const [date, setDate] = useState(() => localDate(Date.now()))
  const [answer, setAnswer] = useState<CalAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const v = JSON.parse(storage.read(HIDDEN_KEY) ?? '[]')
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      return new Set()
    }
  })
  const [card, setCard] = useState<{ e: CalEvent; from: HTMLElement } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const turns = useRef(askedInTurn())
  const win = viewWindow(view, date, weekStart)

  const ask = useCallback(
    async (from: number, to: number) => {
      const n = turns.current.ask()
      try {
        const res = await fetch(`/api/calendar?from=${from}&to=${to}`, { cache: 'no-store' })
        const value = await replyOf(res)
        if (!turns.current.last(n)) return
        if (res.ok && isCalAnswer(value)) {
          setAnswer(value)
          setError(null)
        } else setError(String((value as { error?: unknown }).error ?? res.status))
      } catch (err) {
        if (turns.current.last(n)) setError(errorText(err, latest.current.t))
      }
    },
    [latest],
  )
  // Every opening starts on today, unless it opens for an event (below).
  useEffect(() => {
    if (open) setDate(localDate(Date.now()))
    else setCard(null)
  }, [open])
  // An event asked for: its day on show, and its card once the answer has it on screen.
  const wanted = useRef<CalendarFocus | null>(null)
  useEffect(() => {
    if (!open || !focus) return
    wanted.current = focus
    setCard(null)
    setDate(localDate(Date.parse(focus.start)))
  }, [open, focus])
  const focused = useLatest(onFocused)
  // biome-ignore lint/correctness/useExhaustiveDependencies: looked at again with each answer and each ask
  useEffect(() => {
    const f = wanted.current
    if (!f || !answer) return
    const done = () => {
      wanted.current = null
      focused.current?.()
    }
    const e = answer.events.find(x => x.source === f.source && x.id === f.id)
    const el = e && document.querySelector<HTMLElement>(`[data-ev="${CSS.escape(`${f.source}/${f.id}`)}"]`)
    if (!e || !el) {
      // an answer for its day without it on show (gone, or its source hidden): the ask goes, and a
      // later answer does not pop it open
      const at = Date.parse(f.start)
      if (answer.from <= at && at < answer.to) done()
      return
    }
    el.scrollIntoView({ block: 'nearest' })
    // the card goes where the event rests: once the panel has come in (its place still for a frame)
    let frame = 0
    let last = ''
    let left = 90
    const settle = () => {
      const r = el.getBoundingClientRect()
      const at = `${Math.round(r.left)},${Math.round(r.top)}`
      if (at === last || --left <= 0) {
        done()
        setCard({ e, from: el })
      } else {
        last = at
        frame = requestAnimationFrame(settle)
      }
    }
    frame = requestAnimationFrame(settle)
    return () => cancelAnimationFrame(frame)
  }, [answer, focus])
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the board's calendar changes
  useEffect(() => {
    if (open) void ask(win.from, win.to)
  }, [open, win.from, win.to, rev, ask])

  const pick = (v: CalView) => {
    setPicked(v)
    storage.set(VIEW_KEY, v)
    setCard(null)
  }
  const toggle = (id: string) => {
    const next = new Set(hidden)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setHidden(next)
    storage.set(HIDDEN_KEY, JSON.stringify([...next]))
  }
  const sync = async () => {
    setSyncing(true)
    try {
      const res = await postJson('/api/calendar', { op: 'sync' })
      const reply = (await replyOf(res)) as { results?: { source: string; ok: boolean; error?: string }[] }
      const failed = (reply.results ?? []).filter(r => !r.ok)
      if (!res.ok) toast(t('err.status', { code: res.status }), true)
      else if (failed.length) toast(t('cal.syncFailed', { sources: failed.map(f => f.source).join(', ') }), true)
      // the copies it wrote move the board's calendar line, and the window on show is asked again then
    } catch (err) {
      toast(errorText(err, t), true)
    } finally {
      setSyncing(false)
    }
  }

  const sources = answer?.sources ?? []
  const colors = sourceColors(sources, lanes)
  const marks: Marks = {
    color: e => colors.get(e.source) ?? '#8e8e93',
    label: e =>
      sourceLabel(
        sources.find(s => s.id === e.source),
        lanes,
        t,
      ),
  }
  // while a new window is asked, the last answer stays on show (each view draws only its own days)
  const events = (answer?.events ?? []).filter(e => !hidden.has(e.source))
  const days = viewDays(view, date, weekStart)
  const today = localDate(now)
  const busy = syncing || !!data?.calendar?.busy
  const failing = sources.filter(s => s.error || s.problems)
  const cardSource = card ? sources.find(s => s.id === card.e.source) : undefined
  const sourceLine = cardSource
    ? cardSource.kind === 'board'
      ? t('cal.boardOwn')
      : cardSource.error
        ? t('cal.failedLine', { when: agoText(cardSource.lastTry, now, t), error: cardSource.error })
        : t('cal.syncedLine', { when: agoText(cardSource.lastOk, now, t) })
    : ''

  // the views' control: a segmented one, its thumb under the view on show
  const control = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  useSegmentThumb(control, thumb, view, `${lang}:${phone}`)

  return (
    <Panel
      id="cal-sheet"
      kind="calendar"
      measure="full"
      open={open}
      onClose={onClose}
      title={<h2>{t('cal.title')}</h2>}
      tools={
        <>
          <button
            type="button"
            className={classNames('icon-button cal-sync', busy && 'busy')}
            title={t('cal.syncHint')}
            aria-label={t('cal.sync')}
            disabled={busy}
            onClick={() => void sync()}
          >
            <Turn spinning={busy}>
              <RestartIcon />
            </Turn>
          </button>
          {onSettings && (
            <button
              type="button"
              className="icon-button"
              title={t('cal.settings')}
              aria-label={t('cal.settings')}
              onClick={onSettings}
            >
              <GearIcon />
            </button>
          )}
        </>
      }
    >
      <div className={classNames('sheet-body cal-body', `view-${view}`)}>
        <div className="cal-nav">
          <div className="cal-steps">
            <button
              type="button"
              className="icon-button cal-step cal-prev"
              aria-label={t('cal.prev')}
              onClick={() => setDate(stepDate(view, date, -1))}
            >
              <ChevIcon />
            </button>
            <button
              type="button"
              className="pill-toggle cal-today"
              disabled={days.includes(today) && (view !== 'agenda' || date === today)}
              onClick={() => setDate(today)}
            >
              {t('cal.today')}
            </button>
            <button
              type="button"
              className="icon-button cal-step cal-next"
              aria-label={t('cal.next')}
              onClick={() => setDate(stepDate(view, date, 1))}
            >
              <ChevIcon />
            </button>
          </div>
          <h3 className="cal-range" aria-live="polite">
            {viewTitle(view, date, weekStart, lang)}
          </h3>
          <div className="segmented cal-views" role="tablist" aria-label={t('cal.views')} ref={control}>
            <span className="thumb" ref={thumb} />
            {CAL_VIEWS.filter(v => !(phone && v === 'week')).map(v => (
              <button type="button" key={v} role="tab" data-id={v} aria-selected={v === view} onClick={() => pick(v)}>
                {t(`cal.view.${v}`)}
              </button>
            ))}
          </div>
        </div>
        {sources.length > 0 && (
          // biome-ignore lint/a11y/useSemanticElements: a <fieldset> keeps its content's width (min-inline-size), as the lanes strip's
          <div className="cal-sources" role="group" aria-label={t('cal.sources')}>
            {sources.map(s => {
              const off = hidden.has(s.id)
              const bad = !!(s.error || s.problems)
              const label = sourceLabel(s, lanes, t)
              return (
                <button
                  type="button"
                  key={s.id}
                  className={classNames('cal-source', off && 'off', bad && 'bad')}
                  style={{ '--ev': colors.get(s.id) } as CSSProperties}
                  aria-pressed={!off}
                  title={
                    s.problems
                      ? s.problems
                      : s.kind === 'board'
                        ? t('cal.boardOwn')
                        : s.error
                          ? t('cal.failedLine', { when: agoText(s.lastTry, now, t), error: s.error })
                          : t('cal.syncedLine', { when: agoText(s.lastOk, now, t) })
                  }
                  onClick={() => toggle(s.id)}
                >
                  <span className="cal-mark" />
                  {label}
                  {bad && <WarnIcon />}
                </button>
              )
            })}
          </div>
        )}
        {error && <p className="cal-error">{error}</p>}
        {!answer && !error && <p className="cal-empty">{t('cal.loading')}</p>}
        {answer && failing.length > 0 && failing.length === sources.filter(s => s.kind !== 'board').length && (
          <p className="cal-error">{t('cal.allFailing')}</p>
        )}
        {answer &&
          (view === 'agenda' ? (
            <Agenda
              days={days}
              events={events}
              marks={marks}
              now={now}
              lang={lang}
              onPick={(e, from) => setCard({ e, from })}
            />
          ) : view === 'month' ? (
            <MonthGrid
              days={days}
              month={date}
              events={events}
              marks={marks}
              now={now}
              lang={lang}
              weekStart={weekStart}
              onPick={(e, from) => setCard({ e, from })}
              onDay={d => {
                setDate(d)
                pick('day')
              }}
            />
          ) : (
            <TimeGrid
              days={days}
              events={events}
              marks={marks}
              now={now}
              lang={lang}
              onPick={(e, from) => setCard({ e, from })}
              onDay={d => {
                setDate(d)
                pick('day')
              }}
            />
          ))}
      </div>
      {card &&
        createPortal(
          <EventCard
            e={card.e}
            from={card.from}
            marks={marks}
            now={now}
            lang={lang}
            sourceLine={sourceLine}
            onClose={() => setCard(null)}
          />,
          document.body,
        )}
    </Panel>
  )
}
