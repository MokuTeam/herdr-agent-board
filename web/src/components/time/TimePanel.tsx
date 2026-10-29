// The Time panel (#233): one day by client, as it will be billed. From the top: the day
// with the day before and after and Today; the clients of that day as chips (All, then each with
// its billed hours, in its lane's color); then each client's billed lines, a line's entries under
// it with their times on this browser's clock, the description, the project and who logged it;
// the held entries (a tag the config leaves out) apart; the day's totals. Asked when it opens
// (always on today), when the day changes, and again whenever the board's time line says the store
// changed; an answer that comes after a later question is dropped, and a day's figures show only
// under that day's name. While config.json's `time` does not check out, it says so first. On a
// phone (the full-height sheet) a horizontal swipe changes the day: the list follows the finger
// and settles back, or goes to the day it was swiped to; with reduced motion, it only changes.
// Where the board can be changed: a tap on an entry opens it in place (EntryEditor.tsx), held
// against the entry as it was opened (changed elsewhere since: it says so, and Save waits for
// Reload); Delete asks nothing and the toast's Undo (7 s, a newer one replaces it) brings it back;
// "Add entry" under the day; a line rounded up offers "Raise to" (its last entry lengthened by the
// gap the board works out, for a client that wants the entries themselves to add up to the billed
// figure). Each change goes as the owner (POST /api/time) with the revision it read, and the day
// is read again after it; an entry saved on another day says so, with a way there. Not optimistic:
// the figures change when the board says the change is in.
import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react'
import { errorText, postJson, replyOf } from '../../api/client.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { reducedMotion } from '../../models/spring.ts'
import {
  addOf,
  askedInTurn,
  byText,
  changesOf,
  type Draft,
  dateName,
  dayFor,
  draftOf,
  entryTimes,
  hm,
  hoursText,
  isTimeDay,
  lineLabel,
  newDraft,
  ruleText,
  shiftDate,
  swipeDay,
  type TimeDay,
} from '../../models/time.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { nextToastToken } from '../../state/board-ui.ts'
import { classNames } from '../class-names.ts'
import { Panel } from '../panel/Panel.tsx'
import { EntryEditor } from './EntryEditor.tsx'

/** The board said no: its words are the message. */
class Refused extends Error {}

/** How long a delete's Undo stays: long enough to read it and reach it on a phone. */
const UNDO_MS = 7000

export interface TimePanelProps {
  open: boolean
  onClose(): void
  /** The client the panel opened on (a lane's total); null: all of them. */
  client: string | null
  onClient(client: string | null): void
}

export function TimePanel({ open, onClose, client, onClient }: TimePanelProps) {
  const t = useT()
  const { data, toast, dispatch, canEdit } = useBoardContext()
  const latest = useLatest({ t, toast })
  const today = data?.time?.date ?? localToday()
  const seq = data?.time?.seq ?? 0
  const [date, setDate] = useState(today)
  const [day, setDay] = useState<TimeDay | null>(null)
  const [error, setError] = useState<{ date: string; text: string } | null>(null)
  const turns = useRef(askedInTurn())

  const ask = useCallback(
    async (d: string) => {
      const n = turns.current.ask()
      try {
        const res = await fetch(`/api/time?date=${encodeURIComponent(d)}`, { cache: 'no-store' })
        const value = await replyOf(res)
        if (!turns.current.last(n)) return
        if (res.ok && isTimeDay(value)) {
          setDay(value)
          setError(null)
        } else setError({ date: d, text: String((value as { error?: unknown }).error ?? res.status) })
      } catch (err) {
        if (turns.current.last(n)) setError({ date: d, text: errorText(err, latest.current.t) })
      }
    },
    [latest],
  )

  // Every opening starts on today, whatever day it showed when it closed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening only
  useEffect(() => {
    if (open) setDate(today)
  }, [open])

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

  // the entry open in place, as it was when opened (its `base`, what a save is against and the
  // revision it says), or 'new' for one being added; what is being sent; the board's refusal
  type Entry = TimeDay['entries'][number]
  const [editing, setEditing] = useState<{ id: string; base: Entry } | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const open1 = (to: { id: string; base: Entry } | 'new' | null) => {
    setEditing(to)
    setEditError(null)
  }
  /** A refusal in its own words; anything else (no answer) as the page says it. */
  const said = (err: unknown): string => (err instanceof Refused ? err.message : errorText(err, t))
  const shownDate = useRef(date)
  shownDate.current = date
  /**
   * One change as the owner; the entry after it; the day shown now read again. A refusal throws,
   * in the page's own words where the board's would name a command (changed or removed since).
   */
  const post = async (body: Record<string, unknown>): Promise<Entry> => {
    const res = await postJson('/api/time', body)
    const reply = (await replyOf(res)) as { ok?: boolean; error?: string; code?: string; entry?: Entry }
    if (!res.ok || reply.ok === false || !reply.entry) {
      const own =
        reply.code && ['changedSince', 'removed', 'gone'].includes(reply.code) ? `time.web.${reply.code}` : null
      throw new Refused(own ? t(own) : reply.error || t('err.status', { code: res.status }))
    }
    await ask(shownDate.current)
    return reply.entry
  }
  /** An entry saved on another day than the one shown: said, with a way there. */
  const followed = (e: Entry) => {
    if (e.date === shownDate.current) return
    toast(t('time.edit.movedTo', { date: dateName(e.date, t.lang) }), false, {
      action: { label: t('time.edit.show'), run: () => setDate(e.date) },
      ms: 7000,
    })
  }
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setEditError(null)
    try {
      await fn()
      setEditing(null)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const save = (base: Entry, d: Draft) =>
    run(async () => {
      const ch = changesOf(base, d)
      if (!ch) throw new Error(t('time.edit.badTime'))
      let now: Entry = base
      if (ch.edit) now = await post(ch.edit)
      // the move says the revision the edit left
      if (ch.move) now = await post({ op: 'move', id: base.id, rev: now.rev, date: ch.move })
      followed(now)
    })
  const add = (d: Draft) =>
    run(async () => {
      const body = addOf(d)
      if (!body) throw new Error(t('time.edit.badTime'))
      followed(await post(body))
    })
  const undoToken = useRef(0)
  const remove = (base: Entry) =>
    run(async () => {
      const gone = await post({ op: 'remove', id: base.id, rev: base.rev })
      // long enough to read and reach; a newer delete's Undo takes this one's place
      if (undoToken.current) dispatch({ type: 'toastHide', token: undoToken.current })
      const token = nextToastToken()
      undoToken.current = token
      toast(t('time.edit.removed'), false, {
        action: {
          label: t('time.edit.undo'),
          run: () =>
            void post({ op: 'restore', id: gone.id, rev: gone.rev })
              .then(followed)
              .catch(err => toast(said(err), true)),
        },
        ms: UNDO_MS,
        token,
      })
    })
  // Raise is a change of its own: an editor open on another entry stays as it is, and a refusal
  // is a toast (no editor shows it). The board works the gap out from the day as it is now.
  const [raising, setRaising] = useState(false)
  const raise = async (lastId: string) => {
    const e = entries.get(lastId)
    if (!e) return
    setRaising(true)
    try {
      await post({ op: 'raise', id: e.id, rev: e.rev })
    } catch (err) {
      toast(said(err), true)
    } finally {
      setRaising(false)
    }
  }
  const takers = day?.clients ?? (data?.categories ?? []).map(c => c.id)
  const projectsOf = (c: string): string[] | null => day?.projects?.[c] ?? null
  const clientsForNew = client ? [client] : takers

  const go = (days: number) => setDate(d => shiftDate(d, days))
  // no swipe while an entry is open: a sideways drag in a field would drop the draft
  const swipe = useSwipe(go, editing === null)
  const lang = t.lang
  // the figures under a day's name are that day's: another day's answer, still shown, is not
  const shown = dayFor(day, date)
  const failed = error && error.date === date ? error.text : null
  const entries = new Map((shown?.entries ?? []).map(e => [e.id, e]))
  const days = (shown?.days ?? []).filter(d => !client || d.client === client)
  const cats = new Map((data?.categories ?? []).map(c => [c.id, c]))
  const title = (id: string) => cats.get(id)?.title ?? id
  const color = (id: string) => cats.get(id)?.color ?? 'var(--label-3)'
  const total = days.reduce((n, d) => n + d.billedSeconds, 0)
  const raw = days.reduce((n, d) => n + d.seconds, 0)
  /** The editor of an entry as it was opened; `now` is the entry as the day reads it now. */
  const editorFor = (base: Entry, now: Entry) => (
    <EntryEditor
      // Reload opens it again on the entry as it is now: a new draft
      key={base.rev}
      draft={draftOf(base)}
      clientTitle={title}
      projects={projectsOf}
      busy={busy}
      error={editError}
      stale={now.rev !== base.rev}
      onReload={() => open1({ id: base.id, base: now })}
      onSave={d => void save(base, d)}
      onDelete={() => void remove(base)}
      onCancel={() => open1(null)}
    />
  )

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
        {shown?.problems && <p className="access-problem">{t('time.problemsNote', { problems: shown.problems })}</p>}
        {shown && <p className="sheet-meta time-zone">{t('time.zone', { zone: shown.zone })}</p>}
        {!shown && !failed && <p className="sheet-meta time-empty">{t('time.loading')}</p>}
        {shown && shown.days.length > 0 && (
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
                  shown.days.reduce((n, d) => n + d.billedSeconds, 0),
                  t,
                )}
              </span>
            </button>
            {shown.days.map(d => (
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
        {failed && <p className="access-problem">{t('time.loadError', { error: failed })}</p>}
        <div className="time-days" {...swipe.handlers} style={swipe.style}>
          {shown && !days.length && <p className="sheet-meta time-empty">{t('time.empty')}</p>}
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
                    {canEdit && l.round === 'up' && l.billedSeconds > l.seconds && l.entries.length > 0 && (
                      <button
                        type="button"
                        className="button time-raise"
                        disabled={busy || raising}
                        onClick={() => void raise(l.entries[l.entries.length - 1] as string)}
                      >
                        {t('time.edit.raise', { hours: hoursText(l.billedSeconds, t) })}
                      </button>
                    )}
                  </div>
                  <ul className="time-entries">
                    {l.entries.map(id => {
                      const e = entries.get(id)
                      if (!e) return null
                      if (editing !== null && editing !== 'new' && editing.id === id)
                        return <li key={id}>{editorFor(editing.base, e)}</li>
                      return (
                        <li className={classNames('time-entry', canEdit && 'time-editable')} key={id}>
                          {canEdit ? (
                            <button type="button" className="time-open" onClick={() => open1({ id, base: e })}>
                              <span className="time-when">{entryTimes(e, lang)}</span>
                              <span className="time-what">{e.description}</span>
                            </button>
                          ) : (
                            <>
                              <span className="time-when">{entryTimes(e, lang)}</span>
                              <span className="time-what">{e.description}</span>
                            </>
                          )}
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
                      if (editing !== null && editing !== 'new' && editing.id === id)
                        return <li key={id}>{editorFor(editing.base, e)}</li>
                      return (
                        <li className={classNames('time-entry', canEdit && 'time-editable')} key={id}>
                          {canEdit ? (
                            <button type="button" className="time-open" onClick={() => open1({ id, base: e })}>
                              <span className="time-when">{entryTimes(e, lang)}</span>
                              <span className="time-what">{e.description}</span>
                            </button>
                          ) : (
                            <>
                              <span className="time-when">{entryTimes(e, lang)}</span>
                              <span className="time-what">{e.description}</span>
                            </>
                          )}
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
          {canEdit && clientsForNew.length > 0 && day && (
            <div className="time-add">
              {editing === 'new' ? (
                <EntryEditor
                  // a new day, a new draft
                  key={date}
                  draft={newDraft(clientsForNew[0] as string, projectsOf(clientsForNew[0] as string)?.[0] ?? '', date)}
                  clients={clientsForNew}
                  clientTitle={title}
                  projects={projectsOf}
                  busy={busy}
                  error={editError}
                  onSave={d => void add(d)}
                  onCancel={() => open1(null)}
                />
              ) : (
                <button type="button" className="button" onClick={() => open1('new')}>
                  {t('time.edit.add')}
                </button>
              )}
            </div>
          )}
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
function useSwipe(go: (days: number) => void, on: boolean) {
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
        if (e.pointerType !== 'touch' || !on) return
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

/** Today on this browser's clock, YYYY-MM-DD: only before the board's first answer says its own. */
function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
