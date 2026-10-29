// The Time panel (#233): one day by client, as it will be billed, read in the order that matters
// (#239). From the top: the day's name with the day before, Today and the day after; the clients
// of that day as the toolbar's lanes control (All, then each in its lane's color); the figure to
// bill, large (the day's, or the one client's on show), the time worked and the rounding under it
// where they differ, each client's share as a bar; then each client with its own figure over its
// billed lines, a line's entries under its name with their times on this browser's clock and the
// description without the case the line is named after (who logged one: its hint, and its editor);
// the non-billable entries apart (worked, never billed), then the held ones (a tag the config
// leaves out); the zone once, at the foot. Where a client's time is entered into its systems
// (#240), each line says per system whether its entries are (all, some, none, or one changed after
// it was), a tap marks or unmarks the whole line there with a toast's Undo, an entry's hint names
// its marks, and the figures say how much billed time is not entered yet. Every duration
// in one form (models/time.ts durationText), as the lanes' totals say it too. Asked when it opens
// (always on today), when the day changes, and again whenever the board's time line says the store
// changed; an answer that comes after a later question is dropped, and a day's figures show only
// under that day's name. While config.json's `time` does not check out, it says so first. On a
// phone (the full-height sheet) a horizontal swipe changes the day: the list follows the finger
// and settles back, or goes to the day it was swiped to; with reduced motion, it only changes.
// Where the board can be changed: a tap on an entry opens it in place (EntryEditor.tsx), held
// against the entry as it was opened (changed elsewhere since: it says so, and Save waits for
// Reload); Delete asks nothing and the toast's Undo (7 s, a newer one replaces it) brings it back;
// "Add entry" under the day's figure, its editor in its place; a line billed over its time offers "Raise to"
// (its last entry lengthened by the gap the board works out), and one billed under it "Trim
// to" (the gap taken from its last entry, then the one before, each kept a minute; offered only
// where that gets there), for a client that wants the entries themselves to add up to the billed
// figure. Each change goes as the owner (POST /api/time) with the revision it read, and the day
// is read again after it; an entry saved on another day says so, with a way there. Not optimistic:
// the figures change when the board says the change is in.
import { type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { errorText, postJson, replyOf } from '../../api/client.ts'
import { useLaneFades } from '../../hooks/useLaneFades.ts'
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
  dayTitle,
  draftOf,
  durationText,
  entryTimes,
  isTimeDay,
  lineLabel,
  type MarkBody,
  type MarkState,
  markPlan,
  markState,
  newDraft,
  notEntered,
  rulesOf,
  ruleText,
  shiftDate,
  swipeDay,
  type TimeDay,
  underLine,
} from '../../models/time.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { nextToastToken } from '../../state/board-ui.ts'
import { ChevIcon, PlusIcon } from '../icons.tsx'
import { Panel } from '../panel/Panel.tsx'
import { EntryEditor } from './EntryEditor.tsx'

/** The board said no: its words are the message. */
class Refused extends Error {}

/** A line's state in a system at a glance, beside the system's name. */
const MARK_GLYPHS: Record<MarkState, string> = { entered: '✓', partly: '◐', not: '○', changed: '!' }

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
  type ClientDay = TimeDay['days'][number]
  type Line = ClientDay['lines'][number]
  // `reload` counts Reloads: the editor starts afresh on each, and only then
  type Open = { id: string; base: Entry; reload: number; draft?: Draft }
  const [editing, setEditing] = useState<Open | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  /**
   * What was typed in an editor that closed without Save or Cancel (another entry tapped, Add entry,
   * the day or the client changed, midnight): back when the same entry (or a new one on the same
   * day) opens again, against the entry as it was then (changed since: it says so).
   */
  const kept = useRef(new Map<string, { base: Entry | null; draft: Draft }>())
  const forget = (id: string) => kept.current.delete(id)
  const keep = (id: string, base: Entry | null, d: Draft, fresh: Draft) => {
    if (JSON.stringify(d) === JSON.stringify(fresh)) forget(id)
    else kept.current.set(id, { base, draft: d })
  }
  const open1 = (to: Open | 'new' | null) => {
    const was = to !== null && to !== 'new' && to.reload === 0 ? kept.current.get(to.id) : undefined
    if (was?.base && to !== null && to !== 'new') to = { ...to, base: was.base, draft: was.draft }
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
      // changed or gone since: the day as it is now first, so the editor can offer Reload at once
      if (own) await ask(shownDate.current)
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
      if (ch.edit) {
        now = await post(ch.edit)
        // saved so far: the editor holds the entry as it now is (a move refused after this is the
        // move's, not a change from elsewhere), its draft as typed
        setEditing(x => (x !== null && x !== 'new' && x.id === base.id ? { ...x, base: now } : x))
        const k = kept.current.get(base.id)
        if (k) kept.current.set(base.id, { ...k, base: now })
      }
      // the move says the revision the edit left
      if (ch.move) now = await post({ op: 'move', id: base.id, rev: now.rev, date: ch.move })
      forget(base.id)
      followed(now)
    })
  const add = (d: Draft) =>
    run(async () => {
      const body = addOf(d)
      if (!body) throw new Error(t('time.edit.badTime'))
      const made = await post(body)
      forget(`new:${shownDate.current}`)
      followed(made)
    })
  const undoToken = useRef(0)
  const remove = (base: Entry) =>
    run(async () => {
      const gone = await post({ op: 'remove', id: base.id, rev: base.rev })
      forget(base.id)
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
  // Raise and Trim are changes of their own: an editor open on another entry stays as it is, and a
  // refusal is a toast (no editor shows it). The board works the gap out from the day as it is now.
  const [raising, setRaising] = useState(false)
  const alignTo = async (op: 'raise' | 'trim', lastId: string, billed: number) => {
    const e = entries.get(lastId)
    if (!e) return
    setRaising(true)
    try {
      // the figure the button said: a line that bills otherwise now is refused, not brought elsewhere
      await post({ op, id: e.id, rev: e.rev, billed })
    } catch (err) {
      toast(said(err), true)
    } finally {
      setRaising(false)
    }
  }
  // A mark or an unmark of a line in a system: a change of its own, as Raise is; its toast's Undo
  // puts the line back as it was (a newer change's toast takes the place of its Undo).
  const [marking, setMarking] = useState(false)
  const markLine = async (list: Entry[], system: { id: string; title: string }) => {
    const plan = markPlan(list, system.id)
    setMarking(true)
    try {
      await post(plan.send as unknown as Record<string, unknown>)
      if (undoToken.current) dispatch({ type: 'toastHide', token: undoToken.current })
      const token = nextToastToken()
      undoToken.current = token
      const back = async (bodies: MarkBody[]) => {
        for (const b of bodies) await post(b as unknown as Record<string, unknown>)
      }
      toast(t(plan.send.op === 'post' ? 'time.mark.posted' : 'time.mark.unposted', { system: system.title }), false, {
        action: { label: t('time.edit.undo'), run: () => void back(plan.undo).catch(err => toast(said(err), true)) },
        ms: UNDO_MS,
        token,
      })
    } catch (err) {
      toast(said(err), true)
    } finally {
      setMarking(false)
    }
  }
  const takers = day?.clients ?? (data?.categories ?? []).map(c => c.id)
  const projectsOf = (c: string): string[] | null => day?.projects?.[c] ?? null
  /** A client's settings as the day said them: its billable default and its systems. */
  const settingsOf = (c: string) => day?.settings?.[c]
  const systemsOf = (c: string) => settingsOf(c)?.systems ?? []
  const billableDefault = (c: string, project: string): boolean => {
    const own = settingsOf(c)
    return own ? own.billable && !own.nonBillable.includes(project) : true
  }
  const clientsForNew = client ? [client] : takers

  const go = (days: number) => setDate(d => shiftDate(d, days))
  // no swipe while an entry is open: a sideways drag in a field would drop the draft
  const swipe = useSwipe(go, editing === null)
  const lang = t.lang
  // the figures under a day's name are that day's: another day's answer, still shown, is not
  const shown = dayFor(day, date)
  const failed = error && error.date === date ? error.text : null
  // another day: whatever was open closes
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a change of day only
  useEffect(() => setEditing(null), [date])
  // another client chosen: the open entry may not be drawn, so it closes (its draft kept)
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a change of client only
  useEffect(() => setEditing(null), [client])
  // an entry open in place that left the day (removed or moved elsewhere) says so as it closes;
  // while a change of this panel's own is under way, the entry leaving is that change
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the day read or the open entry changes
  useEffect(() => {
    if (busy || !shown || editing === null || editing === 'new') return
    if (shown.entries.some(e => e.id === editing.id)) return
    toast(t('time.edit.goneElsewhere'), true)
    forget(editing.id)
    setEditing(null)
  }, [shown, editing, busy])
  const entries = new Map((shown?.entries ?? []).map(e => [e.id, e]))
  const days = (shown?.days ?? []).filter(d => !client || d.client === client)
  const cats = new Map((data?.categories ?? []).map(c => [c.id, c]))
  const title = (id: string) => cats.get(id)?.title ?? id
  const color = (id: string) => cats.get(id)?.color ?? 'var(--label-3)'
  const total = days.reduce((n, d) => n + d.billedSeconds, 0)
  const raw = days.reduce((n, d) => n + d.seconds, 0)
  const dur = (seconds: number) => durationText(seconds, t)
  // one client on show (picked, or the day's only one): the day's figure is that client's, named there
  const single = days.length === 1 ? (days[0] as ClientDay) : null
  /** What a billed figure leaves out, said once and quietly: the time worked where it differs, the rounding. */
  const about = (billed: number, worked: number, lines: Line[]) =>
    [billed !== worked ? t('time.worked', { time: dur(worked) }) : '', ...rulesOf(lines, t)].filter(Boolean).join(' · ')
  /** A client's billed time not entered into its systems yet (none: nothing to enter). */
  const unentered = (d: ClientDay) =>
    notEntered(
      d,
      entries,
      systemsOf(d.client).map(x => x.id),
    )
  /** The line under a figure: what it leaves out, then the billed time still to enter, only when there is some. */
  const aboutLine = (text: string, open: number) =>
    text || open > 0 ? (
      <p className="time-about">
        {text}
        {open > 0 && (
          <span className="time-unentered">
            {text ? ' · ' : ''}
            {t('time.notEntered', { time: dur(open) })}
          </span>
        )}
      </p>
    ) : null
  /** How a line or an entry stands in a system, in words. */
  const markText = (state: MarkState, system: string) => t(`time.mark.${state}`, { system })
  /** A new entry's draft: the one typed on this day and left open (for a client offered), else a fresh one. */
  const newOne = (() => {
    const first = clientsForNew[0] as string
    const fresh = newDraft(first, projectsOf(first)?.[0] ?? '', date)
    // kept by the panel's day, and only when the form offers its client now (under another client's chip
    // it waits, untouched, for the chip that shows it)
    const was = kept.current.get(`new:${date}`)?.draft
    // its key is the panel's day it was typed on; its own date field may say another day
    return { fresh, kept: was && clientsForNew.includes(was.client) ? was : null }
  })()
  /** Who logged an entry: a session the board still has opens on a click. */
  const byOf = (e: Entry) => {
    const key = typeof e.by === 'string' ? null : e.by.key
    return key && data?.items.some(i => i.key === key) ? (
      <button type="button" className="time-session" onClick={() => dispatch({ type: 'open', key })}>
        {byText(e, t)}
      </button>
    ) : (
      byText(e, t)
    )
  }
  /** The editor of an entry as it was opened; `now` is the entry as the day reads it now. */
  const editorFor = ({ base, reload, draft }: Open, now: Entry) => (
    <EntryEditor
      // Reload opens it again on the entry as it is now: a new draft
      key={`${base.id}:${reload}`}
      draft={draft ?? draftOf(base)}
      clientTitle={title}
      projects={projectsOf}
      tags={shown?.tags}
      billableDefault={billableDefault}
      entered={systemsOf(now.client)
        .filter(x => now.posts.some(p => p.system === x.id))
        .map(x => x.title)}
      by={byOf(base)}
      busy={busy}
      error={editError}
      stale={now.rev !== base.rev}
      onReload={() => {
        forget(base.id)
        open1({ id: base.id, base: now, reload: reload + 1 })
      }}
      onSave={d => void save(base, d)}
      onDelete={() => void remove(base)}
      onCancel={() => {
        forget(base.id)
        open1(null)
      }}
      onDraft={d => keep(base.id, base, d, draftOf(base))}
    />
  )
  /**
   * An entry's row: its times, its description under its line's name (`name`), what sets it apart
   * from its line (another project than `project`, tags), and its own duration where the line has
   * more than it (`own`). Who logged it is in its hint, and in the editor a tap opens in place.
   */
  const entryRow = (id: string, name: string, project: string, own: boolean) => {
    const e = entries.get(id)
    if (!e) return null
    if (editing !== null && editing !== 'new' && editing.id === id)
      return (
        <li className="time-editing" key={id}>
          {editorFor(editing, e)}
        </li>
      )
    const note = [e.project !== project ? e.project : '', e.tags.length ? `#${e.tags.join(' #')}` : '']
      .filter(Boolean)
      .join(' · ')
    const row = (
      <>
        <span className="time-when">{entryTimes(e, lang)}</span>
        <span className="time-what">{underLine(e.description, name)}</span>
        {own && <span className="time-dur">{dur(e.seconds)}</span>}
        {note && <span className="time-note">{note}</span>}
      </>
    )
    return (
      <li
        className="time-entry"
        key={id}
        title={[
          `${e.project} · ${byText(e, t)}`,
          ...systemsOf(e.client).flatMap(x => {
            const p = e.posts.find(y => y.system === x.id)
            return p
              ? [`${markText(p.changedAfter ? 'changed' : 'entered', x.title)}${p.record ? ` (${p.record})` : ''}`]
              : []
          }),
        ].join('\n')}
      >
        {canEdit ? (
          <button type="button" className="time-open time-row" onClick={() => open1({ id, base: e, reload: 0 })}>
            {row}
          </button>
        ) : (
          <div className="time-row">{row}</div>
        )}
      </li>
    )
  }
  /**
   * A billed line: its name and project, its figure (from the time worked where rounding moved it),
   * its entries; under them, where it stands in each of the client's systems (a tap marks or unmarks
   * it there) and Raise or Trim to.
   */
  const lineOf = (client: string) => (l: Line) => {
    const name = lineLabel(l, t)
    const listed = l.entries.map(id => entries.get(id)).filter((e): e is Entry => !!e)
    const systems = systemsOf(client)
    const last = l.entries[l.entries.length - 1]
    // what its entries can give, each kept a minute: Trim only where that reaches the billed figure
    const room = l.entries.reduce((n, id) => n + Math.max(0, (entries.get(id)?.seconds ?? 0) - 60), 0)
    const align =
      !canEdit || !last
        ? null
        : l.billedSeconds > l.seconds
          ? ('raise' as const)
          : l.billedSeconds < l.seconds && room >= l.seconds - l.billedSeconds
            ? ('trim' as const)
            : null
    return (
      <div className="time-line" key={l.key}>
        <div className="time-line-head">
          <span className="time-line-name">{name}</span>
          {l.project && l.project !== name && <span className="time-line-project">{l.project}</span>}
          <span className="time-figures" title={ruleText(l, t)}>
            {l.billedSeconds !== l.seconds && <span className="time-raw">{dur(l.seconds)} →</span>}
            <strong>{dur(l.billedSeconds)}</strong>
          </span>
        </div>
        <ul className="time-entries">
          {l.entries.map(id => entryRow(id, l.group === 'day' ? '' : name, l.project, l.entries.length > 1))}
        </ul>
        {(systems.length > 0 || align) && (
          <div className="time-line-foot">
            {systems.map(x => {
              const state = markState(listed, x.id)
              return (
                <button
                  type="button"
                  key={x.id}
                  className="time-mark"
                  data-state={state}
                  aria-pressed={state === 'entered'}
                  // its state in words: the glyph and the colour are not read out
                  aria-label={markText(state, x.title)}
                  title={`${markText(state, x.title)}. ${t(state === 'entered' ? 'time.mark.tapUnpost' : 'time.mark.tapPost', { system: x.title })}`}
                  disabled={!canEdit || busy || marking}
                  onClick={() => void markLine(listed, x)}
                >
                  <span className="time-mark-glyph" aria-hidden="true">
                    {MARK_GLYPHS[state]}
                  </span>
                  {x.title}
                </button>
              )
            })}
            {align && last && (
              <button
                type="button"
                className={align === 'raise' ? 'time-raise' : 'time-raise time-trim'}
                disabled={busy || raising}
                onClick={() => void alignTo(align, last, l.billedSeconds)}
              >
                {t(`time.edit.${align}`, { hours: dur(l.billedSeconds) })}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }
  /** A client's non-billable entries: worked, never billed, apart before the held ones. */
  const unbilledOf = (d: ClientDay) => (
    <div className="time-line time-held time-unbilled">
      <div className="time-line-head">
        <span className="time-line-name">{t('time.nonBillable')}</span>
        <span className="time-figures">
          {dur(d.nonBillable.reduce((n, id) => n + (entries.get(id)?.seconds ?? 0), 0))}
        </span>
      </div>
      <ul className="time-entries">{d.nonBillable.map(id => entryRow(id, '', '', d.nonBillable.length > 1))}</ul>
    </div>
  )
  /** A client's held entries (a tag the config leaves out): apart, quiet, in no total. */
  const heldOf = (d: ClientDay) => (
    <div className="time-line time-held">
      <div className="time-line-head">
        <span className="time-line-name">{t('time.held')}</span>
        <span className="time-line-project">{t('time.heldNote')}</span>
        <span className="time-figures">{dur(d.held.reduce((n, id) => n + (entries.get(id)?.seconds ?? 0), 0))}</span>
      </div>
      <ul className="time-entries">{d.held.map(id => entryRow(id, '', '', d.held.length > 1))}</ul>
    </div>
  )

  return (
    <Panel id="time-sheet" kind="time" open={open} onClose={onClose} title={<h2>{t('time.title')}</h2>}>
      <div className="sheet-body cats-body time-body">
        <div className="time-nav">
          <h3 className="time-date" title={shown ? t('time.zone', { zone: shown.zone }) : undefined}>
            {dayTitle(date, lang)}
          </h3>
          <button
            type="button"
            className="icon-button time-step time-prev"
            title={t('time.prev')}
            aria-label={t('time.prev')}
            onClick={() => go(-1)}
          >
            <ChevIcon />
          </button>
          <button type="button" className="button time-today" disabled={date === today} onClick={() => setDate(today)}>
            {t('time.today')}
          </button>
          <button
            type="button"
            className="icon-button time-step"
            title={t('time.next')}
            aria-label={t('time.next')}
            onClick={() => go(1)}
          >
            <ChevIcon />
          </button>
        </div>
        {shown?.problems && <p className="access-problem">{t('time.problemsNote', { problems: shown.problems })}</p>}
        {!shown && !failed && <p className="sheet-meta time-empty">{t('time.loading')}</p>}
        {failed && <p className="access-problem">{t('time.loadError', { error: failed })}</p>}
        {shown && (shown.days.length > 1 || (client !== null && shown.days.length > 0)) && (
          <Chips>
            <button type="button" aria-pressed={!client} onClick={() => onClient(null)}>
              {t('time.all')}
            </button>
            {shown.days.map(d => (
              <button
                type="button"
                aria-pressed={client === d.client}
                key={d.client}
                style={{ '--lane': color(d.client) }}
                onClick={() => onClient(d.client)}
              >
                {/* the dot on a span of its own: the Terminal style draws a pressed segment's brackets on the button's */}
                <span className="time-dot">{title(d.client)}</span>
              </button>
            ))}
          </Chips>
        )}
        <div className="time-days" {...swipe.handlers} style={swipe.style}>
          {shown && days.length > 0 && (
            <div className="time-summary" style={single ? { '--lane': color(single.client) } : undefined}>
              <p className="time-caption">
                {single && (
                  <>
                    <span className="time-dot">{title(single.client)}</span>
                    {' · '}
                  </>
                )}
                {t('time.billed')}
              </p>
              <p className="time-total">{dur(total)}</p>
              {aboutLine(
                about(total, raw, single?.lines ?? []),
                days.reduce((n, d) => n + unentered(d), 0),
              )}
              {!single && total > 0 && (
                <div className="time-bar" aria-hidden="true">
                  {/* a client that bills nothing (never billed, or all held) has no share */}
                  {days
                    .filter(d => d.billedSeconds > 0)
                    .map(d => (
                      <span key={d.client} style={{ '--lane': color(d.client), flexGrow: d.billedSeconds }} />
                    ))}
                </div>
              )}
            </div>
          )}
          {shown && !days.length && <p className="time-empty">{t('time.empty')}</p>}
          {canEdit && clientsForNew.length > 0 && day && (
            <div className="time-add">
              {editing === 'new' ? (
                <EntryEditor
                  // a new day, a new draft (one typed on this day and left open comes back)
                  key={date}
                  draft={newOne.kept ?? newOne.fresh}
                  clients={clientsForNew}
                  clientTitle={title}
                  projects={projectsOf}
                  tags={shown?.tags}
                  billableDefault={billableDefault}
                  busy={busy}
                  error={editError}
                  onSave={d => void add(d)}
                  onCancel={() => {
                    forget(`new:${date}`)
                    open1(null)
                  }}
                  onDraft={d => keep(`new:${date}`, null, d, newOne.fresh)}
                />
              ) : (
                <button type="button" className="time-add-open" onClick={() => open1('new')}>
                  <PlusIcon />
                  <span>{t('time.edit.add')}</span>
                </button>
              )}
            </div>
          )}
          {days.map(d => (
            <section className="time-client" key={d.client} style={{ '--lane': color(d.client) }}>
              {!single && (
                <header className="time-client-head">
                  <h4 className="time-dot">{title(d.client)}</h4>
                  <span className="time-client-total">{dur(d.billedSeconds)}</span>
                  {aboutLine(about(d.billedSeconds, d.seconds, d.lines), unentered(d))}
                </header>
              )}
              <div className="time-lines">
                {d.lines.map(lineOf(d.client))}
                {d.nonBillable.length > 0 && unbilledOf(d)}
                {d.held.length > 0 && heldOf(d)}
              </div>
            </section>
          ))}
          {shown && days.length > 0 && <p className="time-zone">{t('time.zone', { zone: shown.zone })}</p>}
        </div>
      </div>
    </Panel>
  )
}

/** The clients of the day as the toolbar's lanes control has them, fading out at an edge with more past it. */
function Chips({ children }: { children: ReactNode }) {
  const t = useT()
  const control = useRef<HTMLDivElement>(null)
  useLaneFades(control)
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> keeps its content's width (min-inline-size), so the strip could not scroll
    <div className="segmented lane-picks time-chips" role="group" aria-label={t('time.clients')} ref={control}>
      {children}
    </div>
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
