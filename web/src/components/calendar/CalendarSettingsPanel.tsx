// Settings → Calendar (#328), on this computer's board only (an iCal address is typed here): the
// calendar on or off; the sources, each with its colour mark, label, what it is and how its sync
// stands, opened in place to change its label, colour and lane, or to remove it; a new source in
// one step (a calendar MCP server such as Google Workspace's, a calendar's secret iCal address, or
// a push source an agent fills), tried with Test before it is added. Every change goes to POST
// /api/calendar-settings and the view comes back with its answer. The iCal address goes into a
// file of its own, never config.json; the panel never shows it again, only whether it is set.
import { type CSSProperties, type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react'
import { errorText, postJson, replyOf } from '../../api/client.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { agoText, type CalSourceView, sourceColors, sourceLabel } from '../../models/calendar.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { ChevIcon, PlusIcon, WarnIcon } from '../icons.tsx'
import { Panel } from '../panel/Panel.tsx'

export interface CalendarSettingsPanelProps {
  open: boolean
  onClose(): void
}

interface SettingsView {
  on: boolean
  everyMin: number
  sources: CalSourceView[]
  problems: string | null
}

const isView = (v: unknown): v is SettingsView =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as SettingsView).on === 'boolean' &&
  Array.isArray((v as SettingsView).sources)

type Kind = 'mcp' | 'ics' | 'push'
const KINDS: readonly Kind[] = ['mcp', 'ics', 'push']

interface Draft {
  kind: Kind
  label: string
  lane: string
  color: string
  url: string
  account: string
  calendars: string
  address: string
}

const emptyDraft = (): Draft => ({
  kind: 'mcp',
  label: '',
  lane: '',
  color: '',
  url: '',
  account: '',
  calendars: '',
  address: '',
})

/** A draft's fields as config.json keeps them (empty ones left out). */
function fieldsOf(d: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = { label: d.label.trim() }
  if (d.lane) out.lane = d.lane
  if (d.color) out.color = d.color
  if (d.kind === 'mcp') {
    out.url = d.url.trim()
    out.account = d.account.trim()
    if (d.calendars.trim()) out.calendars = d.calendars
  }
  return out
}

export function CalendarSettingsPanel({ open, onClose }: CalendarSettingsPanelProps) {
  const t = useT()
  const { data, toast, canEdit } = useBoardContext()
  const latest = useLatest({ t })
  const lanes = data?.categories ?? []
  const swatches = data?.swatches ?? []
  const [view, setView] = useState<SettingsView | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ part: string; text: string; ok?: boolean } | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const rev = data?.calendar?.rev ?? ''

  const ask = useCallback(async () => {
    try {
      const res = await fetch('/api/calendar-settings', { cache: 'no-store' })
      const value = await replyOf(res)
      if (res.ok && isView(value)) {
        setView(value)
        setFailed(null)
      } else setFailed(String((value as { error?: unknown }).error ?? res.status))
    } catch (err) {
      setFailed(errorText(err, latest.current.t))
    }
  }, [latest])
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the board's calendar line moves
  useEffect(() => {
    if (open) void ask()
  }, [open, ask, rev])

  const send = async (part: string, body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    setSaid(null)
    try {
      const res = await postJson('/api/calendar-settings', body)
      const reply = (await replyOf(res)) as { ok?: boolean; error?: string; view?: unknown; count?: number }
      if (isView(reply.view)) setView(reply.view)
      if (body.op === 'test') {
        setSaid(
          reply.ok
            ? { part, text: t('cal.set.tested', { n: reply.count ?? 0 }), ok: true }
            : { part, text: reply.error || t('err.status', { code: res.status }) },
        )
        return !!reply.ok
      }
      if (!res.ok || reply.ok === false) {
        setSaid({ part, text: reply.error || t('err.status', { code: res.status }) })
        return false
      }
      return true
    } catch (err) {
      setSaid({ part, text: errorText(err, t) })
      return false
    } finally {
      setBusy(false)
    }
  }
  const off = busy || !canEdit
  const note = (part: string) =>
    said?.part === part ? (
      <p className={classNames('access-hint cal-set-said', !said.ok && 'bad')} role={said.ok ? 'status' : 'alert'}>
        {said.text}
      </p>
    ) : null

  const colors = sourceColors(view?.sources ?? [], lanes)
  const now = Date.now()
  const set = (k: keyof Draft, v: string) => setDraft(d => ({ ...d, [k]: v }))
  const add = async (e: FormEvent) => {
    e.preventDefault()
    const ok = await send('add', {
      op: 'add',
      kind: draft.kind,
      source: fieldsOf(draft),
      ...(draft.kind === 'ics' && { address: draft.address.trim() }),
    })
    if (ok) {
      toast(t('cal.set.added', { label: draft.label.trim() || draft.kind }))
      setDraft(emptyDraft())
      setAdding(false)
    }
  }
  const test = () =>
    void send('add', {
      op: 'test',
      kind: draft.kind,
      source: fieldsOf(draft),
      ...(draft.kind === 'ics' && { address: draft.address.trim() }),
    })

  return (
    <Panel
      id="cal-settings-sheet"
      kind="calendarSettings"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('cal.set.title')}</h2>
          <p className="sheet-meta">{t('cal.set.about')}</p>
        </>
      }
    >
      <div className="sheet-body cats-body cal-set-body">
        {failed && (
          <p className="access-problem" role="alert">
            {failed}
          </p>
        )}
        {!view && !failed && <p className="sheet-meta">{t('cal.loading')}</p>}
        {view && (
          <>
            {view.problems && <p className="access-problem">{view.problems}</p>}
            <section className="time-set-group">
              <label className="time-switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={view.on}
                  aria-checked={view.on}
                  disabled={off}
                  onChange={e => void send('on', { op: 'on', on: e.target.checked })}
                />
                <span>{t('cal.set.on')}</span>
              </label>
              <p className="access-hint">{t(view.on ? 'cal.set.onHint' : 'cal.set.offHint')}</p>
              {note('on')}
            </section>

            <h3 className="access-head">{t('cal.set.sources')}</h3>
            <ul className="time-set-group cal-set-sources">
              {view.sources.map(s => (
                <SourceRow
                  key={s.id}
                  s={s}
                  color={colors.get(s.id) ?? '#8e8e93'}
                  label={sourceLabel(s, lanes, t)}
                  lanes={lanes}
                  swatches={swatches}
                  open={opened === s.id}
                  onToggle={() => setOpened(opened === s.id ? null : s.id)}
                  disabled={off}
                  now={now}
                  send={send}
                  note={note}
                />
              ))}
            </ul>

            {!adding ? (
              <button
                type="button"
                className="time-add-open cal-set-add"
                disabled={off}
                onClick={() => setAdding(true)}
              >
                <PlusIcon />
                {t('cal.set.add')}
              </button>
            ) : (
              <form className="time-set-group cal-set-draft" onSubmit={e => void add(e)}>
                <div className="segmented cal-set-kinds" role="radiogroup" aria-label={t('cal.set.kind')}>
                  {KINDS.map(k => (
                    // biome-ignore lint/a11y/useSemanticElements: a segmented control's segment, as the board's others
                    <button
                      type="button"
                      key={k}
                      role="radio"
                      aria-checked={draft.kind === k}
                      className={classNames(draft.kind === k && 'on')}
                      onClick={() => set('kind', k)}
                    >
                      {t(`cal.set.kind.${k}`)}
                    </button>
                  ))}
                </div>
                <p className="access-hint">{t(`cal.set.kindHint.${draft.kind}`)}</p>
                <label className="time-field">
                  <span>{t('cal.set.label')}</span>
                  <input value={draft.label} maxLength={40} required onChange={e => set('label', e.target.value)} />
                </label>
                {draft.kind === 'mcp' && (
                  <>
                    <label className="time-field">
                      <span>{t('cal.set.url')}</span>
                      <input
                        value={draft.url}
                        inputMode="url"
                        placeholder="http://127.0.0.1:…/mcp"
                        required
                        onChange={e => set('url', e.target.value)}
                      />
                    </label>
                    <label className="time-field">
                      <span>{t('cal.set.account')}</span>
                      <input
                        value={draft.account}
                        type="email"
                        autoComplete="off"
                        required
                        onChange={e => set('account', e.target.value)}
                      />
                    </label>
                    <label className="time-field">
                      <span>{t('cal.set.calendars')}</span>
                      <input
                        value={draft.calendars}
                        placeholder="primary"
                        onChange={e => set('calendars', e.target.value)}
                      />
                    </label>
                  </>
                )}
                {draft.kind === 'ics' && (
                  <label className="time-field">
                    <span>{t('cal.set.address')}</span>
                    <input
                      value={draft.address}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="https://… .ics"
                      required
                      onChange={e => set('address', e.target.value)}
                    />
                  </label>
                )}
                <LookFields
                  lane={draft.lane}
                  color={draft.color}
                  lanes={lanes}
                  swatches={swatches}
                  onLane={v => set('lane', v)}
                  onColor={v => set('color', v)}
                  disabled={off}
                />
                {note('add')}
                <div className="access-actions">
                  <button type="submit" className="button primary" disabled={off}>
                    {t('cal.set.addIt')}
                  </button>
                  {draft.kind !== 'push' && (
                    <button type="button" className="button" disabled={off} onClick={test}>
                      {t('cal.set.test')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => {
                      setAdding(false)
                      setDraft(emptyDraft())
                      setSaid(null)
                    }}
                  >
                    {t('cal.set.cancel')}
                  </button>
                </div>
              </form>
            )}
            <p className="access-hint cal-set-foot">{t('cal.set.agents')}</p>
          </>
        )}
      </div>
    </Panel>
  )
}

/** A source's lane and colour: the lane's colour unless one of its own is picked. */
function LookFields(props: {
  lane: string
  color: string
  lanes: readonly { id: string; title: string; color: string }[]
  swatches: readonly { name: string; hex: string }[]
  onLane(v: string): void
  onColor(v: string): void
  disabled: boolean
}) {
  const t = useT()
  return (
    <div className="time-field-row">
      <label className="time-field">
        <span>{t('cal.set.lane')}</span>
        <select value={props.lane} disabled={props.disabled} onChange={e => props.onLane(e.target.value)}>
          <option value="">{t('cal.set.noLane')}</option>
          {props.lanes.map(l => (
            <option key={l.id} value={l.id}>
              {l.title}
            </option>
          ))}
        </select>
      </label>
      <label className="time-field">
        <span>{t('cal.set.color')}</span>
        <select value={props.color} disabled={props.disabled} onChange={e => props.onColor(e.target.value)}>
          <option value="">{t(props.lane ? 'cal.set.laneColor' : 'cal.set.autoColor')}</option>
          {props.swatches.map(s => (
            <option key={s.name} value={s.hex.toLowerCase()}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

function SourceRow(props: {
  s: CalSourceView
  color: string
  label: string
  lanes: readonly { id: string; title: string; color: string }[]
  swatches: readonly { name: string; hex: string }[]
  open: boolean
  onToggle(): void
  disabled: boolean
  now: number
  send(part: string, body: Record<string, unknown>): Promise<boolean>
  note(part: string): ReactNode
}) {
  const { s, color, label, open, disabled, now, send, note } = props
  const t = useT()
  const [label2, setLabel2] = useState(s.label === s.id ? '' : s.label)
  const [address, setAddress] = useState('')
  const [sure, setSure] = useState(false)
  const what =
    s.kind === 'board'
      ? t('cal.set.what.board', { n: s.count })
      : s.kind === 'mcp'
        ? t('cal.set.what.mcp', { account: s.account ?? '' })
        : s.kind === 'ics'
          ? t(s.address ? 'cal.set.what.ics' : 'cal.set.what.icsNone')
          : t('cal.set.what.push')
  const state =
    s.kind === 'board'
      ? ''
      : s.problems
        ? s.problems
        : s.error
          ? t('cal.failedLine', { when: agoText(s.lastTry, now, t), error: s.error })
          : s.lastOk
            ? `${t('cal.syncedLine', { when: agoText(s.lastOk, now, t) })} · ${t('cal.set.events', { n: s.count })}`
            : t('cal.set.notYet')
  const part = `source:${s.id}`
  return (
    <li className={classNames('cal-set-source', open && 'open')} style={{ '--ev': color } as CSSProperties}>
      <button type="button" className="cal-set-head" aria-expanded={open} onClick={props.onToggle}>
        <span className="cal-mark" />
        <span className="cal-set-name">
          <span className="cal-set-label">{label}</span>
          <small>{what}</small>
          {state && <small className={classNames((s.error || s.problems) && 'bad')}>{state}</small>}
        </span>
        {(s.error || s.problems) && <WarnIcon />}
        <ChevIcon />
      </button>
      {open && (
        <div className="cal-set-body-in">
          <label className="time-field">
            <span>{t('cal.set.label')}</span>
            <input
              value={label2}
              maxLength={40}
              placeholder={label}
              disabled={disabled}
              onChange={e => setLabel2(e.target.value)}
              onBlur={() => {
                if (label2.trim() !== (s.label === s.id ? '' : s.label))
                  void send(part, { op: 'edit', id: s.id, source: { label: label2.trim() || null } })
              }}
            />
          </label>
          <LookFields
            lane={s.lane ?? ''}
            color={s.color ?? ''}
            lanes={props.lanes}
            swatches={props.swatches}
            disabled={disabled}
            onLane={v => void send(part, { op: 'edit', id: s.id, source: { lane: v || null } })}
            onColor={v => void send(part, { op: 'edit', id: s.id, source: { color: v || null } })}
          />
          {s.kind === 'ics' && (
            <form
              className="time-field-row"
              onSubmit={e => {
                e.preventDefault()
                void send(part, { op: 'edit', id: s.id, source: {}, address: address.trim() }).then(
                  ok => ok && setAddress(''),
                )
              }}
            >
              <label className="time-field">
                <span>{t(s.address ? 'cal.set.newAddress' : 'cal.set.address')}</span>
                <input
                  value={address}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                  onChange={e => setAddress(e.target.value)}
                />
              </label>
              <button type="submit" className="button" disabled={disabled || !address.trim()}>
                {t('cal.set.save')}
              </button>
            </form>
          )}
          {note(part)}
          {s.kind !== 'board' && (
            <div className="access-actions">
              {(s.kind === 'mcp' || s.kind === 'ics') && (
                <button
                  type="button"
                  className="button"
                  disabled={disabled}
                  onClick={() => void send(part, { op: 'test', id: s.id })}
                >
                  {t('cal.set.test')}
                </button>
              )}
              {!sure ? (
                <button type="button" className="button" disabled={disabled} onClick={() => setSure(true)}>
                  {t('cal.set.remove')}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="button cal-set-danger"
                    disabled={disabled}
                    onClick={() => void send(part, { op: 'remove', id: s.id })}
                  >
                    {t('cal.set.removeSure')}
                  </button>
                  <button type="button" className="button" onClick={() => setSure(false)}>
                    {t('cal.set.keep')}
                  </button>
                </>
              )}
            </div>
          )}
          {s.kind === 'push' && <p className="access-hint">{t('cal.set.pushHint', { id: s.id })}</p>}
          {s.kind === 'ics' && <p className="access-hint">{t('cal.set.secretHint', { id: s.id })}</p>}
        </div>
      )}
    </li>
  )
}
